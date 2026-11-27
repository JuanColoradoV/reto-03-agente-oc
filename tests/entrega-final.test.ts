// Regresiones de la ronda final: clave placeholder, reintentos del SDK, fallo del guardado final, tarjeta de aprobacion
// reconstruible, C3 sin monto, matriz generada, estados de auditoria y costo simulado.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { app, type Env } from "../src/api";
import type { UiEvent } from "../src/agent/events";
import { MissingApiKeyError, claveUsable, getClient } from "../src/llm/client";
import { createMockClient } from "../src/llm/mock";
import { cargarCaso, cargarMaestros } from "../src/domain/casos";
import { CONTROLES, V0_DATOS, matrizMarkdown, validarControles } from "../src/domain/controles";
import { MemoryKV } from "../src/session/storage";
import { collect, fakeMessage, makeSession, quiet, text, toolUse } from "./helpers";

const FAKE_KEY = "sk-ant-api03-" + "x".repeat(40);
const crear = (id: string, solicitudId: string) => fakeMessage([toolUse(id, "crear_orden_compra", { solicitudId })], "tool_use");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ---------------------------------------------------------------- clave placeholder
test("claveUsable: el placeholder de .dev.vars.example, vacios y basura NO cuentan como clave", () => {
  for (const k of [undefined, "", "   ", "sk-ant-...", "sk-ant-api03-...", "tu-clave-aqui", "sk-test", "sk-ant-corta"]) assert.equal(claveUsable(k), false, String(k));
  assert.equal(claveUsable(FAKE_KEY), true);
  assert.equal(claveUsable(` ${FAKE_KEY}\n`), true, "se tolera espacio alrededor (se recorta)");
});

test("getClient con placeholder lanza MissingApiKeyError (aviso en espanol) y con clave valida desactiva los reintentos del SDK", () => {
  assert.throws(() => getClient("sk-ant-..."), MissingApiKeyError);
  assert.throws(() => getClient(undefined), MissingApiKeyError);
  const c = getClient(FAKE_KEY) as unknown as { maxRetries: number };
  assert.equal(c.maxRetries, 0, "sin reintentos ocultos: 'max. 8 llamadas' cuenta peticiones HTTP reales");
});

test("API: con la clave placeholder /api/chat responde 503 missing_api_key (no un error generico) y /api/health dice hasApiKey=false", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-...", ASSETS: { fetch: async () => new Response("") }, SESSIONS: {} } as unknown as Env;
  const h = (await (await app.request("/api/health", {}, env)).json()) as { hasApiKey: boolean };
  assert.equal(h.hasApiKey, false);
  const res = await app.request("/api/chat", { method: "POST", body: JSON.stringify({ sessionId: "11111111-1111-4111-8111-111111111111", mensaje: "hola" }), headers: { "content-type": "application/json" } }, env);
  assert.equal(res.status, 503);
  const b = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(b.error.code, "missing_api_key");
  assert.match(b.error.message, /Falta configurar ANTHROPIC_API_KEY/);
});

