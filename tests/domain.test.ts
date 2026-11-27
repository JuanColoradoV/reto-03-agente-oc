import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFile } from "../src/data/repo";
import { cargarCaso, cargarMaestros } from "../src/domain/casos";
import { CONTROLES, evaluarControl, matrizMarkdown, type ControlDef } from "../src/domain/controles";
import { lineaMinor, multiplicarMinor, toMinor, totalMinor } from "../src/domain/dinero";
import { prepararOrden } from "../src/domain/ordenes";
import { parseCotizacion, parseMonto } from "../src/domain/parsers/cotizacion";
import { ejecutarDemo, cargarEsperados } from "../src/demo/run";
import { buildSessionApp } from "../src/session/routes";
import { fakeMessage, makeSession, text } from "./helpers";

test("dinero en centavos enteros: 0.1 + 0.2 === 0.3", () => {
  assert.equal(totalMinor([{ descripcion: "a", cantidad: 1, precioUnitario: 0.1 }, { descripcion: "b", cantidad: 1, precioUnitario: 0.2 }]), toMinor(0.3));
});

test("parseMonto y parseCotizacion (stub)", () => {
  assert.equal(parseMonto("2.500.000"), 2500000);
  assert.equal(parseMonto("2,500,000"), 2500000);
  assert.equal(parseMonto("1.234,56"), 1234.56);
  assert.equal(parseMonto("abc"), null);
  const r = parseCotizacion(cargarCaso("sol-000").cotizacion);
  assert.equal(r.campos.total, 2500000);
  assert.equal(r.campos.items.length, 1);
  assert.deepEqual(r.noParseados, []);
  assert.ok(parseCotizacion("texto libre sin estructura").noParseados.includes("total"));
});

test("prepararOrden: arma la OC desde el caso; bloquea con control en FALLA", () => {
  const m = cargarMaestros();
  const ok = prepararOrden(cargarCaso("sol-000"), m, "2026-01-15", { ordenes: [] });
  assert.equal(ok.bloqueante, false);
  assert.equal(ok.orden?.total, 2500000);
  assert.equal(ok.orden?.proveedorId, "P-0001");
  const bad = prepararOrden(cargarCaso("sol-00X"), m, "2026-01-15", { ordenes: [] });
  assert.equal(bad.bloqueante, true);
  assert.equal(bad.orden, null);
  assert.equal(bad.controles.find((c) => c.id === "C1")?.resultado, "FALLA");
});

test("registro de controles y matriz derivada", () => {
  assert.deepEqual(CONTROLES.map((c) => c.id), ["C0", "C1", "C2", "C3", "C4"]);
  assert.match(matrizMarkdown(), /\| C1 \| Proveedor en maestro/);
  for (const c of CONTROLES) { assert.ok(c.descripcion.length > 10, c.id); assert.ok(c.accion.length > 10, c.id); }
});

test("demo: los resultados esperados coinciden", async () => {
  const r = await ejecutarDemo();
  assert.equal(r.fallos, 0, r.lines.join("\n"));
});

test("demo detecta un esperado incorrecto (falla de verdad)", async () => {
  const esp = cargarEsperados();
  esp.casos["sol-000"]!.oc = false;
  const r = await ejecutarDemo(esp);
  assert.ok(r.fallos > 0);
  assert.ok(r.lines.some((l) => l.startsWith("FAIL sol-000")));
});

test("demo falla si un esperado no tiene fixture, si un fixture no tiene esperado o si falta un caso requerido", async () => {
  const sinFixture = cargarEsperados();
  sinFixture.casos["sol-999"] = { bloqueante: true, oc: false, total: null, controles: {} };
  const a = await ejecutarDemo(sinFixture);
  assert.ok(a.fallos > 0);
  assert.ok(a.lines.some((l) => /sol-999 no tiene fixture/.test(l)));

  const sinEsperado = cargarEsperados();
  delete sinEsperado.casos["sol-00X"];
  const b = await ejecutarDemo(sinEsperado);
  assert.ok(b.fallos > 0);
  assert.ok(b.lines.some((l) => /fixture sol-00X no tiene resultado esperado/.test(l)));

  const c = await ejecutarDemo(cargarEsperados(), ["sol-001"]);
  assert.ok(c.fallos > 0);
  assert.ok(c.lines.some((l) => /caso requerido sol-001 falta/.test(l)));
});

test("rutas del DO: /state restaura el historial, /trace devuelve la traza y /reset borra", async () => {
  const { session } = makeSession([fakeMessage([text("Hola, soy el agente.")], "end_turn")]);
  const app = buildSessionApp(() => session);

  const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ mensaje: "hola" }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /event: ui/);
  assert.match(body, /event: done/);

  const st = (await (await app.request("/state")).json()) as { events: Array<{ type: string }>; pending: unknown };
  assert.deepEqual(st.events.map((e) => e.type), ["user_text", "assistant_text", "usage"]);
  const tr = (await (await app.request("/trace")).json()) as { trace: unknown[] };
  assert.equal(tr.trace.length, 1);

  assert.equal((await app.request("/reset", { method: "POST" })).status, 200);
  assert.equal(((await (await app.request("/state")).json()) as { events: unknown[] }).events.length, 0);

  const bad = await app.request("/chat", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 400);
});

