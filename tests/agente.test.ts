import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_POR_DEFECTO, configDesdeEnv, type ConfigCiclo } from "../src/agent/config";
import { esConfirmacion } from "../src/agent/efectos";
import type { UiEvent } from "../src/agent/estado";
import { ErrorLlm, type LlmAdapter, type Mensaje, type Respuesta } from "../src/llm/adapter";
import { AnthropicAdapter, clasificarError } from "../src/llm/anthropic";
import { MockAdapter } from "../src/llm/mock";
import { Session } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";

const uso = { entrada: 100, salida: 10, cacheLeida: 0, cacheEscrita: 0 };

function sesion(llm: LlmAdapter, config: Partial<ConfigCiclo> = {}) {
  const store = new SessionStore(new MemoryKV());
  const s = new Session("sid", store, { makeLlm: () => llm, systemPrompt: "sys", config: { ...CONFIG_POR_DEFECTO, ...config }, now: () => "2026-09-01T15:00:00.000Z", log: () => {} });
  return { s, store };
}
const eventos = () => {
  const ev: UiEvent[] = [];
  return { ev, on: (e: UiEvent) => void ev.push(e) };
};
const nombres = (ev: UiEvent[]) => ev.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name);

test("confirmación escrita: solo «confirmo» al inicio y corta", () => {
  for (const t of ["confirmo", "Sí, confirmo", "si confirmo la creación", "Confirmo la creación de la OC de sol-004."]) assert.ok(esConfirmacion(t), t);
  for (const t of ["no confirmo", "no, no confirmo", "¿qué es confirmo?", "confirmo " + "x".repeat(200), "procesa sol-004 y confirmo"]) assert.ok(!esConfirmacion(t), t);
});

test("config: valores por defecto (25 iteraciones) y override por env; inválidos se ignoran", () => {
  assert.equal(configDesdeEnv({}).iterMax, 25);
  assert.deepEqual([configDesdeEnv({ ITER_MAX: "3", TOKENS_SESION_MAX: "99", LLM_TIMEOUT_MS: "10" }).iterMax, configDesdeEnv({ TOKENS_SESION_MAX: "99" }).tokensSesionMax], [3, 99]);
  assert.equal(configDesdeEnv({ ITER_MAX: "abc" }).iterMax, 25);
});

test("O1/CA3 con el flujo simulado: sol-001 crea sin confirmación humana", async () => {
  const { s } = sesion(new MockAdapter());
  const { ev, on } = eventos();
  await s.chat("Procesa la solicitud sol-001", on);
  assert.deepEqual(nombres(ev), ["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear"]);
  assert.match(JSON.stringify(ev.find((e) => e.type === "tool_result" && e.name === "oc_crear")), /4500000001/);
  assert.equal((await s.snapshot()).pending, null);
});

test("CA3: sol-004 termina con pregunta y tarjeta; no crea hasta «confirmo»; luego crea con confirmado_por", async () => {
  const { s, store } = sesion(new MockAdapter());
  const a = eventos();
  await s.chat("Procesa la solicitud sol-004. No la crees hasta que yo lo confirme.", a.on);
  assert.ok(!nombres(a.ev).includes("oc_crear"));
  const card = a.ev.filter((e) => e.type === "pending_confirmation").pop() as Extract<UiEvent, { type: "pending_confirmation" }>;
  assert.deepEqual(card.pending.confirmaciones.map((c) => c.codigo), ["RC5"]);
  assert.ok(card.pending.payload);
  assert.equal((await s.snapshot()).pending?.caso, "sol-004");
  const b = eventos();
  await s.chat("Confirmo la creación de la OC.", b.on);
  assert.deepEqual(nombres(b.ev), ["oc_crear"]);
  assert.equal((await s.snapshot()).pending, null);
  const ordenes = (await store.outStore().leer("sap/ordenes.jsonl"))!;
  assert.match(ordenes, /"confirmado_por":"usuario \(chat\)"/);
  assert.ok((await s.archivos()).some((f) => f.ruta === "sol-004/aprobacion.pdf"));
});