test(".dev.vars.example: la clave va comentada (copiarlo tal cual no define una clave) y documenta MOCK_LLM=1", () => {
  const ex = read(".dev.vars.example");
  assert.ok(!/^ANTHROPIC_API_KEY=/m.test(ex), "la clave no debe estar activa en el ejemplo");
  assert.match(ex, /^#\s*ANTHROPIC_API_KEY=/m);
  assert.match(ex, /MOCK_LLM=1/);
});

// ---------------------------------------------------------------- Origin
test("Origin: un POST sin cabecera Origin (curl, scripts, eval) se acepta; uno de otro origen se rechaza con 403", async () => {
  const env = { MOCK_LLM: "1", ASSETS: { fetch: async () => new Response("") }, SESSIONS: {} } as unknown as Env;
  const body = JSON.stringify({ nope: true });
  const sin = await app.request("/api/chat", { method: "POST", body, headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.1" } }, env);
  assert.equal(sin.status, 400, "pasa el filtro de origen y llega a la validacion del cuerpo");
  const ajeno = await app.request("/api/chat", { method: "POST", body, headers: { "content-type": "application/json", origin: "https://evil.example", "cf-connecting-ip": "10.9.9.2" } }, env);
  assert.equal(ajeno.status, 403);
});

// ---------------------------------------------------------------- fallo del guardado final
class FlakyKV extends MemoryKV {
  failFinal = false;
  override async put(entries: Record<string, unknown>): Promise<void> {
    const ev = entries.events as UiEvent[] | undefined;
    if (this.failFinal && Array.isArray(ev) && ev.at(-1)?.type === "usage") throw new Error("disk full");
    return super.put(entries);
  }
}

test("si falla el guardado final: NO se informa exito (status error, aviso explicito, sin evento usage) y la sesion no queda bloqueada", async () => {
  const kv = new FlakyKV();
  const { session, store } = makeSession([fakeMessage([text("Hola, soy el agente.")], "end_turn"), fakeMessage([text("Otra vez.")], "end_turn")], kv);
  kv.failFinal = true;
  const { events, result } = await quiet(() => collect((on) => session.chat("hola", on)));
  const r = result as { status: string };
  assert.equal(r.status, "error");
  const avisos = events.filter((e) => e.type === "notice" && e.level === "error");
  assert.equal(avisos.length, 1, "aviso de error explicito al cliente");
  assert.match((avisos[0] as { text: string }).text, /No se pudo guardar/);
  assert.ok(!events.some((e) => e.type === "usage"), "no se emite el uso de un turno que no quedo guardado");
  const guardado = await store.load();
  assert.equal(guardado.trace.length, 0, "el turno no quedo en la traza guardada");
  assert.equal(guardado.messages.length, 1, "solo el mensaje del usuario (guardado antes); la respuesta del asistente no se persistio");
  // Recuperada la escritura, la sesion sigue usable (candado y lease liberados).
  kv.failFinal = false;
  const ok = await collect((on) => session.chat("de nuevo", on));
  assert.equal((ok.result as { status: string }).status, "done");
  assert.ok(ok.events.some((e) => e.type === "usage"));
});

// ---------------------------------------------------------------- tarjeta de aprobacion reconstruible
test("restaurar: con pending guardado pero SIN su evento pending_confirmation, el snapshot entrega la vista para reconstruir la tarjeta y se puede decidir", async () => {
  const { session, store } = makeSession([crear("t1", "sol-000"), fakeMessage([text("OC creada.")], "end_turn")]);
  await collect((on) => session.chat("Procesa sol-000", on));
  const st = await store.load();
  assert.ok(st.pending);
  st.events = st.events.filter((e) => e.type !== "pending_confirmation"); // se perdio el evento de la tarjeta
  await store.save(st);
  const snap = await session.snapshot();
  assert.ok(!snap.events.some((e) => e.type === "pending_confirmation"));
  assert.ok(snap.pending, "el snapshot incluye la accion pendiente");
  assert.equal(snap.pending.pendingId, st.pending.pendingId);
  const vista = snap.pending.vista as { solicitudId: string; lineas: unknown[]; total: number };
  assert.equal(vista.solicitudId, "sol-000");
  assert.equal(vista.lineas.length, 1);
  assert.equal(vista.total, 2500000);
  const r = await session.confirm(snap.pending.pendingId, "aprobar");
  assert.equal(r.status, "done");
  assert.equal((await store.load()).sap.ordenes.length, 1);
});

test("frontend: restore() reconstruye la tarjeta desde s.pending cuando no esta entre los eventos", () => {
  const js = read("public/app.js");
  const restore = js.slice(js.indexOf("async function restore()"));
  assert.match(restore, /s\.pending && !confirmCards\.has\(s\.pending\.pendingId\)/);
  assert.match(restore, /renderEvent\(\{ type: "pending_confirmation", pending: s\.pending \}\)/);
});

// ---------------------------------------------------------------- C3 y matriz
test("C3: aprobada pero SIN montoAprobado no se puede verificar => FALLA 'No se pudo verificar' (politica NO_EVALUABLE); con monto suficiente pasa", () => {
  const caso = cargarCaso("sol-000");
  const sinMonto = { ...caso, aprobacion: { aprobada: true, aprobador: "X" } };
  const c3 = validarControles(sinMonto, cargarMaestros(), { ordenes: [] }).controles.find((c) => c.id === "C3")!;
  assert.equal(c3.resultado, "FALLA");
  assert.match(c3.detalle, /^No se pudo verificar: .*monto aprobado/);
  const conMonto = validarControles(caso, cargarMaestros(), { ordenes: [] }).controles.find((c) => c.id === "C3")!;
  assert.equal(conMonto.resultado, "OK");
  const corto = validarControles({ ...caso, aprobacion: { aprobada: true, montoAprobado: 1 } }, cargarMaestros(), { ordenes: [] }).controles.find((c) => c.id === "C3")!;
  assert.equal(corto.resultado, "FALLA");
});

test("C3: el texto de la regla no promete 'vigente' (la fecha no se evalua) y dice que el monto es obligatorio", () => {
  const c3 = CONTROLES.find((c) => c.id === "C3")!;
  assert.doesNotMatch(c3.regla + c3.descripcion + c3.accion, /vigente/i);
  assert.match(c3.regla, /obligatorio/);
  assert.match(c3.regla, /vigencia.*no se evalúa/i);
});

test("matriz: generada desde el registro con columna Estado y V0, y SOLUCION.md la contiene tal cual", () => {
  const m = matrizMarkdown();
  const filas = m.split("\n");
  assert.match(filas[0]!, /\| Estado \|$/);
  assert.deepEqual(filas.slice(2).map((f) => f.split(" | ")[0]!.replace("| ", "")), [...CONTROLES.map((c) => c.id), V0_DATOS.id]);
  assert.ok(read("SOLUCION.md").includes(m), "regenerar con: npx tsx demo.ts --matriz y pegar en SOLUCION.md");
});

// ---------------------------------------------------------------- auditoria
test("auditoria: BLOQUEADA (control en FALLA) se distingue de SIN_PROCESAR (solo leida)", async () => {
  const { session } = makeSession([
    fakeMessage([toolUse("a", "leer_solicitud", { id: "sol-000" })], "tool_use"),
    fakeMessage([text("Leida.")], "end_turn"),
    crear("b", "sol-00X"),
    fakeMessage([text("Bloqueada.")], "end_turn"),
  ]);
  await collect((on) => session.chat("Lee sol-000", on));
  await collect((on) => session.chat("Procesa sol-00X", on));
  const a = await session.auditoria();
  assert.equal(a.solicitudes.find((s) => s.solicitudId === "sol-000")!.estado, "SIN_PROCESAR");
  assert.equal(a.solicitudes.find((s) => s.solicitudId === "sol-00X")!.estado, "BLOQUEADA");
});

// ---------------------------------------------------------------- costo simulado
test("modo simulado: el costo se reporta 0 y marcado como simulado (los tokens del guion son inventados); en modo real se estima", async () => {
  const mock = makeSession([], new MemoryKV(), "s-mock", { makeClient: () => createMockClient() });
  const r = (await collect((on) => mock.session.chat("hola", on, { mock: true }))).result as { usage: { costUsd: number; simulado?: boolean; input: number } };
  assert.equal(r.usage.costUsd, 0);
  assert.equal(r.usage.simulado, true);
  assert.ok(r.usage.input > 0, "los tokens inventados siguen visibles, rotulados como simulados");
  const aud = await mock.session.auditoria();
  assert.equal(aud.costoTotal.costoSimulado, true);
  assert.equal(aud.costoTotal.costoUsd, 0);
  assert.equal(aud.turnos[0]!.costoSimulado, true);

  const real = makeSession([fakeMessage([text("hola")], "end_turn")]);
  const rr = (await collect((on) => real.session.chat("hola", on))).result as { usage: { costUsd: number; simulado?: boolean } };
  assert.ok(rr.usage.costUsd > 0);
  assert.equal(rr.usage.simulado, undefined);
  assert.equal((await real.session.auditoria()).costoTotal.costoSimulado, false);
});

// ---------------------------------------------------------------- npm run eval
import { spawnSync } from "node:child_process";
import { ESCENARIOS, type Observado } from "../scripts/eval-scenarios";
import { motivoDeRechazo, tablaMarkdown, type Fila } from "../scripts/eval";

test("eval: los escenarios cubren crear, bloqueo, rechazo, consulta e inyecciones, y sus verificaciones distinguen exito de fallo", () => {
  assert.deepEqual(ESCENARIOS.map((e) => e.id), ["crear-aprobar", "bloqueada", "rechazar", "consulta", "inyeccion-mensaje", "inyeccion-documento", "inyeccion-encadenada"]);
  for (const e of ESCENARIOS) assert.ok(e.pasos.length > 0 && e.esperado && e.nombre, e.id);
  const vacio: Observado = { eventos: [], herramientas: [], ocs: [], tarjetas: 0, decisiones: [], texto: "" };
  const crear = ESCENARIOS.find((e) => e.id === "crear-aprobar")!;
  assert.ok(crear.verificar({ ...vacio, decisiones: [] }).length > 0, "sin tarjeta ni OC debe fallar");
  assert.deepEqual(crear.verificar({ ...vacio, herramientas: ["crear_orden_compra"], tarjetas: 1, decisiones: ["aprobar"], ocs: [{ numero: "4500000001", solicitudId: "sol-000" }] }), []);
  const iny = ESCENARIOS.find((e) => e.id === "inyeccion-mensaje")!;
  assert.deepEqual(iny.verificar(vacio), []);
  assert.ok(iny.verificar({ ...vacio, ocs: [{ numero: "1", solicitudId: "sol-00X" }] }).length > 0);
});

test("eval: se niega a correr sin clave real o en modo simulado", () => {
  assert.match(motivoDeRechazo({})!, /ANTHROPIC_API_KEY/);
  assert.match(motivoDeRechazo({ ANTHROPIC_API_KEY: "sk-ant-..." })!, /ANTHROPIC_API_KEY/);
  assert.match(motivoDeRechazo({ ANTHROPIC_API_KEY: FAKE_KEY, MOCK_LLM: "1" })!, /MOCK_LLM/);
  assert.equal(motivoDeRechazo({ ANTHROPIC_API_KEY: FAKE_KEY }), null);
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "eval.ts")], { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: "", MOCK_LLM: "" }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Falta ANTHROPIC_API_KEY/);
});

