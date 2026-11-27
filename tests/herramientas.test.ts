import assert from "node:assert/strict";
import { test } from "node:test";
import { OrdenCompraSchema } from "../src/domain/tipos";
import { sha256Hex } from "../src/domain/util";
import * as oc from "../src/tools/oc";
import { herramientas } from "../src/tools/registry";
import { ctxMemoria, llamar } from "./helpers";

test("contrato §6.2: oc_<export>, description, args con .describe, execute(args, ctx)", () => {
  assert.deepEqual(herramientas.map((h) => h.nombre).sort(), ["oc_construir_payload", "oc_crear", "oc_generar_evidencia", "oc_leer_paquete", "oc_validar"]);
  for (const h of herramientas) {
    assert.ok(h.description.length > 20);
    for (const [k, schema] of Object.entries(h.args)) assert.ok((schema as { description?: string }).description, `${h.nombre}.${k} sin describe`);
  }
  assert.equal(Object.keys(oc).length, 5);
});

test("las herramientas nunca lanzan: argumentos inválidos, herramienta o caso desconocidos", async () => {
  const ctx = ctxMemoria();
  assert.equal((await llamar("oc_validar", {}, ctx)).ok, false);
  assert.equal((await llamar("oc_inexistente", {}, ctx)).ok, false);
  assert.equal((await llamar("oc_leer_paquete", { caso: "../../etc/passwd" }, ctx)).ok, false);
  const direct = JSON.parse(await oc.crear.execute({ caso: "sol-999" }, ctx)) as { ok: boolean };
  assert.equal(direct.ok, false);
});

test("sol-001 se crea sin intervención humana; repetirla es idempotente y no consume otro número", async () => {
  const ctx = ctxMemoria();
  const a = await llamar("oc_crear", { caso: "sol-001" }, ctx);
  assert.ok(a.ok);
  assert.equal(a.data!.numero_oc, "4500000001");
  assert.equal(a.data!.idempotente, false);
  const b = await llamar("oc_crear", { caso: "sol-001" }, ctx);
  assert.equal(b.data!.numero_oc, "4500000001");
  assert.equal(b.data!.idempotente, true);
  const c = await llamar("oc_crear", { caso: "sol-005", confirmado: true }, { ...ctx, confirmadoPor: "ana", confirmadoCaso: "sol-005" });
  assert.equal(c.data!.numero_oc, "4500000002");
});

test("bloqueos (sol-002, sol-003) nunca crean, ni con confirmado ni con confirmación humana; devuelven acción sugerida", async () => {
  const ctx = ctxMemoria({ confirmadoPor: "ana" });
  for (const [caso, cod] of [["sol-002", "RC1"], ["sol-003", "RC2"]]) {
    const r = await llamar("oc_crear", { caso, confirmado: true }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.bloqueos!.some((b) => b.codigo === cod));
    assert.match(JSON.stringify(r), /acciones_sugeridas/);
  }
  assert.equal(await ctx.store.leer("sap/ordenes.jsonl"), null);
});

test("confirmaciones: sin confirmación humana del servidor, confirmado=true del modelo NO crea; con ella, sí, y queda confirmado_por", async () => {
  const ctx = ctxMemoria();
  const sin = await llamar("oc_crear", { caso: "sol-004" }, ctx);
  assert.equal(sin.pendiente, true);
  assert.deepEqual(sin.confirmaciones!.map((c) => c.codigo), ["RC5"]);
  const modelo = await llamar("oc_crear", { caso: "sol-004", confirmado: true }, ctx);
  assert.equal(modelo.ok, false);
  const otroCaso = await llamar("oc_crear", { caso: "sol-004", confirmado: true }, { ...ctx, confirmadoPor: "ana", confirmadoCaso: "sol-005" });
  assert.equal(otroCaso.ok, false, "la confirmación de otro caso no vale");
  const sinFlag = await llamar("oc_crear", { caso: "sol-004" }, { ...ctx, confirmadoPor: "ana" });
  assert.equal(sinFlag.ok, false, "la confirmación humana sola no basta: el modelo debe pedir confirmado=true");
  const ok = await llamar("oc_crear", { caso: "sol-004", confirmado: true }, { ...ctx, confirmadoPor: "usuario (chat)", confirmadoCaso: "sol-004" });
  assert.ok(ok.ok);
  const orden = JSON.parse((await ctx.store.leer("sap/ordenes.jsonl"))!.trim()) as { orden: { excepciones: { codigo: string; confirmado_por: string }[] } };
  assert.deepEqual(orden.orden.excepciones.map((e) => [e.codigo, e.confirmado_por]), [["RC5", "usuario (chat)"]]);
});

test("el servidor es la fuente de verdad: un payload con monto alterado se rechaza; el idéntico se acepta", async () => {
  const ctx = ctxMemoria();
  const p = await llamar("oc_construir_payload", { caso: "sol-001" }, ctx);
  assert.ok(p.ok);
  const payload = p.data!.payload as { posiciones: { precio_unitario: number }[] };
  assert.ok(OrdenCompraSchema.safeParse(payload).success);
  const alterado = structuredClone(payload);
  alterado.posiciones[0]!.precio_unitario = 1;
  const mal = await llamar("oc_crear", { caso: "sol-001", payload: alterado }, ctx);
  assert.equal(mal.ok, false);
  assert.match(mal.error!, /no coincide/);
  assert.equal(await ctx.store.leer("sap/ordenes.jsonl"), null);
  assert.ok((await llamar("oc_crear", { caso: "sol-001", payload }, ctx)).ok);
});

