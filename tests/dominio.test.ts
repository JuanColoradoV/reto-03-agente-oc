import assert from "node:assert/strict";
import { test } from "node:test";
import { fixturesEmpaquetados } from "../src/domain/fixtures";
import { cargarMaestros, leerPaquete } from "../src/domain/paquete";
import { aprobacionDesdeJson, esAprobado, normalizarNit, parseCotizacion, parseFactura, parseMonto } from "../src/domain/parsers";
import { REGLAS, validar } from "../src/domain/reglas";
import type { Maestros, Paquete } from "../src/domain/tipos";

const maestros = async (): Promise<Maestros> => {
  const m = await cargarMaestros(fixturesEmpaquetados);
  assert.ok(m.ok);
  return m.data;
};
const paquete = async (caso: string): Promise<Paquete> => {
  const p = await leerPaquete(fixturesEmpaquetados, caso);
  assert.ok(p.ok, p.ok ? "" : p.error);
  return p.data;
};
const clonar = (p: Paquete): Paquete => structuredClone(p);

test("parsers: NIT, montos colombianos, cotización y factura de los fixtures", async () => {
  assert.equal(normalizarNit("900.555.111-2"), "900555111");
  assert.equal(parseMonto("11.400.000"), 11400000);
  assert.equal(parseMonto("1.234,56"), 1234.56);
  assert.equal(parseMonto("abc"), null);
  const c = parseCotizacion((await fixturesEmpaquetados.leer("solicitudes/sol-001/cotizacion.txt"))!);
  assert.ok(c.ok);
  assert.deepEqual({ ...c.valor, texto: "" }, { proveedor: "TecnoSuministros S.A.S.", nit: "900555111", total: 11400000, moneda: "COP", validez_hasta: "2026-09-17", texto: "", referencia: "COT-TS-2026-0451" });
  const f = parseFactura((await fixturesEmpaquetados.leer("solicitudes/sol-005/factura.txt"))!);
  assert.ok(f.ok);
  assert.deepEqual(f.valor, { numero: "FC-88231", fecha: "2026-08-10", total: 3200000 });
  assert.equal(parseCotizacion("sin datos").ok, false);
});

test("aprobado: contiene «Aprobado» y no lo niega", () => {
  assert.equal(esAprobado("Aprobado, proceder."), true);
  assert.equal(esAprobado("Revisado, no aprobado."), false);
  assert.equal(esAprobado("Lo veo bien."), false);
  assert.equal(aprobacionDesdeJson({ de: "a@x", para: "b@x", fecha: "2026-01-01", asunto: "s", cuerpo: "Aprobado por 25 millones" }).aprobado, true);
});

test("leer_paquete: adjunto ausente = null con su nombre; casos y datos inválidos = error legible, sin lanzar", async () => {
  const p = await paquete("sol-001");
  assert.equal(p.cotizacion?.total, 11400000);
  assert.equal(p.aprobacion?.aprobado, true);
  assert.equal(p.factura, null);
  assert.deepEqual(p.faltantes, []);
  assert.equal((await paquete("sol-005")).factura?.numero, "FC-88231");

  const sinCot: typeof fixturesEmpaquetados = { listarCasos: fixturesEmpaquetados.listarCasos, leer: async (r) => (r.endsWith("cotizacion.txt") ? null : fixturesEmpaquetados.leer(r)) };
  const r = await leerPaquete(sinCot, "sol-001");
  assert.ok(r.ok);
  assert.equal(r.data.cotizacion, null);
  assert.deepEqual(r.data.faltantes, ["cotizacion.txt"]);

  assert.equal((await leerPaquete(fixturesEmpaquetados, "../etc")).ok, false);
  assert.equal((await leerPaquete(fixturesEmpaquetados, "sol-999")).ok, false);
  const malo: typeof fixturesEmpaquetados = { listarCasos: fixturesEmpaquetados.listarCasos, leer: async (r) => (r.endsWith("solicitud.json") ? "{ no es json" : fixturesEmpaquetados.leer(r)) };
  const m = await leerPaquete(malo, "sol-001");
  assert.ok(!m.ok && /malformado/.test(m.error));
  const noNum: typeof fixturesEmpaquetados = { listarCasos: fixturesEmpaquetados.listarCasos, leer: async (r) => (r.endsWith("solicitud.json") ? (await fixturesEmpaquetados.leer(r))!.replace('"valor_total": 11400000', '"valor_total": "mucho"') : fixturesEmpaquetados.leer(r)) };
  const n = await leerPaquete(noNum, "sol-001");
  assert.ok(!n.ok && /valor_total/.test(n.error));
});

const ESPERADO: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean }> = {
  "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
  "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
  "sol-003": { apta: false, bloqueos: ["RC2", "RC3"], confirmaciones: [], retroactiva: false },
  "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
  "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
  "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
};