test("eval: la tabla Markdown trae las columnas pedidas y marca los fallos", () => {
  const esc = ESCENARIOS[0]!;
  const fila: Fila = { escenario: esc, obs: { eventos: [], herramientas: ["leer_solicitud", "crear_orden_compra"], ocs: [], tarjetas: 1, decisiones: [], texto: "" }, problemas: ["sin OC"], tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0 }, costoUsd: 0.0123, ms: 4200, status: "done" };
  const md = tablaMarkdown([fila], { modelo: "m", fecha: "2026-01-01" });
  assert.match(md, /\| Escenario \| Esperado \| Obtenido \| Herramientas \| Tokens ent\. \/ sal\. \| Costo \(USD\) \| Latencia \| Resultado \|/);
  assert.match(md, /leer_solicitud → crear_orden_compra/);
  assert.match(md, /FALLA/);
  assert.match(md, /- sin OC/);
});

// ---------------------------------------------------------------- tope de bytes por valor guardado
import { CAPS } from "../src/agent/state";
import { acotarEventos } from "../src/session/session";
import { SessionError } from "../src/session/session";

test("storage: los eventos guardados se acotan por bytes (los mas viejos se descartan primero) y nunca superan CAPS.VALUE_BYTES", () => {
  const ev = Array.from({ length: 400 }, (_, i) => ({ type: "assistant_text", text: `${i}:` + "x".repeat(20_000) }) as UiEvent);
  acotarEventos(ev, CAPS.VALUE_BYTES);
  assert.ok(new TextEncoder().encode(JSON.stringify(ev)).length <= CAPS.VALUE_BYTES);
  assert.ok(ev.length > 10 && ev.length < 400);
  assert.match((ev.at(-1) as { text: string }).text, /^399:/, "se conservan los mas recientes");
  const pocos = [{ type: "assistant_text", text: "hola" } as UiEvent];
  acotarEventos(pocos, CAPS.VALUE_BYTES);
  assert.equal(pocos.length, 1);
});

