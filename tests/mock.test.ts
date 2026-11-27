import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockClient, mockEnabled, withLatency } from "../src/llm/mock";
import { getPrompt } from "../src/data/repo";
import { ocTools } from "../src/tools/oc";
import { Session, type SessionEnv } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";
import { collect } from "./helpers";

test("modo simulado: solo con MOCK_LLM=1 y host local (o ENV=dev)", () => {
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "http://localhost:8787/api/health"), true);
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "http://127.0.0.1:8787/api/health"), true);
  assert.equal(mockEnabled({ MOCK_LLM: "1", ENV: "dev" }, "https://staging.example.com/api/health"), true);
});

test("modo simulado: se rechaza fuera de local o sin MOCK_LLM=1", () => {
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "https://agente-oc.example.workers.dev/api/chat"), false);
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "https://localhost.evil.com/api/chat"), false);
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "https://evil.com/?h=localhost"), false);
  assert.equal(mockEnabled({ MOCK_LLM: "1", ENV: "production" }, "https://example.com/"), false);
  assert.equal(mockEnabled({ MOCK_LLM: "0" }, "http://localhost:8787/"), false);
  assert.equal(mockEnabled({}, "http://localhost:8787/"), false);
  assert.equal(mockEnabled({ ENV: "dev" }, "http://localhost:8787/"), false);
  assert.equal(mockEnabled({ MOCK_LLM: "1" }, "no-es-url"), false);
});

function mockSession() {
  const env: SessionEnv = {
    makeClient: () => createMockClient(),
    systemPrompt: getPrompt(),
    tools: ocTools,
    fecha: () => "2026-01-15",
    now: () => "2026-01-15T00:00:00.000Z",
    log: () => {},
  };
  return new Session("s", new SessionStore(new MemoryKV()), env);
}

test("cliente simulado: sol-000 llega a pending_confirmation y al aprobar crea la OC", { timeout: 20000 }, async () => {
  const s = mockSession();
  const { events } = await collect((on) => s.chat("Procesa la solicitud sol-000", on));
  assert.deepEqual(events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name), ["leer_solicitud", "validar_controles", "crear_orden_compra"]);
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  const r = await collect((on) => s.confirm(pc.pending.pendingId, "aprobar", undefined, on));
  const txt = r.events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text).join(" ");
  assert.match(txt, /4500000001/);
});

test("cliente simulado: sol-00X queda bloqueada en el preflight, sin pendiente", { timeout: 20000 }, async () => {
  const s = mockSession();
  const { events } = await collect((on) => s.chat("Procesa la solicitud sol-00X", on));
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
  const txt = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text).join(" ");
  assert.match(txt, /C1/);
  assert.match(txt, /Bloqueada por controles/);
});

const names = (events: Array<{ type: string }>) => events.filter((e) => e.type === "tool_call").map((e) => (e as unknown as { name: string }).name);
const said = (events: Array<{ type: string }>) => events.filter((e) => e.type === "assistant_text").map((e) => (e as unknown as { text: string }).text).join("\n");

test("cliente simulado: con una FALLA bloqueante NO llama a crear_orden_compra; explica una vez y se detiene", { timeout: 20000 }, async () => {
  const s = mockSession();
  const { events } = await collect((on) => s.chat("Procesa la solicitud sol-00X", on));
  assert.deepEqual(names(events), ["leer_solicitud", "validar_controles"]);
  const texts = events.filter((e) => e.type === "assistant_text");
  assert.equal(texts.length, 3); // anuncio, "documentos leidos" y UN resumen final
  const txt = said(events);
  assert.equal((txt.match(/C1/g) ?? []).length, 1, "el motivo no se repite");
  assert.doesNotMatch(txt, /Solicito crear/);
  assert.match(txt, /Estado final: \*\*Bloqueada por controles\*\*/);
});

test("cliente simulado: duplicado (C0) -> Bloqueada por controles, sin crear ni pedir aprobacion", { timeout: 30000 }, async () => {
  const s = mockSession();
  const first = await collect((on) => s.chat("Procesa la solicitud sol-000", on));
  const pc = first.events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  await s.confirm(pc.pending.pendingId, "aprobar");
  const { events } = await collect((on) => s.chat("Procesa la solicitud sol-000", on));
  assert.deepEqual(names(events), ["leer_solicitud", "validar_controles"]);
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
  const txt = said(events);
  assert.match(txt, /4500000001/);
  assert.match(txt, /Bloqueada por controles/);
  assert.doesNotMatch(txt, /OC creada/);
});

test("cliente simulado: rechazo -> 'Rechazada por el aprobador' con el motivo", { timeout: 20000 }, async () => {
  const s = mockSession();
  const { events } = await collect((on) => s.chat("Procesa la solicitud sol-000", on));
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  const r = await collect((on) => s.confirm(pc.pending.pendingId, "rechazar", "Falta el visto bueno de finanzas", on));
  const txt = said(r.events);
  assert.match(txt, /Rechazada por el aprobador/);
  assert.match(txt, /Falta el visto bueno de finanzas/);
  assert.doesNotMatch(txt, /pendiente/i);
});

test("cliente simulado: '¿Qué controles fallaron en sol-00X?' responde sin leer, crear ni pedir aprobacion", { timeout: 20000 }, async () => {
  const s = mockSession();
  const { events } = await collect((on) => s.chat("¿Qué controles fallaron en sol-00X?", on));
  assert.deepEqual(names(events), ["validar_controles"]);
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
  const txt = said(events);
  assert.match(txt, /C1/);
  assert.match(txt, /no crea ni cambia nada/);
  assert.doesNotMatch(txt, /Estado final/);
});

test("cliente simulado: mensaje generico -> respuesta corta; withLatency conserva las tools", async () => {
  const { events } = await collect((on) => mockSession().chat("hola", on));
  assert.ok(events.some((e) => e.type === "assistant_text"));
  assert.equal(withLatency(ocTools).length, ocTools.length);
});
