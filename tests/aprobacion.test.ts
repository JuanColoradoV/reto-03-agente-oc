import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { LIMITS, type LlmClient } from "../src/agent/loop";
import { FILES } from "../src/data/fixtures.generated";
import { cargarCaso, cargarMaestros } from "../src/domain/casos";
import { validarItems } from "../src/domain/dinero";
import { MSG_APROBACION_OBSOLETA } from "../src/domain/errores";
import { fmtCantidad, fmtMonto } from "../src/domain/formato";
import { prepararOrden, vistaOrden } from "../src/domain/ordenes";
import { CAPS } from "../src/agent/state";
import { defineTool } from "../src/tools/registry";
import { z } from "zod";
import { ocTools, crearOrdenCompra } from "../src/tools/oc";
import { collect, fakeMessage, makeSession, text, toolUse } from "./helpers";

const crear = (id: string, solicitudId = "sol-000") => fakeMessage([toolUse(id, "crear_orden_compra", { solicitudId })], "tool_use");
const pendiente = (events: Awaited<ReturnType<typeof collect>>["events"]) => {
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  return pc.pending;
};

// ---------- 1. Huella de lo aprobado ----------
test("huella: si tras aprobar cambian los controles (aparece una factura), NO se crea la OC y se exige nueva aprobacion", async () => {
  const key = "fixtures/reto-03/solicitudes/sol-000/factura.txt";
  const { session, store } = makeSession([crear("tu_1"), crear("tu_2"), fakeMessage([text("Listo.")], "end_turn")]);
  try {
    const { events } = await collect((on) => session.chat("Procesa sol-000", on));
    const p1 = pendiente(events);
    assert.equal((p1.vista as { alertas: unknown[] }).alertas.length, 0);
    FILES[key] = "FACTURA 77 - fecha 2026-01-01 - 2500000 COP"; // "despliegue" que incorpora una factura: C4 pasa de OK a ALERTA
    const r = await collect((on) => session.confirm(p1.pendingId, "aprobar", "ok", on));
    assert.equal((await store.load()).sap.ordenes.length, 0, "no se creo la OC con la aprobacion vieja");
    assert.ok(r.events.some((e) => e.type === "notice" && e.text === MSG_APROBACION_OBSOLETA));
    const tr = r.events.find((e) => e.type === "tool_result");
    assert.ok(tr && tr.type === "tool_result" && !tr.ok && tr.code === "APROBACION_OBSOLETA");
    assert.match(String(tr.output), /revisa de nuevo/);
    assert.ok((await store.load()).audit.some((a) => a.type === "aprobacion_invalidada" && a.pendingId === p1.pendingId));
    // El pendiente viejo ya no se puede reutilizar; el agente pide una NUEVA aprobacion que muestra la alerta.
    const p2 = pendiente(r.events);
    assert.notEqual(p2.pendingId, p1.pendingId);
    assert.equal((p2.vista as { alertas: unknown[] }).alertas.length, 1);
    await assert.rejects(() => session.confirm(p1.pendingId, "aprobar"), /no es válida|ya fue procesada/);
    await session.confirm(p2.pendingId, "aprobar", "visto con la alerta");
    assert.equal((await store.load()).sap.ordenes.length, 1);
  } finally {
    delete FILES[key];
  }
});

test("huella: sin cambios, la aprobacion sigue valiendo aunque cambie la fecha de emision", async () => {
  const { session, store } = makeSession([crear("tu_1"), fakeMessage([text("Listo.")], "end_turn")]);
  const { events } = await collect((on) => session.chat("Procesa sol-000", on));
  (session as unknown as { env: { fecha: () => string } }).env.fecha = () => "2026-01-16"; // aprobada "despues de medianoche"
  await session.confirm(pendiente(events).pendingId, "aprobar");
  const oc = (await store.load()).sap.ordenes[0];
  assert.equal(oc?.fecha, "2026-01-16");
});

// ---------- 2. Precision ----------
test("precision: validarItems (cantidad >0 y max 3 decimales; precio >=0 y max 2) y formato sin perdida", () => {
  const it = (cantidad: number, precioUnitario: number) => [{ descripcion: "x", cantidad, precioUnitario }];
  assert.deepEqual(validarItems(it(0.004, 1000000)), []);
  assert.deepEqual(validarItems(it(1.005, 12.5)), []);
  assert.equal(validarItems(it(0.0015, 10)).length, 1);
  assert.equal(validarItems(it(0, 10)).length, 1);
  assert.equal(validarItems(it(-1, 10)).length, 1);
  assert.equal(validarItems(it(1, 10.001)).length, 1);
  assert.equal(validarItems(it(1, -5)).length, 1);
  assert.equal(validarItems(it(Number.NaN, 5)).length, 1);
  assert.equal(fmtCantidad(0.004), "0,004");
  assert.equal(fmtCantidad(2.5), "2,5");
  assert.equal(fmtCantidad(10), "10");
  assert.equal(fmtMonto(1000000), "1.000.000");
  assert.equal(fmtMonto(12.5), "12,50");
});

