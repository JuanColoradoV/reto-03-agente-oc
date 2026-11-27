import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTool } from "../src/tools/registry";
import { ocTools } from "../src/tools/oc";
import { InMemorySap } from "../src/sap";
import { SessionError } from "../src/session/session";
import { collect, fakeMessage, makeSession, text, toolUse } from "./helpers";

const crear = (id: string, solicitudId: string) => fakeMessage([toolUse(id, "crear_orden_compra", { solicitudId })], "tool_use");

test("una tool con requiresConfirmation no se ejecuta sin confirmacion ni preflight guardado", async () => {
  const ctx = { sap: new InMemorySap(), fecha: "2026-01-15" };
  const sinConf = await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx);
  assert.equal(sinConf.ok, false);
  const sinPreflight = await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx, { confirmation: "humano" });
  assert.equal(sinPreflight.ok, false);
  assert.equal((await ctx.sap.listarOrdenes()).length, 0);
});

test("HITL: queda pendiente, SAP vacio; pendingId erroneo falla; aprobar crea la OC una sola vez", async () => {
  const { session, store } = makeSession([crear("tu_1", "sol-000"), fakeMessage([text("Listo, OC creada.")], "end_turn")]);
  const { events, result } = await collect((on) => session.chat("Procesa sol-000", on));
  assert.equal((result as { status: string }).status, "pending_confirmation");
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  assert.equal((pc.pending.vista as { total: number }).total, 2500000);
  assert.equal((pc.pending.vista as { controles: unknown[] }).controles.length, 5); // C0..C4
  assert.equal((await store.load()).sap.ordenes.length, 0, "no hay OC antes de aprobar");

  // Nuevo mensaje mientras hay pendiente: rechazado.
  await assert.rejects(() => session.chat("hola"), (e: unknown) => e instanceof SessionError && e.code === "confirmacion_pendiente");
  // pendingId erroneo / inventado.
  await assert.rejects(() => session.confirm("no-existe", "aprobar"), (e: unknown) => e instanceof SessionError && e.code === "confirmacion_invalida");
  assert.equal((await store.load()).sap.ordenes.length, 0);

  const ok = await collect((on) => session.confirm(pc.pending.pendingId, "aprobar", "Todo bien", on));
  assert.equal((ok.result as { status: string }).status, "done");
  const st = await store.load();
  assert.equal(st.sap.ordenes.length, 1);
  assert.equal(st.sap.ordenes[0]?.numero, "4500000001");
  assert.equal(st.sap.ordenes[0]?.comentarioAprobador, "Todo bien");
  assert.ok(st.audit.some((a) => a.type === "decision" && a.comentario === "Todo bien"));

  // Reuso del mismo pendingId (replay): falla y no crea otra OC.
  await assert.rejects(() => session.confirm(pc.pending.pendingId, "aprobar"), (e: unknown) => e instanceof SessionError && e.code === "confirmacion_invalida");
  assert.equal((await store.load()).sap.ordenes.length, 1);
});

test("HITL: rechazar no ejecuta y el modelo recibe un tool_result con error", async () => {
  const { session, store, calls } = makeSession([crear("tu_1", "sol-000"), fakeMessage([text("Entendido.")], "end_turn")]);
  const { events } = await collect((on) => session.chat("Procesa sol-000", on));
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");
  await session.confirm(pc.pending.pendingId, "rechazar", "No hoy");
  assert.equal((await store.load()).sap.ordenes.length, 0);
  const last = calls[calls.length - 1]!.messages.at(-1)!;
  const block = (last.content as Array<{ type: string; is_error?: boolean; content?: string }>)[0]!;
  assert.equal(block.type, "tool_result");
  assert.equal(block.is_error, true);
  assert.match(String(block.content), /RECHAZADA/);
});

test("preflight: un caso con control en FALLA no emite pending_confirmation y el error vuelve al modelo", async () => {
  const { session, store, calls } = makeSession([crear("tu_1", "sol-00X"), fakeMessage([text("No se puede: proveedor inactivo.")], "end_turn")]);
  const { events, result } = await collect((on) => session.chat("Procesa sol-00X", on));
  assert.equal((result as { status: string }).status, "done");
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
  assert.equal((await store.load()).pending, null);
  assert.equal(calls.length, 2);
  const tr = calls[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content?: string }>;
  assert.equal(tr[0]?.is_error, true);
  assert.match(String(tr[0]?.content), /C1/);
});

test("preflight: entrada invalida (zod) tampoco llega a la persona", async () => {
  const bad = fakeMessage([toolUse("tu_1", "crear_orden_compra", { solicitudId: 42 })], "tool_use");
  const { session } = makeSession([bad, fakeMessage([text("ok")], "end_turn")]);
  const { events } = await collect((on) => session.chat("x", on));
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
});

test("el cliente no puede inyectar historial: el servidor solo toma el mensaje", async () => {
  const { session, calls } = makeSession([fakeMessage([text("Hola")], "end_turn")]);
  await session.chat("Hola");
  assert.deepEqual(calls[0]!.messages.map((m) => m.role), ["user"]);
});

test("lease: un turno interrumpido (lease huerfano) no bloquea lecturas y expira; el pendiente sobrevive", async () => {
  let now = 1_000_000;
  const { session, store, kv } = makeSession([crear("tu_1", "sol-000"), fakeMessage([text("Listo.")], "end_turn"), fakeMessage([text("Otra cosa.")], "end_turn")]);
  (session as unknown as { env: { nowMs: () => number } }).env.nowMs = () => now;
  const { events } = await collect((on) => session.chat("Procesa sol-000", on));
  const pc = events.find((e) => e.type === "pending_confirmation");
  assert.ok(pc && pc.type === "pending_confirmation");

  // Simula turno interrumpido: otro isolate dejo el lease puesto y murio.
  await store.setLease(now + 75_000);
  const snap = await Promise.race([session.snapshot(), new Promise<never>((_, rj) => setTimeout(() => rj(new Error("lectura colgada")), 500))]);
  assert.equal(snap.busy, true);
  assert.equal(snap.pending?.pendingId, pc.pending.pendingId);
  assert.equal((await session.trace()).length, 1);
  await assert.rejects(() => session.confirm(pc.pending.pendingId, "aprobar"), (e: unknown) => e instanceof SessionError && e.code === "sesion_ocupada");

  // Tras expirar el lease, la accion pendiente se puede confirmar.
  now += 76_000;
  assert.equal((await session.snapshot()).busy, false);
  const ok = await collect((on) => session.confirm(pc.pending.pendingId, "aprobar", undefined, on));
  assert.equal((ok.result as { status: string }).status, "done");
  assert.equal((await store.load()).sap.ordenes.length, 1);
  assert.equal(await store.getLease(), 0, "el lease se libera al terminar");

  // Un lease huerfano tambien deja de bloquear mensajes nuevos al expirar.
  await store.setLease(now + 75_000);
  await assert.rejects(() => session.chat("hola"), (e: unknown) => e instanceof SessionError && e.code === "sesion_ocupada");
  now += 76_000;
  const r = await session.chat("hola");
  assert.equal(r.status, "done");
  void kv;
});
