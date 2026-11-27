import assert from "node:assert/strict";
import { test } from "node:test";
import type { UiEvent } from "../src/agent/events";
import { compactEvent, recortarAuditoria } from "../src/session/session";

test("compactEvent: un output estructurado grande conserva su forma (controles sigue siendo un arreglo) y solo se recortan los textos largos", () => {
  const controles = Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, resultado: i === 1 ? "FALLA" : "OK", detalle: "x".repeat(2500) }));
  const e = { type: "tool_result", id: "1", name: "validar_controles", ok: true, ms: 1, output: { controles, aprobable: false } } as unknown as UiEvent;
  const c = compactEvent(e) as { output: { controles: { id: string; resultado: string; detalle: string }[]; aprobable: boolean } };
  assert.equal(typeof c.output, "object");
  assert.equal(c.output.aprobable, false);
  assert.equal(c.output.controles.length, 5);
  assert.equal(c.output.controles[1]!.resultado, "FALLA");
  assert.match(c.output.controles[0]!.detalle, /\[truncado\]$/);
  assert.ok(c.output.controles[0]!.detalle.length < 2000);
});

test("compactEvent: salidas pequenas intactas; cadenas enormes se truncan", () => {
  const chico = { type: "tool_result", id: "1", name: "x", ok: true, ms: 1, output: { a: 1 } } as unknown as UiEvent;
  assert.equal(compactEvent(chico), chico);
  const texto = { ...chico, output: "y".repeat(9000) } as unknown as UiEvent;
  assert.match(String((compactEvent(texto) as { output: string }).output), /\[truncado\]$/);
});

test("recortarAuditoria: descarta primero los mensajes viejos y conserva decisiones, OC y pendientes", () => {
  const audit = [
    { ts: "1", type: "decision", pendingId: "p1" },
    ...Array.from({ length: 10 }, (_, i) => ({ ts: String(i + 2), type: "mensaje" })),
    { ts: "20", type: "tool_ejecutada", pendingId: "p1" },
  ] as never[];
  recortarAuditoria(audit, 5);
  assert.equal(audit.length, 5);
  const tipos = audit.map((a: { type: string }) => a.type);
  assert.ok(tipos.includes("decision") && tipos.includes("tool_ejecutada"));
  assert.equal(tipos.filter((t: string) => t === "mensaje").length, 3);
});