const casoCon = (cantidad: number, precio: number, total: number) => {
  const c = cargarCaso("sol-000");
  return { ...c, solicitud: { ...c.solicitud, items: [{ descripcion: "Pieza", cantidad, precioUnitario: precio }] }, cotizacion: `COTIZACION\nTOTAL: ${total} COP` };
};

test("precision: la tarjeta muestra exactamente lo que se graba (0,004 x 1.000.000 = 4.000) y una precision no admitida bloquea (V0)", () => {
  const m = cargarMaestros();
  const ok = prepararOrden(casoCon(0.004, 1000000, 4000), m, "2026-01-15", { ordenes: [] });
  assert.ok(ok.orden, JSON.stringify(ok.controles));
  assert.equal(ok.orden.items[0]?.cantidad, 0.004); // lo grabado conserva la cantidad exacta
  const v = vistaOrden(ok.orden, ok.controles, m, casoCon(0.004, 1000000, 4000));
  assert.equal(v.lineas[0]?.cantidadTxt, "0,004");
  assert.equal(v.lineas[0]?.precioTxt, "1.000.000");
  assert.equal(v.lineas[0]?.subtotalTxt, "4.000");
  assert.equal(v.total, 4000);

  const mal = prepararOrden(casoCon(0.0015, 1000, 2), m, "2026-01-15", { ordenes: [] });
  assert.equal(mal.orden, null);
  const v0 = mal.controles.find((c) => c.id === "V0");
  assert.equal(v0?.resultado, "FALLA");
  assert.match(v0?.detalle ?? "", /3 decimales/);
  const caro = prepararOrden(casoCon(1, 10.005, 10.01), m, "2026-01-15", { ordenes: [] });
  assert.equal(caro.orden, null);
});

// ---------- 4. Errores de herramientas ----------
test("errores: el detalle tecnico va al log del servidor; cliente y modelo reciben mensaje seguro + codigo + referencia", async () => {
  const SECRETO = "ECONNREFUSED 10.0.0.7:5432 password=hunter2";
  const boom = defineTool({ name: "boom", description: "falla", input: z.object({}), requiresConfirmation: false, handler: () => { throw new Error(SECRETO); } });
  const logs: string[] = [];
  const { session, calls } = makeSession([fakeMessage([toolUse("tu_1", "boom", {})], "tool_use"), fakeMessage([toolUse("tu_2", "leer_solicitud", { id: "sol-999" })], "tool_use"), fakeMessage([text("fin")], "end_turn")], undefined, "sess-err", { tools: [...ocTools, boom] });
  const orig = console.error;
  console.error = (m: unknown) => void logs.push(String(m));
  let events;
  try {
    ({ events } = await collect((on) => session.chat("falla", on)));
  } finally {
    console.error = orig;
  }
  const tecnico = events.find((e) => e.type === "tool_result" && e.name === "boom");
  assert.ok(tecnico && tecnico.type === "tool_result" && !tecnico.ok);
  assert.equal(tecnico.code, "ERROR_TECNICO");
  assert.match(tecnico.ref ?? "", /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(events).includes("hunter2") && !JSON.stringify(calls).includes("hunter2"), "el detalle no llega ni al cliente ni al modelo");
  assert.match(String(tecnico.output), new RegExp(`ref: ${tecnico.ref}`));
  assert.ok(logs.some((l) => l.includes("hunter2") && l.includes(tecnico.ref!)), "el detalle SI queda en el log del servidor, con la referencia");
  // Error de negocio: el mensaje seguro se devuelve tal cual.
  const negocio = events.find((e) => e.type === "tool_result" && e.name === "leer_solicitud");
  assert.ok(negocio && negocio.type === "tool_result" && !negocio.ok);
  assert.equal(negocio.code, "SOLICITUD_NO_ENCONTRADA");
  assert.match(String(negocio.output), /Solicitud no encontrada: sol-999/);
  assert.equal(negocio.ref, undefined);
});

// ---------- 9. Presupuesto de tokens ----------
test("presupuesto de tokens: max_tokens nunca supera el saldo (reintento incluido) y el turno se detiene limpio", async () => {
  const pedidos: number[] = [];
  let acumulado = 0;
  const client: LlmClient = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        pedidos.push(params.max_tokens);
        acumulado += params.max_tokens; // el peor caso: el modelo gasta todo lo permitido
        return fakeMessage([toolUse(`tu_${pedidos.length}`, "listar_solicitudes", {})], "max_tokens", params.max_tokens);
      },
    },
  };
  const { session } = makeSession([], undefined, "sess-tok", { makeClient: () => client });
  const { events, result } = await collect((on) => session.chat("lista", on));
  assert.ok(acumulado <= LIMITS.MAX_TOTAL_OUTPUT_TOKENS, `acumulado ${acumulado} > ${LIMITS.MAX_TOTAL_OUTPUT_TOKENS}`);
  assert.ok(pedidos.every((p) => p >= LIMITS.MIN_CALL_TOKENS));
  assert.equal((result as { status: string }).status, "done");
  assert.ok(events.some((e) => e.type === "notice" && e.level === "warn"));
});