test("storage: un historial que ya excede el tope de bytes cierra la sesion con 'sesion_larga' en vez de fallar al guardar", async () => {
  const { session, store } = makeSession([fakeMessage([text("ok")], "end_turn")]);
  const st = await store.load();
  st.messages = [{ role: "user", content: "x".repeat(CAPS.VALUE_BYTES + 10) }];
  await store.save(st);
  await assert.rejects(() => session.startChat("hola"), (e: unknown) => e instanceof SessionError && e.code === "sesion_larga");
});

test("storage: la sesion con un guardado final que supera el limite se recorta y guarda (no falla)", async () => {
  const { session, store } = makeSession([fakeMessage([text("ok")], "end_turn")]);
  const st = await store.load();
  st.events = Array.from({ length: 400 }, () => ({ type: "assistant_text", text: "y".repeat(30_000) }) as UiEvent);
  await store.save(st);
  const r = await collect((on) => session.chat("hola", on));
  assert.equal((r.result as { status: string }).status, "done");
  const g = await store.load();
  assert.ok(new TextEncoder().encode(JSON.stringify(g.events)).length <= CAPS.VALUE_BYTES);
});

// ---------------------------------------------------------------- V0 dentro de validar_controles
import { FILES } from "../src/data/fixtures.generated";
import { prepararOrden } from "../src/domain/ordenes";
import { CODIGO } from "../src/domain/errores";
import { InMemorySap } from "../src/sap";
import { ocTools } from "../src/tools/oc";
import { executeTool, preflightTool } from "../src/tools/registry";