test("política NO_EVALUABLE: bloqueante => FALLA 'No se pudo verificar'; alerta => ALERTA", () => {
  const caso = cargarCaso("sol-000");
  const maestros = cargarMaestros();
  const base = { descripcion: "d", accion: "a", regla: "r", fuente: "f", estado: "t" };
  const bloqueante: ControlDef = { ...base, id: "T1", nombre: "T bloqueante", severidad: "bloqueante", evaluar: () => ({ estado: "NO_EVALUABLE", detalle: "dato ilegible" }) };
  const alerta: ControlDef = { ...base, id: "T2", nombre: "T alerta", severidad: "alerta", evaluar: () => ({ estado: "NO_EVALUABLE", detalle: "dato ilegible" }) };
  const rb = evaluarControl(bloqueante, caso, maestros);
  assert.equal(rb.resultado, "FALLA");
  assert.match(rb.detalle, /^No se pudo verificar: dato ilegible/);
  const ra = evaluarControl(alerta, caso, maestros);
  assert.equal(ra.resultado, "ALERTA");
  assert.equal(ra.detalle, "dato ilegible");
});

test("cotización ilegible (C2 bloqueante no evaluable) => FALLA y no se prepara la OC", () => {
  const caso = { ...cargarCaso("sol-000"), cotizacion: "texto libre sin estructura" };
  const prep = prepararOrden(caso, cargarMaestros(), "2026-01-15", { ordenes: [] });
  const c2 = prep.controles.find((c) => c.id === "C2")!;
  assert.equal(c2.resultado, "FALLA");
  assert.match(c2.detalle, /No se pudo verificar/);
  assert.equal(prep.orden, null);
  assert.equal(prep.bloqueante, true);
});

test("sin consulta a SAP (C0 no evaluable) => FALLA: no se crea OC si no se puede verificar duplicidad", () => {
  const prep = prepararOrden(cargarCaso("sol-000"), cargarMaestros(), "2026-01-15");
  assert.equal(prep.controles.find((c) => c.id === "C0")!.resultado, "FALLA");
  assert.equal(prep.orden, null);
});

test("maestros opcionales: se cargan solo si el archivo existe (sin error si faltan)", () => {
  const m = cargarMaestros();
  assert.ok(m.proveedores.length > 0);
  const mapa = { centrosCosto: "centros-costo", indicadoresIva: "indicadores-iva", condicionesPago: "condiciones-pago" } as const;
  for (const [clave, archivo] of Object.entries(mapa)) assert.equal(clave in m, hasFile(`maestros/${archivo}.json`), clave);
});

test("dinero exacto: 0.5 x 0.29 = 0.15 (15 centavos), no 14 por el intermedio binario", () => {
  assert.equal(lineaMinor({ descripcion: "a", cantidad: 0.5, precioUnitario: 0.29 }), 15);
  assert.ok(Math.round(0.5 * 0.29 * 100) === 14, "el calculo con floats SI falla: es lo que se evita");
});

test("dinero exacto: casos borde (half-up, milesimas, ceros, montos grandes, negativos simetricos)", () => {
  const l = (cantidad: number, precioUnitario: number) => lineaMinor({ descripcion: "x", cantidad, precioUnitario });
  assert.equal(l(1, 0.1) + l(1, 0.2), 30);
  assert.equal(l(0.001, 0.5), 0); // 0.0005 -> 0.05 centavo: se redondea a 0
  assert.equal(l(0.005, 1), 1); // 0.5 centavo exacto -> half-up = 1
  assert.equal(l(0.003, 1), 0); // 0.3 centavo -> 0
  assert.equal(l(0.007, 1), 1); // 0.7 centavo -> 1
  assert.equal(l(1.005, 1), 101); // 100.5 centavos -> 101 (half-up; con floats daria 100)
  assert.equal(l(3, 0.07), 21);
  assert.equal(l(0, 99.99), 0);
  assert.equal(l(10, 0), 0);
  assert.equal(l(0.1, 0.1), 1); // 0.01 exacto
  assert.equal(l(1234567.891, 9999999.99), Number((1234567891n * 999999999n + 500n) / 1000n)); // por encima de 2^53 en el producto intermedio
  assert.equal(multiplicarMinor(-500, 29), -15);
  assert.equal(multiplicarMinor(-5, 100), -1);
  assert.equal(multiplicarMinor(2 ** 40, 2 ** 20), Number((BigInt(2 ** 40) * BigInt(2 ** 20) + 500n) / 1000n));
});

test("dinero exacto: el total es la suma de subtotales redondeados por linea", () => {
  const items = [
    { descripcion: "a", cantidad: 0.5, precioUnitario: 0.29 },
    { descripcion: "b", cantidad: 0.5, precioUnitario: 0.29 },
    { descripcion: "c", cantidad: 2.5, precioUnitario: 1.15 },
  ];
  assert.equal(totalMinor(items), 15 + 15 + 288); // 2.875 -> 288
});