test("presupuesto de tokens: con saldo justo el max_tokens se recorta al saldo y luego se agota", async () => {
  const pedidos: number[] = [];
  const client: LlmClient = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        pedidos.push(params.max_tokens);
        return fakeMessage([toolUse(`tu_${pedidos.length}`, "listar_solicitudes", {})], "tool_use", 15000); // gasta 15k por llamada
      },
    },
  };
  const { session } = makeSession([], undefined, "sess-tok2", { makeClient: () => client });
  await session.chat("lista");
  // 40000: 8192 -> (25000 restante) 8192 -> (10000 restante) 8192 -> (-5000) fin: nunca se pidio mas que el saldo.
  let restante = LIMITS.MAX_TOTAL_OUTPUT_TOKENS;
  for (const p of pedidos) {
    assert.ok(p <= Math.max(restante, 0));
    restante -= 15000;
  }
});

// ---------- 10. Recibo estructurado ----------
test("recibo: se guarda estructurado aparte del detalle truncado y sobrevive a la restauracion", async () => {
  const grande = defineTool({ ...crearOrdenCompra, handler: async (i, c, r) => ({ ...(await crearOrdenCompra.handler(i, c, r) as object), detalleTecnico: "x".repeat(9000) }) });
  const tools = ocTools.map((t) => (t.name === "crear_orden_compra" ? grande : t));
  const { session } = makeSession([crear("tu_1"), fakeMessage([text("Listo.")], "end_turn")], undefined, "sess-rec", { tools });
  const { events } = await collect((on) => session.chat("Procesa sol-000", on));
  await session.confirm(pendiente(events).pendingId, "aprobar", "ok");
  const snap = await session.snapshot(); // lo que la UI restaura al recargar
  const tr = snap.events.find((e) => e.type === "tool_result" && e.name === "crear_orden_compra");
  assert.ok(tr && tr.type === "tool_result" && tr.ok);
  // el detalle tecnico se trunco (los textos largos se recortan; la estructura del output se conserva)...
  assert.match(String((tr.output as { detalleTecnico: string }).detalleTecnico), /truncado/);
  assert.ok(JSON.stringify(tr.output).length < 6000);
  const rec = tr.recibo as Record<string, unknown>; // ...pero el recibo estructurado esta intacto
  assert.equal(rec.numero, "4500000001");
  assert.equal(rec.solicitudId, "sol-000");
  assert.equal(rec.total, 2500000);
  assert.equal(rec.comentarioAprobador, "ok");
  assert.ok(JSON.stringify(rec).length < 500);
});

// ---------- 11. Costo de toda la sesion ----------
test("costo: los totales de la sesion no se limitan a los ultimos 50 turnos", async () => {
  const n = CAPS.TRACE + 5;
  const { session } = makeSession(Array.from({ length: n }, () => fakeMessage([text("hola")], "end_turn")));
  for (let i = 0; i < n; i++) await session.chat(`mensaje ${i}`);
  assert.equal((await session.trace()).length, CAPS.TRACE);
  const a = await session.auditoria();
  assert.equal(a.turnos.length, CAPS.TRACE);
  assert.equal(a.turnosMostrados, CAPS.TRACE);
  assert.equal(a.costoTotal.turnos, n);
  assert.equal(a.costoTotal.llamadasModelo, n);
  assert.equal(a.costoTotal.input, 100 * n); // fakeMessage: 100 de entrada por llamada
  assert.equal(a.costoTotal.output, 50 * n);
  assert.ok(a.costoTotal.costoUsd > a.turnos.reduce((s, t) => s + t.costoUsd, 0));
  assert.deepEqual(await session.costo(), (await session.auditoria()).costoTotal);
});

// ---------- 12. Ver documentos ----------
test("documentos: la vista de aprobacion incluye correo, cotizacion y aprobacion legibles (sin marcas internas)", async () => {
  const { session } = makeSession([crear("tu_1")]);
  const { events } = await collect((on) => session.chat("Procesa sol-000", on));
  const d = (pendiente(events).vista as { documentos: { correo: { asunto: string }; cotizacion: string; aprobacion: Record<string, unknown>; factura: string | null } }).documentos;
  assert.equal(d.correo.asunto, "Compra de 10 sillas de oficina");
  assert.match(d.cotizacion, /Silla de oficina ergonomica/);
  assert.equal(d.aprobacion.aprobador, "Gerente Demo");
  assert.equal("_placeholder" in d.aprobacion, false);
  assert.equal(d.factura, null);
});

// ---------- 8. Accesibilidad (revision estatica: el frontend no tiene pruebas de navegador) ----------
test("accesibilidad: region aria-live educada para la ultima respuesta, sin re-anunciar el historial al restaurar", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync("public/index.html", "utf8");
  const js = readFileSync("public/app.js", "utf8");
  assert.match(html, /id="sr-reply"[^>]*aria-live="polite"/);
  assert.match(js, /announceReply = \(text\) => \{ if \(replaying/);
  assert.match(js, /case "assistant_text": addMsg\("assistant", e\.text\); announceReply\(e\.text\)/);
});
