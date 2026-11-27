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
  assert.match(txt, /rechazada por controles/);
});

test("cliente simulado: mensaje generico -> respuesta corta; withLatency conserva las tools", async () => {
  const { events } = await collect((on) => mockSession().chat("hola", on));
  assert.ok(events.some((e) => e.type === "assistant_text"));
  assert.equal(withLatency(ocTools).length, ocTools.length);
});
