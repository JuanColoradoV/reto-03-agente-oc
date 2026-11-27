// API del Worker (src/api.ts) con entorno falso: cabeceras de seguridad, Retry-After, limite de mensaje y motivo de rechazo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, SECURITY_HEADERS, type Env } from "../src/api";
import { CAPS } from "../src/agent/state";
import { createMockClient } from "../src/llm/mock";
import { getPrompt } from "../src/data/repo";
import { buildSessionApp } from "../src/session/routes";
import { Session, SessionError, type SessionEnv } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";
import { ocTools } from "../src/tools/oc";
import { collect } from "./helpers";

const env = {
  MOCK_LLM: "1",
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) },
  SESSIONS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ events: [] }), { headers: { "content-type": "application/json" } }) }) },
} as unknown as Env;
const post = (path: string, body: unknown, ip: string) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": ip } }, env);
const SID = "11111111-1111-4111-8111-111111111111";

test("cabeceras de seguridad en API, errores y respaldo de assets", async () => {
  for (const [path, status] of [["/api/health", 200], ["/api/nope", 404], ["/index.html", 200]] as const) {
    const res = await app.request(path, {}, env);
    assert.equal(res.status, status);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, `${path}: ${k}`);
  }
  const h = (await app.request("/api/health", {}, env)).headers;
  assert.match(h.get("content-security-policy")!, /default-src 'self'/);
  assert.match(h.get("content-security-policy")!, /frame-ancestors 'self'/);
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "no-referrer");
});

test("mensaje mas largo que el tope: error que indica el limite (una sola fuente: CAPS.MENSAJE_CHARS)", async () => {
  const res = await post("/api/chat", { sessionId: SID, mensaje: "x".repeat(CAPS.MENSAJE_CHARS + 1) }, "10.0.0.1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "peticion_invalida");
  assert.match(body.error.message, new RegExp(String(CAPS.MENSAJE_CHARS)));
  const health = (await (await app.request("/api/health", {}, env)).json()) as { limits: { mensajeChars: number } };
  assert.equal(health.limits.mensajeChars, CAPS.MENSAJE_CHARS);
});

test("la API rechaza rechazar sin motivo (400, motivo_requerido) y acepta con motivo", async () => {
  const sessionEnv: SessionEnv = { makeClient: () => createMockClient(), systemPrompt: getPrompt(), tools: ocTools, fecha: () => "2026-01-15", now: () => "2026-01-15T00:00:00.000Z", log: () => {} };
  const session = new Session("s", new SessionStore(new MemoryKV()), sessionEnv);
  const { events } = await collect((on) => session.chat("Procesa la solicitud sol-000", on));
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  const pendingId = pc.pending.pendingId;
  await assert.rejects(() => session.confirm(pendingId, "rechazar"), (e: unknown) => e instanceof SessionError && e.code === "motivo_requerido" && e.status === 400);
  const api = buildSessionApp(() => session);
  const send = (comentario?: string) => api.request("/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pendingId, decision: "rechazar", ...(comentario !== undefined ? { comentario } : {}) }) });
  for (const c of [undefined, "", "   "]) {
    const res = await send(c);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "motivo_requerido");
  }
  assert.ok((await session.snapshot()).pending, "el pendiente sigue intacto tras los intentos sin motivo");
  const ok = await send("No corresponde");
  assert.equal(ok.status, 200);
  await ok.text();
  assert.equal((await session.snapshot()).pending, null);
});

// Va al final: agota el cubo de 20 POST/min de su IP.
test("429: Retry-After 60 y mensaje 'Espera 1 minuto'", async () => {
  let last: Response | undefined;
  for (let i = 0; i < CAPS_RATE + 1; i++) last = await post("/api/chat", {}, "10.9.9.9");
  assert.equal(last!.status, 429);
  assert.equal(last!.headers.get("retry-after"), "60");
  const body = (await last!.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "rate_limit");
  assert.match(body.error.message, /Espera 1 minuto/);
  assert.equal(last!.headers.get("x-content-type-options"), "nosniff");
});
const CAPS_RATE = 20;