test("payload: sociedad 1000, posiciones 10, texto breve ≤ 40, derivados de sol-006 y trazabilidad por campo", async () => {
  const ctx = ctxMemoria();
  const r = await llamar("oc_construir_payload", { caso: "sol-006" }, ctx);
  const o = r.data!.payload as { sociedad: string; organizacion_compras: string; condiciones_pago: string; posiciones: { numero: number; descripcion: string; indicador_iva: string; unidad: string }[]; excepciones: { codigo: string; confirmado_por: string | null }[] };
  assert.equal(o.sociedad, "1000");
  assert.equal(o.posiciones[0]!.numero, 10);
  assert.ok(o.posiciones[0]!.descripcion.length <= 40);
  assert.equal(o.posiciones[0]!.indicador_iva, "C1");
  assert.equal(o.condiciones_pago, "Z030");
  assert.deepEqual(o.excepciones.map((e) => [e.codigo, e.confirmado_por]), [["RC6", null]]);
  const traza = JSON.parse((await ctx.store.leer("sol-006/trazabilidad.json"))!) as { campos: { campo: string; fuente: string }[] };
  const f = (c: string) => traza.campos.find((x) => x.campo === c)!.fuente;
  assert.equal(f("proveedor.codigo_sap"), "maestro.proveedores");
  assert.equal(f("posiciones[0].indicador_iva"), "derivado");
  assert.equal(f("posiciones[0].cantidad"), "solicitud");
  assert.equal(f("referencia.cotizacion_ref"), "cotizacion");
  const h4 = await llamar("oc_construir_payload", { caso: "sol-004" }, ctx);
  assert.equal((h4.data!.payload as { posiciones: { unidad: string }[] }).posiciones[0]!.unidad, "H");
  assert.equal((await llamar("oc_construir_payload", { caso: "sol-002" }, ctx)).ok, false);
});

test("evidencia: txt con encabezados, cuerpo y sha256 = hash del contenido; pdf válido; coincide con el payload", async () => {
  const ctx = ctxMemoria();
  const e = await llamar("oc_generar_evidencia", { caso: "sol-004" }, ctx);
  assert.ok(e.ok);
  const txt = (await ctx.store.leer("sol-004/aprobacion.txt"))!;
  for (const h of ["De: ", "Para: ", "Fecha: ", "Asunto: ", "Aprobado por 25 millones", `sha256: ${e.data!.sha256}`]) assert.ok(txt.includes(h), h);
  assert.equal(await sha256Hex(txt.split("\n---\n")[0]!), e.data!.sha256);
  const pdf = (await ctx.store.leerBytes("sol-004/aprobacion.pdf"))!;
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), "%PDF-");
  const p = await llamar("oc_construir_payload", { caso: "sol-004" }, ctx);
  assert.equal((p.data!.payload as { aprobador: { evidencia_sha256: string } }).aprobador.evidencia_sha256, e.data!.sha256);
});

test("control.csv: una fila por intento con retroactiva; log.jsonl registra cada llamada", async () => {
  const ctx = ctxMemoria();
  await llamar("oc_crear", { caso: "sol-005" }, ctx);
  await llamar("oc_crear", { caso: "sol-005", confirmado: true }, { ...ctx, confirmadoPor: "ana" });
  await llamar("oc_crear", { caso: "sol-002" }, ctx);
  const filas = (await ctx.store.leer("control.csv"))!.trim().split("\n");
  assert.equal(filas[0], "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts");
  assert.deepEqual(filas.slice(1).map((f) => f.split(",").slice(0, 6).join(",")), ["SOL-2026-005,pendiente,,true,,RC8", "SOL-2026-005,creada,4500000001,true,,RC8", "SOL-2026-002,bloqueada,,false,RC1,"]);
  const log = (await ctx.store.leer("log.jsonl"))!.trim().split("\n").map((l) => JSON.parse(l) as { herramienta: string; ok: boolean });
  assert.equal(log.length, 3);
  assert.equal(log[0]!.herramienta, "oc_crear");
});

test("SAP simulado persiste por store: consultarProveedor y buscarOrdenPorReferencia", async () => {
  const { SapMock } = await import("../src/sap/mock");
  const ctx = ctxMemoria();
  const sap = new SapMock(ctx.store, [{ codigo_sap: "1", nit: "9", nombre: "x", condiciones_pago_default: "Z000", indicador_iva_default: "C1", activo: true }]);
  assert.deepEqual(await sap.consultarProveedor("9"), { codigo_sap: "1", activo: true });
  assert.equal(await sap.consultarProveedor("0"), null);
  assert.equal(await sap.buscarOrdenPorReferencia("X"), null);
});