const DIR = "fixtures/reto-03/solicitudes/";
async function conSolicitud<T>(id: string, cambio: (s: Record<string, unknown>) => void, fn: () => Promise<T>): Promise<T> {
  const k = DIR + `${id}/solicitud.json`;
  const orig = FILES[k]!;
  const s = JSON.parse(orig) as Record<string, unknown>;
  cambio(s);
  FILES[k] = JSON.stringify(s);
  try {
    return await fn();
  } finally {
    FILES[k] = orig;
  }
}

test("V0: validar_controles NUNCA dice aprobable cuando prepararOrden bloquearia por V0 (cantidad 0, precio con 3 decimales, sin lineas)", async () => {
  for (const cambio of [
    (s: Record<string, unknown>) => { (s.items as { cantidad: number }[])[0]!.cantidad = 0; },
    (s: Record<string, unknown>) => { (s.items as { precioUnitario: number }[])[0]!.precioUnitario = 10.005; },
    (s: Record<string, unknown>) => { s.items = []; },
  ]) {
    await conSolicitud("sol-000", cambio, async () => {
      const ctx = { sap: new InMemorySap(), fecha: "2026-01-15" };
      const v = await executeTool(ocTools, "validar_controles", { id: "sol-000" }, ctx);
      assert.ok(v.ok);
      const r = v.output as { aprobable: boolean; controles: { id: string; resultado: string }[] };
      assert.equal(r.controles.find((c) => c.id === "V0")?.resultado, "FALLA");
      assert.equal(r.aprobable, false);
      assert.equal(prepararOrden(cargarCaso("sol-000"), cargarMaestros(), "2026-01-15", { ordenes: [] }).bloqueante, true);
    });
  }
  // Sin problemas de datos V0 no aparece.
  const ok = await executeTool(ocTools, "validar_controles", { id: "sol-000" }, { sap: new InMemorySap(), fecha: "2026-01-15" });
  assert.ok(ok.ok && !(ok.output as { controles: { id: string }[] }).controles.some((c) => c.id === "V0"));
});

// ---------------------------------------------------------------- C0: "Ya procesada"
test("C0: con OC existente el resultado es 'Ya procesada (OC N)': validar_controles lo informa, el preflight usa codigo YA_PROCESADA (no CONTROLES_FALLA) y la traza lo marca ya_procesada", async () => {
  const sap = new InMemorySap();
  const ctx = { sap, fecha: "2026-01-15" };
  const pf0 = await preflightTool(ocTools.find((t) => t.name === "crear_orden_compra")!, { solicitudId: "sol-000" }, ctx);
  assert.ok(pf0.ok);
  await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx, { confirmation: "autoConfirm", preflight: pf0.data });
  const v = await executeTool(ocTools, "validar_controles", { id: "sol-000" }, ctx);
  assert.ok(v.ok);
  const r = v.output as { aprobable: boolean; yaProcesada?: string };
  assert.equal(r.aprobable, false);
  assert.equal(r.yaProcesada, "4500000001");
  const pf = await preflightTool(ocTools.find((t) => t.name === "crear_orden_compra")!, { solicitudId: "sol-000" }, ctx);
  assert.ok(!pf.ok);
  if (!pf.ok) {
    assert.equal(pf.code, CODIGO.YA_PROCESADA);
    assert.match(pf.error, /^Ya procesada: .*4500000001/);
    assert.match(pf.error, /C0 OC existente/);
  }
});

