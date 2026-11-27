import assert from "node:assert/strict";
import { test } from "node:test";
import { cargarCaso, cargarMaestros, validarFixture } from "../src/domain/casos";
import { prepararOrden } from "../src/domain/ordenes";
import type { CasoSolicitud } from "../src/domain/types";
import { z } from "zod";

test("los fixtures reales pasan la validacion de forma al cargarlos", () => {
  assert.equal(cargarCaso("sol-000").solicitud.id, "sol-000");
  assert.ok(cargarMaestros().proveedores.length > 0);
});

test("fixture corrupto: error claro con la ruta y el campo (no un TypeError mas adelante)", () => {
  const schema = z.object({ items: z.array(z.object({ cantidad: z.number() })) });
  assert.throws(() => validarFixture(schema, "solicitudes/sol-9/solicitud.json", { items: [{ cantidad: "5" }] }), /Fixture inválido \(solicitudes\/sol-9\/solicitud\.json\): items\.0\.cantidad/);
});

const base = (): CasoSolicitud => structuredClone(cargarCaso("sol-000"));
const preparar = (c: CasoSolicitud) => prepararOrden(c, cargarMaestros(), "2026-01-15", { ordenes: [] });

test("invariantes en prepararOrden: sin lineas, campos vacios o importes invalidos => FALLA bloqueante V0 y no hay orden", () => {
  assert.ok(preparar(base()).orden, "el caso sano sigue pasando");
  const casos: Array<[string, (c: CasoSolicitud) => void, RegExp]> = [
    ["sin lineas", (c) => { c.solicitud.items = []; }, /no tiene líneas/],
    ["centro de costo vacio", (c) => { c.solicitud.centroCosto = " "; }, /centro de costo/],
    ["moneda vacia", (c) => { c.solicitud.moneda = ""; }, /moneda/],
    ["proveedor vacio", (c) => { c.solicitud.proveedorId = ""; }, /proveedor/],
    ["cantidad cero", (c) => { c.solicitud.items[0]!.cantidad = 0; }, /cantidad/],
    ["precio negativo", (c) => { c.solicitud.items[0]!.precioUnitario = -5; }, /precio/],
    ["descripcion vacia", (c) => { c.solicitud.items[0]!.descripcion = " "; }, /descripción/],
  ];
  for (const [nombre, mutar, re] of casos) {
    const c = base();
    mutar(c);
    const r = preparar(c);
    assert.equal(r.orden, null, nombre);
    const v0 = r.controles.find((x) => x.id === "V0");
    assert.ok(v0 && v0.resultado === "FALLA" && v0.severidad === "bloqueante", nombre);
    assert.match(v0!.detalle, re, nombre);
  }
});
