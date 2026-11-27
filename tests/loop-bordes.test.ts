// Bordes del bucle del agente: max_tokens razonando, tool_use vacio, contexto desbordado, solo-resumen tras decidir,
// presupuesto de llamadas reales y lease del turno frente a llamadas lentas.
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeClient, collect, fakeMessage, makeSession, quiet, text, toolUse } from "./helpers";
import { LIMITS } from "../src/agent/loop";

const thinking = (): Anthropic.ContentBlock => ({ type: "thinking", thinking: "pensando...", signature: "sig" }) as unknown as Anthropic.ContentBlock;
const crear = (id: string, solicitudId = "sol-000") => fakeMessage([toolUse(id, "crear_orden_compra", { solicitudId })], "tool_use");
const listar = (id = "t") => fakeMessage([toolUse(id, "listar_solicitudes", {})], "tool_use");
const notices = (events: { type: string; text?: string }[]) => events.filter((e) => e.type === "notice").map((e) => e.text ?? "");

test("max_tokens con solo razonamiento: se reintenta UNA vez con mas margen y se obtiene respuesta", async () => {
  const { session, calls } = makeSession([fakeMessage([thinking()], "max_tokens", LIMITS.MAX_TOKENS), fakeMessage([text("Listo.")], "end_turn")]);
  const { events } = await collect((on) => session.chat("hola", on));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.max_tokens, LIMITS.MAX_TOKENS);
  assert.equal(calls[1]!.max_tokens, LIMITS.MAX_TOKENS_RETRY);
  assert.ok(events.some((e) => e.type === "assistant_text" && e.text === "Listo."));
  const trace = await session.trace();
  assert.equal(trace[0]!.iterations, 2, "iterations cuenta llamadas reales (reintento incluido), no se duplica la cuenta");
});

test("max_tokens razonando que sigue cortado tras el reintento: aviso claro, sin historial roto, y la sesion sigue", async () => {
  const cortado = () => fakeMessage([thinking()], "max_tokens", LIMITS.MAX_TOKENS);
  const { session, calls, store } = makeSession([cortado(), fakeMessage([thinking()], "max_tokens", LIMITS.MAX_TOKENS_RETRY), fakeMessage([text("Ahora si.")], "end_turn")]);
  const { events } = await collect((on) => session.chat("hola", on));
  assert.ok(notices(events).some((t) => /razonando/.test(t)));
  assert.equal(calls.length, 2);
  await session.chat("otra vez");
  const st = await store.load();
  assert.ok(st.messages.every((m) => (typeof m.content === "string" ? m.content.length > 0 : m.content.length > 0)), "ningun mensaje vacio en el historial");
});

test("stop_reason tool_use sin ningun bloque tool_use: no se guarda un mensaje user vacio y la sesion sigue funcionando", async () => {
  const { session, calls, store } = makeSession([fakeMessage([text("voy a llamar una herramienta")], "tool_use"), fakeMessage([text("Hola")], "end_turn")]);
  const { events } = await collect((on) => session.chat("hola", on));
  assert.ok(notices(events).some((t) => /no envió ninguna llamada/.test(t)));
  const st = await store.load();
  assert.ok(st.messages.every((m) => typeof m.content === "string" || m.content.length > 0));
  await session.chat("sigamos");
  const ultima = calls.at(-1)!;
  assert.ok(ultima.messages.every((m) => typeof m.content === "string" || m.content.length > 0), "la siguiente llamada a la API no lleva mensajes vacios (daria 400)");
});

test("tool_use con input vacio {} en una herramienta con campos obligatorios: error de validacion al modelo, sin pendiente ni OC", async () => {
  const { session, calls, store } = makeSession([fakeMessage([toolUse("t1", "crear_orden_compra", {})], "tool_use"), fakeMessage([text("Me falto el id.")], "end_turn")]);
  const { events, result } = await collect((on) => session.chat("Procesa", on));
  assert.equal((result as { status: string }).status, "done");
  assert.equal((await store.load()).pending, null);
  assert.equal((await store.load()).sap.ordenes.length, 0);
  const tr = events.find((e) => e.type === "tool_result");
  assert.ok(tr && tr.type === "tool_result" && !tr.ok && /Entrada inválida/.test(String(tr.output)));
  const bloque = (calls[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean }>)[0]!;
  assert.equal(bloque.is_error, true);
});