test("C0: una solicitud con OC y otra falla real NO es 'Ya procesada' (sigue siendo bloqueo por controles)", async () => {
  await conSolicitud("sol-000", (s) => { s.proveedorId = "NO-EXISTE"; }, async () => {
    const sap = new InMemorySap();
    await sap.crearOrdenCompra({ solicitudId: "sol-000", proveedorId: "P-0001", centroCosto: "CC", moneda: "COP", items: [{ descripcion: "x", cantidad: 1, precioUnitario: 1 }], total: 1, fecha: "2026-01-15" });
    const v = await executeTool(ocTools, "validar_controles", { id: "sol-000" }, { sap, fecha: "2026-01-15" });
    assert.ok(v.ok);
    assert.equal((v.output as { yaProcesada?: string }).yaProcesada, undefined);
  });
});

test("C0: en la auditoria una solicitud con OC que se vuelve a pedir sigue OC_CREADA (no pasa a BLOQUEADA) y la traza marca el intento como ya_procesada", async () => {
  const { session } = makeSession([crear("t1", "sol-000"), fakeMessage([text("Listo.")], "end_turn"), crear("t2", "sol-000"), fakeMessage([text("Ya procesada.")], "end_turn")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  const pc = first.events.find((e) => e.type === "pending_confirmation") as { pending: { pendingId: string } };
  await session.confirm(pc.pending.pendingId, "aprobar");
  await collect((on) => session.chat("Procesa sol-000 otra vez", on));
  const a = await session.auditoria();
  assert.equal(a.solicitudes.find((s) => s.solicitudId === "sol-000")!.estado, "OC_CREADA");
  const tr = await session.trace();
  assert.ok(tr.some((t) => t.tools.some((x) => x.bloqueo === "ya_procesada")));
});

test("frontend: la UI trata 'Ya procesada' como resultado neutro propio (no como bloqueo)", () => {
  const js = read("public/app.js");
  assert.match(js, /yaProcesada: "Ya procesada"/);
  assert.match(js, /isYaProcesada/);
  assert.match(js, /function addYaProcesada/);
  assert.match(read("agent/prompt.md"), /\*\*Ya procesada\*\*/);
});

import { estimateCostUsd } from "../src/agent/cost";
test("costo: un modelo sin tarifa no suma costo inventado; Sonnet si", () => {
  assert.equal(estimateCostUsd("modelo-desconocido", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.ok(estimateCostUsd("claude-sonnet-5-5", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }) > 0);
});

test("prompt: pide un resumen de 1-2 lineas y no repetir lo que ya muestran las tarjetas de la UI", () => {
  const p = read("agent/prompt.md");
  assert.match(p, /No repitas en prosa/);
  assert.match(p, /1 o 2 líneas/);
});

test("sol-00R (factura previa): C4 da ALERTA no bloqueante y la tarjeta de aprobacion trae la alerta", async () => {
  const { session } = makeSession([crear("t1", "sol-00R")]);
  const { events } = await collect((on) => session.chat("Procesa sol-00R", on));
  const pc = events.find((e) => e.type === "pending_confirmation") as { pending: { vista: { alertas: { id: string; resultado: string }[]; documentos: { factura: string | null } } } };
  assert.ok(pc, "debe pedir aprobacion (la alerta no bloquea)");
  assert.deepEqual(pc.pending.vista.alertas.map((a) => [a.id, a.resultado]), [["C4", "ALERTA"]]);
  assert.match(pc.pending.vista.documentos.factura ?? "", /Fecha: 2026-01-05/);
});

// ---------------------------------------------------------------- auditoria CSV
import { auditoriaCsv } from "../src/session/auditoria";
import { readdirSync, statSync } from "node:fs";

test("auditoria CSV: una fila por solicitud, estados legibles, comentario con comas/comillas escapado y sin inyeccion de formulas", async () => {
  const { session } = makeSession([crear("t1", "sol-000"), fakeMessage([text("OC creada.")], "end_turn"), crear("t2", "sol-00X"), fakeMessage([text("Bloqueada.")], "end_turn")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  const pc = first.events.find((e) => e.type === "pending_confirmation") as { pending: { pendingId: string } };
  await session.confirm(pc.pending.pendingId, "aprobar", '=SUMA(1;1), "ok"');
  await collect((on) => session.chat("Procesa sol-00X", on));
  const csv = auditoriaCsv(await session.auditoria());
  assert.ok(csv.startsWith("﻿solicitud,estado,oc,total,moneda,decision,comentario_o_motivo,controles,fecha\r\n"));
  const filas = csv.trim().split("\r\n").slice(1);
  assert.equal(filas.length, 2);
  assert.match(filas[0]!, /^sol-000,OC creada,4500000001,2500000,COP,aprobar,"'=SUMA\(1;1\), ""ok""",/);
  assert.match(filas[1]!, /^sol-00X,Bloqueada por controles,/);
});

test("API: /api/sesion/:id/auditoria.csv se reenvia al DO, valida el id y la ruta de la UI existe", async () => {
  const llamadas: string[] = [];
  const env = { ASSETS: { fetch: async () => new Response("") }, SESSIONS: { idFromName: (n: string) => n, get: () => ({ fetch: async (u: string) => (llamadas.push(new URL(u).pathname), new Response("a,b", { headers: { "content-type": "text/csv" } })) }) } } as unknown as Env;
  const SID = "11111111-1111-4111-8111-111111111111";
  assert.equal((await app.request(`/api/sesion/${SID}/auditoria.csv`, {}, env)).status, 200);
  assert.deepEqual(llamadas, ["/auditoria.csv"]);
  assert.equal((await app.request(`/api/sesion/no-uuid/auditoria.csv`, {}, env)).status, 400);
  assert.match(read("public/index.html"), /id="audit-csv"[^>]*>Descargar auditoría \(CSV\)/);
});

// ---------------------------------------------------------------- UI para usuario de negocio y CSS
test("UI: la telemetria vive en un <details> cerrado 'Diagnostico tecnico' y la fila del chat no muestra el nombre snake_case ni los ms", () => {
  const html = read("public/index.html");
  assert.match(html, /<details class="side-section diag" id="diag">\s*<summary>Diagnóstico técnico<\/summary>/);
  assert.ok(!/<details[^>]*\bopen\b[^>]*id="diag"/.test(html) && !/id="diag"[^>]*\bopen\b/.test(html));
  assert.ok(html.indexOf('id="trace"') > html.indexOf('id="diag"'), "la traza esta dentro del diagnostico");
  const js = read("public/app.js");
  assert.match(js, /main\.append\(label, sum\);/);
  assert.match(js, /tech\.append\(el\("code", "name", e\.name\), ms\)/, "nombre y ms siguen disponibles en el detalle tecnico");
  assert.match(js, /body\.append\(tech, el\("p", "subh", "Entrada"\)/);
});

test("CSS: campos a 16px (iOS), borde de .btn-outline con contraste de control, pill de error visible en movil y sin selectores muertos", () => {
  const css = read("public/styles.css");
  assert.match(css, /textarea, input \{ font-size: 16px; \}/);
  assert.match(css, /\.btn-outline \{ border-color: var\(--input-border\); \}/);
  assert.match(css, /\.pill\.health:not\(\[data-state="err"\]\) \{ display: none; \}/);
  assert.ok(!/\.stamped|\.seal\b/.test(css));
  const fuente = read("public/app.js") + read("public/index.html");
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const clases = new Set([...limpio.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!).filter((c) => !/^\d/.test(c)));
  const muertas = [...clases].filter((c) => !new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(fuente));
  assert.deepEqual(muertas, [], "clases CSS que no usa ni el HTML ni el JS");
});

// ---------------------------------------------------------------- documentacion y codigo en voz tecnica neutra
test("el repo no deja rastros del proceso de elaboracion (revisiones, herramientas, narracion en primera persona)", () => {
  const prohibido = new RegExp(["revisi[oó]n (externa|de la)", "citadas? por la", "cod" + "ex", "gem" + "ini", "car" + "bon", "\\bag" + "y\\b", "no pude " + "abrir", "desde aqu[ií]", "ya se " + "corrigi", "sub" + "agente", "repro " + "del navegador"].join("|"), "i");
  const archivos: string[] = [];
  const recorre = (dir: string) => {
    for (const n of readdirSync(join(ROOT, dir))) {
      if (n.startsWith(".") || n === "node_modules" || n === "fixtures.generated.ts" || n.endsWith(".gif")) continue;
      const rel = join(dir, n);
      if (statSync(join(ROOT, rel)).isDirectory()) recorre(rel);
      else if (/\.(ts|js|md|css|html|jsonc?)$/.test(n) && n !== "package-lock.json") archivos.push(rel);
    }
  };
  recorre(".");
  const malos = archivos.filter((f) => prohibido.test(read(f)) && !f.endsWith("docs/eval-results.md"));
  assert.deepEqual(malos, []);
});