test("un modelo que manda confirmado=true sin que el usuario confirme NO crea la OC", async () => {
  let paso = 0;
  const tramposo: LlmAdapter = {
    proveedor: "test", modelo: "t",
    async enviar(): Promise<Respuesta> {
      paso++;
      if (paso === 1) return { texto: "", llamadas: [{ id: "a", nombre: "oc_crear", args: { caso: "sol-005", confirmado: true } }], fin: "herramientas", uso };
      return { texto: "listo", llamadas: [], fin: "fin", uso };
    },
  };
  const { s, store } = sesion(tramposo);
  const { ev, on } = eventos();
  await s.chat("procesa sol-005", on);
  assert.match(JSON.stringify(ev.find((e) => e.type === "tool_result")), /confirmaciones pendientes/);
  assert.equal(await store.outStore().leer("sap/ordenes.jsonl"), null);
  assert.equal((await s.snapshot()).pending?.caso, "sol-005");
});

test("CA1: tope de iteraciones configurable; la última llamada va sin herramientas", async () => {
  const sinHerr: boolean[] = [];
  const bucle: LlmAdapter = {
    proveedor: "test", modelo: "t",
    async enviar(_m: Mensaje[], _h, o): Promise<Respuesta> {
      sinHerr.push(o?.sinHerramientas === true);
      if (o?.sinHerramientas) return { texto: "resumen parcial", llamadas: [], fin: "fin", uso };
      return { texto: "", llamadas: [{ id: `t${sinHerr.length}`, nombre: "oc_leer_paquete", args: { caso: "sol-001" } }], fin: "herramientas", uso };
    },
  };
  const { s } = sesion(bucle, { iterMax: 4 });
  const { ev, on } = eventos();
  const r = await s.chat("x", on);
  assert.equal(sinHerr.length, 4);
  assert.deepEqual(sinHerr, [false, false, false, true]);
  assert.equal(nombres(ev).length, 3);
  assert.equal(r.status, "done");
});

test("CA5: timeout y errores del proveedor se muestran en claro y la sesión sigue viva", async () => {
  let falla: ErrorLlm | null = new ErrorLlm("timeout", "x");
  const llm: LlmAdapter = { proveedor: "t", modelo: "t", async enviar() { if (falla) throw falla; return { texto: "hola de nuevo", llamadas: [], fin: "fin", uso }; } };
  const { s } = sesion(llm, { llmTimeoutMs: 5000 });
  const a = eventos();
  assert.equal((await s.chat("uno", a.on)).status, "error");
  assert.match(JSON.stringify(a.ev.find((e) => e.type === "notice")), /tardó más de 5 segundos/);
  falla = null;
  const b = eventos();
  assert.equal((await s.chat("dos", b.on)).status, "done");
  assert.ok(b.ev.some((e) => e.type === "assistant_text"));
});

test("tope de tokens por sesión: al superarlo no se llama al modelo", async () => {
  let llamadas = 0;
  const llm: LlmAdapter = { proveedor: "t", modelo: "t", async enviar() { llamadas++; return { texto: "ok", llamadas: [], fin: "fin", uso: { ...uso, entrada: 600 } }; } };
  const { s } = sesion(llm, { tokensSesionMax: 500 });
  await s.chat("uno", () => {});
  const { ev, on } = eventos();
  await s.chat("dos", on);
  assert.equal(llamadas, 1);
  assert.match(JSON.stringify(ev.find((e) => e.type === "notice")), /límite de uso/);
});

test("adaptador Anthropic: traduce tipos neutrales, reenvía bloques opacos y clasifica errores", async () => {
  let enviado: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = new AnthropicAdapter({ messages: { create: async (p) => { enviado = p; return { content: [{ type: "text", text: "hola" }, { type: "tool_use", id: "u1", name: "oc_validar", input: { caso: "sol-001" } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 2 } } as never; } } });
  const r = await a.enviar([{ rol: "sistema", texto: "S" }, { rol: "usuario", texto: "hola" }, { rol: "usuario", texto: "otra" }], [{ nombre: "oc_validar", descripcion: "d", esquema: { type: "object" } }]);
  assert.deepEqual(r.llamadas, [{ id: "u1", nombre: "oc_validar", args: { caso: "sol-001" } }]);
  assert.equal(r.fin, "herramientas");
  assert.equal(enviado.messages.length, 1, "usuarios consecutivos se fusionan");
  assert.equal(enviado.system[0].text, "S");
  assert.equal(clasificarError({ status: 429 }).codigo, "limite");
  assert.equal(clasificarError({ status: 401 }).codigo, "clave");
  assert.equal(clasificarError(Object.assign(new Error("x"), { name: "TimeoutError" })).codigo, "timeout");
  assert.throws(() => AnthropicAdapter.conClave("sk-ant-..."), /ANTHROPIC_API_KEY/);
});