test("contexto desbordado: el mensaje del turno se descarta del historial (la conversacion no queda rota) y se avisa", async () => {
  const { session, store, calls } = makeSession([fakeMessage([text("Hola")], "end_turn"), fakeMessage([], "model_context_window_exceeded" as never), fakeMessage([text("Sigo aqui")], "end_turn")]);
  await session.chat("primero");
  const antes = (await store.load()).messages.length;
  const { events } = await collect((on) => session.chat("mensaje enorme", on));
  assert.ok(notices(events).some((t) => /excedió la ventana de contexto: tu último mensaje se descartó/.test(t)));
  const st = await store.load();
  assert.equal(st.messages.length, antes, "el historial vuelve al estado previo");
  assert.ok(!JSON.stringify(st.messages).includes("mensaje enorme"));
  await session.chat("otro");
  assert.ok(!JSON.stringify(calls.at(-1)!.messages).includes("mensaje enorme"));
});

test("tras decidir solo se redacta el resumen: tool_choice none; si el modelo insiste en herramientas, no se ejecuta nada (aprobar y rechazar)", async () => {
  for (const decision of ["aprobar", "rechazar"] as const) {
    // Tras la decision el modelo (p. ej. influido por texto inyectado en un documento) intenta crear OTRA OC.
    const { session, store, calls } = makeSession([crear("tu_1"), crear("tu_x", "sol-00X")]);
    const { events } = await collect((on) => session.chat("Procesa sol-000", on));
    const pc = events.find((e) => e.type === "pending_confirmation");
    assert.ok(pc && pc.type === "pending_confirmation");
    const r = await collect((on) => session.confirm(pc.pending.pendingId, decision, "motivo", on));
    const post = calls[1]!;
    assert.deepEqual(post.tool_choice, { type: "none" }, decision);
    assert.ok(post.tools && post.tools.length > 0, "las definiciones siguen presentes (cache del prefijo)");
    assert.equal(r.events.filter((e) => e.type === "pending_confirmation").length, 0, "no aparece una segunda tarjeta");
    assert.ok(notices(r.events).some((t) => /intentó usar herramientas al resumir/.test(t)));
    const st = await store.load();
    assert.equal(st.pending, null);
    assert.equal(st.sap.ordenes.length, decision === "aprobar" ? 1 : 0, "solo la OC aprobada; ninguna otra");
  }
});

test("presupuesto de llamadas reales: con reintentos por max_tokens nunca se superan MAX_ITERATIONS y la ultima va sin herramientas", async () => {
  const script: Anthropic.Message[] = [];
  for (let i = 0; i < 12; i++) script.push(fakeMessage([thinking()], "max_tokens", 100), listar(`t${i}`));
  const { session, calls } = makeSession(script);
  const { events } = await collect((on) => session.chat("lista todo", on));
  assert.equal(calls.length, LIMITS.MAX_ITERATIONS);
  assert.deepEqual(calls.at(-1)!.tool_choice, { type: "none" });
  assert.ok(notices(events).some((t) => /máximo de iteraciones/.test(t)));
  assert.equal((await session.trace())[0]!.iterations, LIMITS.MAX_ITERATIONS);
});

test("lease: se renueva mientras una llamada al modelo dura mas que el lease (otro isolate no puede tomar la sesion)", async () => {
  const fake = fakeClient([fakeMessage([text("Hola")], "end_turn")]);
  const lento: typeof fake.client = { messages: { create: async (p, o) => { await new Promise((r) => setTimeout(r, 400)); return fake.client.messages.create(p, o); } } };
  const { session, store } = makeSession([], undefined, "s-lease", { leaseMs: 120, makeClient: () => lento });
  const p = session.chat("hola");
  await new Promise((r) => setTimeout(r, 300)); // mas del doble del lease, con la llamada aun en curso
  assert.ok((await store.getLease()) > Date.now(), "el lease sigue vigente aunque la llamada supere leaseMs");
  await p;
  assert.equal(await store.getLease(), 0, "al terminar se libera");
});

test("tope del turno: una llamada que empieza con el turno agotado se rechaza (no retiene la sesion)", async () => {
  const { session, store } = makeSession([fakeMessage([text("x")], "end_turn")], undefined, "s-tt", {});
  // turnTimeoutMs ya vencido: runTurn lo captura como error del turno y libera la sesion.
  (session as unknown as { env: { turnTimeoutMs?: number } }).env.turnTimeoutMs = -1;
  const { events, result } = await quiet(() => collect((on) => session.chat("hola", on)));
  assert.equal((result as { status: string }).status, "error");
  assert.ok(notices(events).some((t) => /No se pudo completar/.test(t)));
  assert.equal(await store.getLease(), 0);
  await quiet(() => session.chat("de nuevo")); // la sesion queda libre (falla igual por el tope, pero no por estar ocupada)
});
