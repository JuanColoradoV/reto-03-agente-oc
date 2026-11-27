import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../src/agent/loop";
import { collect, fakeMessage, makeSession, quiet, text, toolUse } from "./helpers";

const danglingIn = (messages: Array<{ role: string; content: unknown }>) => {
  const open = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; id?: string; tool_use_id?: string }>) {
      if (b.type === "tool_use" && b.id) open.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) open.delete(b.tool_use_id);
    }
  }
  return [...open];
};

test("max_tokens con tool_use: reintenta una vez con mas tokens y sigue si ahora cabe", async () => {
  const { session, calls } = makeSession([
    fakeMessage([toolUse("tu_1", "listar_solicitudes", {})], "max_tokens"),
    fakeMessage([toolUse("tu_2", "listar_solicitudes", {})], "tool_use"),
    fakeMessage([text("Hay 2 solicitudes.")], "end_turn"),
  ]);
  const { result } = await collect((on) => session.chat("lista", on));
  assert.equal((result as { status: string }).status, "done");
  assert.equal(calls[0]!.max_tokens, LIMITS.MAX_TOKENS);
  assert.equal(LIMITS.MAX_TOKENS, 8192);
  assert.equal(calls[1]!.max_tokens, LIMITS.MAX_TOKENS_RETRY);
});

test("max_tokens con tool_use persistente: descarta el turno, avisa y no deja tool_use colgado", async () => {
  const { session, store, calls } = makeSession([
    fakeMessage([toolUse("tu_1", "listar_solicitudes", {})], "max_tokens"),
    fakeMessage([toolUse("tu_1b", "listar_solicitudes", {})], "max_tokens"),
    fakeMessage([text("Segundo intento ok")], "end_turn"),
  ]);
  const { events } = await collect((on) => session.chat("lista", on));
  assert.equal(calls.length, 2);
  assert.ok(events.some((e) => e.type === "notice" && e.level === "warn"));
  const st = await store.load();
  assert.deepEqual(danglingIn(st.messages), []);
  assert.deepEqual(st.messages.map((m) => m.role), ["user"]); // el turno truncado se descarto
  // La conversacion sigue siendo usable.
  await session.chat("de nuevo");
  assert.deepEqual(danglingIn((await store.load()).messages), []);
});

test("iteraciones agotadas: la ultima llamada va sin herramientas (tool_choice none) para resumir", async () => {
  const script = Array.from({ length: LIMITS.MAX_ITERATIONS - 1 }, (_, i) => fakeMessage([toolUse(`tu_${i}`, "listar_solicitudes", {})], "tool_use"));
  script.push(fakeMessage([text("Resumen final.")], "end_turn"));
  const { session, calls } = makeSession(script);
  const { events } = await collect((on) => session.chat("lista sin parar", on));
  assert.equal(calls.length, LIMITS.MAX_ITERATIONS);
  assert.deepEqual(calls[LIMITS.MAX_ITERATIONS - 1]!.tool_choice, { type: "none" });
  assert.ok(events.some((e) => e.type === "assistant_text" && e.text === "Resumen final."));
});

test("stop_reason refusal / pause_turn / desconocido: aviso en espanol, sin romper la sesion", async () => {
  for (const sr of ["refusal", "pause_turn", "model_context_window_exceeded", "algo_nuevo"]) {
    const { session, store } = makeSession([fakeMessage([text("...")], sr as never)]);
    const { events } = await collect((on) => session.chat("hola", on));
    assert.ok(events.some((e) => e.type === "notice"), sr);
    assert.deepEqual(danglingIn((await store.load()).messages), [], sr);
  }
});

test("si el modelo falla DESPUES de ejecutar una tool, el resultado queda guardado y el turno siguiente continua", async () => {
  const { session, store, calls } = makeSession([
    fakeMessage([toolUse("tu_1", "listar_solicitudes", {})], "tool_use"),
    new Error("boom: 529 overloaded"),
    fakeMessage([text("Retomado.")], "end_turn"),
  ]);
  const { events, result } = await quiet(() => collect((on) => session.chat("lista", on)));
  assert.equal((result as { status: string }).status, "error");
  assert.ok(events.some((e) => e.type === "tool_result" && e.ok));
  const notice = events.find((e) => e.type === "notice" && e.level === "error");
  assert.ok(notice && notice.type === "notice");
  assert.match(notice.text, /ref: [0-9a-f]{8}/);
  assert.doesNotMatch(notice.text, /boom|529/); // sin detalles internos al cliente
  const st = await store.load();
  assert.equal(st.messages.at(-1)?.role, "user"); // tool_result persistido
  assert.deepEqual(danglingIn(st.messages), []);
  assert.ok(st.trace.some((t) => t.status === "error"));

  await session.chat("continua");
  assert.deepEqual(danglingIn(calls[2]!.messages as never), []);
});

test("historial interrumpido (tool_use sin resultado ni pendiente) se sanea antes de llamar al modelo", async () => {
  const { session, store, calls } = makeSession([fakeMessage([text("ok")], "end_turn")]);
  await store.save({
    ...(await store.load()),
    messages: [
      { role: "user", content: "hola" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_x", name: "listar_solicitudes", input: {} }] },
    ],
  });
  await session.chat("sigamos");
  assert.deepEqual(danglingIn(calls[0]!.messages as never), []);
});

test("telemetria: uso, costo estimado y traza por turno", async () => {
  const { session, store } = makeSession([fakeMessage([text("Hola")], "end_turn", 1000)]);
  const { events } = await collect((on) => session.chat("hola", on));
  const u = events.find((e) => e.type === "usage");
  assert.ok(u && u.type === "usage");
  assert.equal(u.usage.output, 1000);
  assert.ok(u.usage.costUsd > 0);
  const tr = (await store.load()).trace;
  assert.equal(tr.length, 1);
  assert.equal(tr[0]?.usage.traceId, u.usage.traceId);
});

test("cache_control en el ultimo bloque del ultimo mensaje y en system/tools", async () => {
  const { session, calls } = makeSession([fakeMessage([text("Hola")], "end_turn")]);
  await session.chat("hola");
  const c = calls[0]!;
  const last = c.messages.at(-1)!.content as Array<{ cache_control?: unknown }>;
  assert.deepEqual(last.at(-1)?.cache_control, { type: "ephemeral" });
  assert.ok((c.system as Array<{ cache_control?: unknown }>)[0]?.cache_control);
  assert.ok((c.tools as Array<{ cache_control?: unknown }>).at(-1)?.cache_control);
});
