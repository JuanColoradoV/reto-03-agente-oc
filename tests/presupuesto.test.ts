// Cortacircuitos global de costo: contador diario, 503 amable en la API y suma del costo de cada turno.
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, type Env } from "../src/api";
import { BudgetLedger, DEFAULT_DAILY_BUDGET_USD, MSG_PRESUPUESTO, parseBudget } from "../src/budget/ledger";
import { MemoryKV } from "../src/session/storage";
import { fakeMessage, makeSession, text } from "./helpers";

test("ledger: acumula, respeta el tope y se reinicia al cambiar de dia", async () => {
  let dia = "2026-01-15";
  const l = new BudgetLedger(new MemoryKV(), () => dia);
  assert.equal((await l.consultar(1)).permitido, true);
  await l.sumar(0.4);
  await l.sumar(0.4);
  assert.equal((await l.consultar(1)).permitido, true);
  await l.sumar(0.3);
  const e = await l.consultar(1);
  assert.equal(e.permitido, false);
  assert.ok(Math.abs(e.usd - 1.1) < 1e-9);
  await l.sumar(-5); // importes invalidos no restan ni rompen
  await l.sumar(Number.NaN);
  assert.ok(Math.abs((await l.estado()).usd - 1.1) < 1e-9);
  dia = "2026-01-16";
  assert.deepEqual(await l.consultar(1), { permitido: true, usd: 0, tope: 1, day: "2026-01-16" });
});

test("parseBudget: valor valido o el defecto (nunca 'sin tope' por una variable mal escrita)", () => {
  assert.equal(parseBudget("12.5"), 12.5);
  for (const v of [undefined, "", "  ", "abc", "0", "-3", "Infinity"]) assert.equal(parseBudget(v), DEFAULT_DAILY_BUDGET_USD, String(v));
});

/** Espacio de nombres falso del DO de presupuesto (RPC), respaldado por el ledger real. */
function fakeBudget(ledger: BudgetLedger, opts: { falla?: boolean } = {}) {
  const peticiones: string[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      consultar: async (tope: number) => {
        peticiones.push("consultar");
        if (opts.falla) throw new Error("DO caido");
        return ledger.consultar(tope);
      },
      sumar: async (usd: number) => {
        peticiones.push("sumar");
        if (opts.falla) throw new Error("DO caido");
        return ledger.sumar(usd);
      },
    }),
  };
  return { ns, peticiones };
}

function entorno(extra: Partial<Record<string, unknown>>) {
  const reenviadas: string[] = [];
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
    ASSETS: { fetch: async () => new Response("") },
    SESSIONS: { idFromName: (n: string) => n, get: () => ({ fetch: async (url: string) => (reenviadas.push(new URL(url).pathname), new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })) }) },
    ...extra,
  } as unknown as Env;
  return { env, reenviadas };
}
const chat = (env: Env, ip: string) =>
  app.request("/api/chat", { method: "POST", body: JSON.stringify({ sessionId: "11111111-1111-4111-8111-111111111111", mensaje: "hola" }), headers: { "content-type": "application/json", "cf-connecting-ip": ip } }, env);

test("API: con el presupuesto agotado /api/chat responde 503 amable y NO llega a la sesion; bajo el tope pasa", async () => {
  const ledger = new BudgetLedger(new MemoryKV(), () => "2026-01-15");
  const b = fakeBudget(ledger);
  const { env, reenviadas } = entorno({ BUDGET: b.ns, DAILY_BUDGET_USD: "1" });
  assert.equal((await chat(env, "20.0.0.1")).status, 200);
  assert.deepEqual(reenviadas, ["/chat"]);
  await ledger.sumar(1.2); // otras sesiones ya gastaron el tope del dia
  const res = await chat(env, "20.0.0.2");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "presupuesto_diario");
  assert.equal(body.error.message, MSG_PRESUPUESTO);
  assert.match(body.error.message, /límite diario de la demo/);
  assert.ok(res.headers.get("retry-after"));
  assert.deepEqual(reenviadas, ["/chat"], "la peticion bloqueada no se reenvio a ninguna sesion");
});

test("API: el modo simulado no consulta el presupuesto; si el contador falla se deja pasar (y se registra)", async () => {
  const ledger = new BudgetLedger(new MemoryKV(), () => "2026-01-15");
  await ledger.sumar(99);
  const b = fakeBudget(ledger);
  const mock = entorno({ BUDGET: b.ns, DAILY_BUDGET_USD: "1", MOCK_LLM: "1", ANTHROPIC_API_KEY: undefined });
  assert.equal((await chat(mock.env, "20.0.0.3")).status, 200);
  assert.equal(b.peticiones.length, 0);

  const roto = fakeBudget(ledger, { falla: true });
  const { env } = entorno({ BUDGET: roto.ns, DAILY_BUDGET_USD: "1" });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await chat(env, "20.0.0.4")).status, 200);
  } finally {
    console.error = orig;
  }
});

test("cada turno suma su costo estimado al presupuesto global (onSpend)", async () => {
  const gastos: number[] = [];
  const { session } = makeSession([fakeMessage([text("Hola")], "end_turn", 1000), fakeMessage([text("Otra")], "end_turn", 1000)], undefined, "s-gasto", { onSpend: (usd) => void gastos.push(usd) });
  await session.chat("uno");
  await session.chat("dos");
  assert.equal(gastos.length, 2);
  assert.ok(gastos.every((g) => g > 0));
  const total = (await session.costo()).costoUsd;
  assert.ok(Math.abs(gastos[0]! + gastos[1]! - total) < 1e-12);
});

test("un fallo en onSpend no rompe el turno", async () => {
  const { session } = makeSession([fakeMessage([text("Hola")], "end_turn")], undefined, "s-gasto2", { onSpend: () => { throw new Error("DO caido"); } });
  const r = (await session.chat("uno")) as { status: string };
  assert.equal(r.status, "done");
});
