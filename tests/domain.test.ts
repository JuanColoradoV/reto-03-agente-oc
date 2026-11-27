import assert from "node:assert/strict";
import { test } from "node:test";
import { cargarCaso, cargarMaestros } from "../src/domain/casos";
import { CONTROLES, matrizMarkdown } from "../src/domain/controles";
import { toMinor, totalMinor } from "../src/domain/dinero";
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
  const ok = prepararOrden(cargarCaso("sol-000"), m, "2026-01-15");
  assert.equal(ok.bloqueante, false);
  assert.equal(ok.orden?.total, 2500000);
  assert.equal(ok.orden?.proveedorId, "P-0001");
  const bad = prepararOrden(cargarCaso("sol-00X"), m, "2026-01-15");
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