for (const [caso, esp] of Object.entries(ESPERADO)) {
  test(`validar ${caso}: ${esp.apta ? "apta" : "bloqueada"} ${[...esp.bloqueos, ...esp.confirmaciones].join(",") || "limpia"}`, async () => {
    const v = validar(await paquete(caso), await maestros());
    assert.equal(v.apta, esp.apta);
    assert.deepEqual(v.bloqueos.map((b) => b.codigo), esp.bloqueos);
    assert.deepEqual(v.confirmaciones.map((c) => c.codigo), esp.confirmaciones);
    assert.equal(v.retroactiva, esp.retroactiva);
  });
}

test("RC5 incluye ambos valores; RC6/RC7 derivan del proveedor; bloqueos traen acción sugerida", async () => {
  const m = await maestros();
  const v4 = validar(await paquete("sol-004"), m);
  assert.deepEqual(v4.confirmaciones[0]!.valores, { solicitud: 25000000, cotizacion: 26500000, diferencia_pct: 6, moneda_solicitud: "COP", moneda_cotizacion: "COP" });
  const v6 = validar(await paquete("sol-006"), m);
  assert.deepEqual(v6.derivados, { indicador_iva: "C1", condiciones_pago: "Z030" });
  for (const b of validar(await paquete("sol-003"), m).bloqueos) assert.ok(b.accion_sugerida);
});

test("RC1 por NIT, por nombre normalizado sin NIT, e inactivo", async () => {
  const m = await maestros();
  const p = clonar(await paquete("sol-001"));
  p.solicitud.proveedor_nit = "900.555.111-2";
  assert.ok(validar(p, m).apta);
  delete p.solicitud.proveedor_nit;
  p.solicitud.proveedor_nombre = "TECNOSUMINISTROS s.a.s";
  assert.ok(validar(p, m).apta);
  p.solicitud.proveedor_nombre = "Otro Proveedor";
  assert.deepEqual(validar(p, m).bloqueos.map((b) => b.codigo), ["RC1"]);
  p.solicitud.proveedor_nit = "901777888"; // Consultores Ágiles: activo = false
  assert.match(validar(p, m).bloqueos[0]!.detalle, /inactivo/);
});

test("RC2: sin aprobación o sin «Aprobado»; RC3: tope superado; RC4: subárea ajena; RC10: aritmética", async () => {
  const m = await maestros();
  const base = await paquete("sol-001");
  const sinAprob = clonar(base);
  sinAprob.aprobacion = null;
  assert.deepEqual(validar(sinAprob, m).bloqueos.map((b) => b.codigo), ["RC2"]);
  const noDice = clonar(base);
  noDice.aprobacion!.aprobado = false;
  assert.deepEqual(validar(noDice, m).bloqueos.map((b) => b.codigo), ["RC2"]);
  const tope = clonar(base);
  tope.solicitud.valor_total = 60_000_000;
  tope.solicitud.valor_unitario = 500_000; // 120 x 500.000 = 60.000.000 (RC10 ok)
  assert.deepEqual(validar(tope, m).bloqueos.map((b) => b.codigo), ["RC3"]);
  const sub = clonar(base);
  sub.solicitud.subarea = "Preventa";
  assert.deepEqual(validar(sub, m).bloqueos.map((b) => b.codigo), ["RC4"]);
  const ar = clonar(base);
  ar.solicitud.valor_total = 11_400_001;
  assert.ok(validar(ar, m).apta, "±1 unidad monetaria se tolera");
  ar.solicitud.valor_total = 11_400_002;
  assert.deepEqual(validar(ar, m).bloqueos.map((b) => b.codigo), ["RC10"]);
});

test("RC5 en el borde del 2 %, sin cotización y RC9 aprobación anterior", async () => {
  const m = await maestros();
  const base = await paquete("sol-001");
  const borde = clonar(base);
  borde.cotizacion!.total = 11_400_000 * 1.02;
  assert.ok(validar(borde, m).apta && validar(borde, m).confirmaciones.length === 0, "exactamente 2 % no excede");
  borde.cotizacion!.total = 11_400_000 * 1.0201;
  assert.deepEqual(validar(borde, m).confirmaciones.map((c) => c.codigo), ["RC5"]);
  const sin = clonar(base);
  sin.cotizacion = null;
  assert.deepEqual(validar(sin, m).confirmaciones.map((c) => c.codigo), ["RC5"]);
  const vieja = clonar(base);
  vieja.aprobacion!.fecha = "2026-08-19T10:00:00-05:00";
  assert.deepEqual(validar(vieja, m).confirmaciones.map((c) => c.codigo), ["RC9"]);
});

test("las reglas son un registro: RC1..RC10 en orden, con tipo", () => {
  assert.deepEqual(REGLAS.map((r) => r.codigo), ["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"]);
  assert.deepEqual(REGLAS.filter((r) => r.tipo === "bloqueo").map((r) => r.codigo), ["RC1", "RC2", "RC3", "RC4", "RC10"]);
});
