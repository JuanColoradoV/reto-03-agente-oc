import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_POR_DEFECTO } from "../src/agent/config";
import { app, type Env } from "../src/api";
import { MockAdapter } from "../src/llm/mock";
import { buildSessionApp } from "../src/session/routes";
import { Session } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";

// Namespace de DO falso: una Session real por id, sobre memoria.
function entorno(extra: Partial<Env> = {}): Env {
  const apps = new Map<string, ReturnType<typeof buildSessionApp>>();
  const get = (id: string) => {
    if (!apps.has(id)) apps.set(id, buildSessionApp(() => session));
    const session = new Session(id, new SessionStore(new MemoryKV()), { makeLlm: () => new MockAdapter(), systemPrompt: "s", config: CONFIG_POR_DEFECTO, now: () => "2026-09-01T15:00:00.000Z", log: () => {} });
    return apps.get(id)!;
  };
  const cache = new Map<string, ReturnType<typeof buildSessionApp>>();
  const SESSIONS = {
    idFromName: (n: string) => n,
    get: (id: string) => ({ fetch: (url: string, init?: RequestInit) => { if (!cache.has(id)) cache.set(id, get(id)); return cache.get(id)!.fetch(new Request(url, init)); } }),
  } as unknown as DurableObjectNamespace;
  return { SESSIONS, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher, MOCK_LLM: "1", ...extra };
}
const llamar = (env: Env, path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init, env);
const ID = "11111111-1111-4111-8111-111111111111";

test("GET /api/health: { ok, provider, model } sin claves", async () => {
  const r = await llamar(entorno({ ANTHROPIC_API_KEY: "sk-ant-api03-secretsecretsecretsecret" }), "/api/health");
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j.ok, true);
  assert.equal(j.provider, "mock");
  assert.ok(j.model);
  assert.ok(!JSON.stringify(j).includes("secret"));
});

test("POST /api/chat (message o mensaje), GET /api/sessions/:id y /out: flujo completo con descarga", async () => {
  const env = entorno();
  const post = await llamar(env, "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: ID, message: "Procesa la solicitud sol-001" }) });
  assert.equal(post.status, 200);
  assert.match(await post.text(), /4500000001/);
  const estado = (await (await llamar(env, `/api/sessions/${ID}`)).json()) as { events: unknown[] };
  assert.ok(estado.events.length > 5);
  assert.deepEqual(await (await llamar(env, `/api/sesion/${ID}`)).json(), estado);
  const out = (await (await llamar(env, `/api/sessions/${ID}/out`)).json()) as { archivos: { ruta: string }[] };
  assert.ok(out.archivos.some((f) => f.ruta === "control.csv"));
  const csv = await llamar(env, `/api/sessions/${ID}/out/control.csv`);
  assert.match(csv.headers.get("content-type")!, /csv/);
  assert.match(await csv.text(), /SOL-2026-001,creada,4500000001/);
  const pdf = await llamar(env, `/api/sessions/${ID}/out/sol-001/aprobacion.pdf`);
  assert.equal(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5)), "%PDF-");
});

test("validación: id de sesión inválido, ruta fuera de out/, cuerpo inválido y origen ajeno", async () => {
  const env = entorno();
  assert.equal((await llamar(env, "/api/sessions/no-es-uuid/out")).status, 400);
  assert.equal((await llamar(env, `/api/sessions/${ID}/out/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await llamar(env, `/api/sessions/${ID}/out/inexistente.txt`)).status, 404);
  assert.equal((await llamar(env, "/api/chat", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await llamar(env, "/api/chat", { method: "POST", headers: { origin: "http://evil.com", "content-type": "application/json" }, body: "{}" })).status, 403);
});
