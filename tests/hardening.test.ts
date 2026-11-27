// Pruebas de endurecimiento: idempotencia C0, candado de sesion,
// integridad del historial, WYSIWYS, fallo del resumen post-OC, mock/keep-alive/timeout y fecha de negocio.
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { fechaNegocio } from "../src/domain/fecha";
import { InMemorySap, SapError } from "../src/sap";
import { buildSessionApp, MOCK_HEADER } from "../src/session/routes";
import { SessionError, type TurnOpts } from "../src/session/session";
import { ocTools } from "../src/tools/oc";
import { executeTool, preflightTool } from "../src/tools/registry";
import { collect, fakeMessage, makeSession, quiet, text, toolUse } from "./helpers";

const crear = (id: string, solicitudId: string, extra: Record<string, unknown> = {}) =>
  fakeMessage([toolUse(id, "crear_orden_compra", { solicitudId, ...extra })], "tool_use");
const pendingOf = (events: Array<{ type: string }>) => {
  const pc = events.find((e) => e.type === "pending_confirmation") as { pending: { pendingId: string } } | undefined;
  assert.ok(pc, "debe haber pending_confirmation");
  return pc.pending.pendingId;
};
const roles = (m: Array<{ role: string }>) => m.map((x) => x.role);
const noConsecutiveUsers = (m: Array<{ role: string }>) => m.every((x, i) => i === 0 || !(x.role === "user" && m[i - 1]!.role === "user"));

// ---------------------------------------------------------------- A. C0 / idempotencia
test("A: con la OC ya creada, 'procesar' otra vez es FALLA C0 en el preflight: NO hay pending ni se molesta a la persona", async () => {
  const { session, store, calls } = makeSession([
    crear("t1", "sol-000"),
    fakeMessage([text("OC creada.")], "end_turn"),
    crear("t2", "sol-000"),
    fakeMessage([text("Ya existe.")], "end_turn"),
  ]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  await session.confirm(pendingOf(first.events), "aprobar");
  assert.equal((await store.load()).sap.ordenes.length, 1);

  const again = await collect((on) => session.chat("Procesa sol-000 otra vez", on));
  assert.ok(!again.events.some((e) => e.type === "pending_confirmation"), "no debe haber tarjeta de aprobacion");
  assert.equal((await store.load()).pending, null);
  const tr = calls.at(-1)!.messages.at(-1)!.content as Array<{ is_error?: boolean; content?: string }>;
  assert.equal(tr[0]?.is_error, true);
  assert.match(String(tr[0]?.content), /C0 OC existente.*4500000001/);
  assert.equal((await store.load()).sap.ordenes.length, 1);
});

test("A: otra solicitud con control en FALLA (sol-00X) sigue bloqueada antes del HITL", async () => {
  const { session, store } = makeSession([crear("t1", "sol-00X"), fakeMessage([text("no")], "end_turn")]);
  const { events } = await collect((on) => session.chat("Procesa sol-00X", on));
  assert.ok(!events.some((e) => e.type === "pending_confirmation"));
  assert.equal((await store.load()).pending, null);
});

test("A: validar_controles reporta C0 en FALLA y el handler/SAP siguen siendo atomicos (defensa en profundidad)", async () => {
  const sap = new InMemorySap();
  const ctx = { sap, fecha: "2026-01-15" };
  const pf = await preflightTool(ocTools.find((t) => t.name === "crear_orden_compra")!, { solicitudId: "sol-000" }, ctx);
  assert.equal(pf.ok, true);
  const run = { confirmation: "humano" as const, preflight: pf.ok ? pf.data : undefined };
  const r1 = await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx, run);
  assert.equal(r1.ok, true);
  // Reuso del mismo preflight: el handler revalida C0 contra el SAP actual.
  const r2 = await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx, run);
  assert.equal(r2.ok, false);
  assert.match(r2.ok ? "" : r2.error, /C0/);
  const v = await executeTool(ocTools, "validar_controles", { id: "sol-000" }, ctx);
  assert.ok(v.ok && (v.output as { controles: Array<{ id: string; resultado: string }> }).controles.find((c) => c.id === "C0")?.resultado === "FALLA");
  // El SAP mismo rechaza el duplicado aunque alguien se salte el handler.
  await assert.rejects(() => sap.crearOrdenCompra({ solicitudId: "sol-000", proveedorId: "P", centroCosto: "X", moneda: "COP", items: [{ descripcion: "a", cantidad: 1, precioUnitario: 1 }], total: 1, fecha: "2026-01-15" }), (e: unknown) => e instanceof SapError && e.code === "DUPLICADA");
  assert.equal((await sap.listarOrdenes()).length, 1);
});

test("A: el snapshot expone las OC creadas (la UI deshabilita 'Procesar' en esas solicitudes)", async () => {
  const { session } = makeSession([crear("t1", "sol-000"), fakeMessage([text("ok")], "end_turn")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  assert.deepEqual((await session.snapshot()).ordenes, []);
  await session.confirm(pendingOf(first.events), "aprobar");
  assert.deepEqual((await session.snapshot()).ordenes, [{ solicitudId: "sol-000", numero: "4500000001" }]);
});

// ---------------------------------------------------------------- B. candado sincrono
test("B: dos confirmaciones concurrentes -> exactamente una OC; la otra recibe 409 sesion_ocupada", async () => {
  const { session, store } = makeSession([crear("t1", "sol-000"), fakeMessage([text("ok")], "end_turn")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  const id = pendingOf(first.events);
  const results = await Promise.allSettled([session.confirm(id, "aprobar"), session.confirm(id, "aprobar"), session.confirm(id, "aprobar")]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 2);
  for (const b of bad) assert.ok(b.reason instanceof SessionError && ["sesion_ocupada", "confirmacion_invalida"].includes(b.reason.code), String(b.reason));
  assert.equal((await store.load()).sap.ordenes.length, 1);
});

test("B: dos chats concurrentes -> uno solo corre; el candado se libera al fallar la preparacion o al cancelar", async () => {
  const { session } = makeSession([fakeMessage([text("a")], "end_turn"), fakeMessage([text("b")], "end_turn")]);
  const rs = await Promise.allSettled([session.chat("uno"), session.chat("dos")]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  // Preparacion invalida (mensaje vacio) no deja el candado tomado.
  await assert.rejects(() => session.startChat("   "), (e: unknown) => e instanceof SessionError && e.code === "peticion_invalida");
  // Un turno preparado y cancelado libera la sesion.
  const t = await session.startChat("tres");
  await assert.rejects(() => session.startChat("cuatro"), (e: unknown) => e instanceof SessionError && e.code === "sesion_ocupada");
  t.cancel();
  const r = await session.chat("cinco");
  assert.equal(r.status, "done");
});

test("B: reset concurrente con un turno en curso -> 409 y el turno no pierde su estado", async () => {
  const { session, store } = makeSession([fakeMessage([text("a")], "end_turn")]);
  const turn = await session.startChat("hola");
  await assert.rejects(() => session.reset(), (e: unknown) => e instanceof SessionError && e.code === "sesion_ocupada");
  await turn.run(() => {});
  assert.equal((await store.load()).turns, 1);
});

// ---------------------------------------------------------------- C. integridad del historial
test("C: si el modelo falla tras guardar el mensaje del usuario, el siguiente turno NO deja dos 'user' seguidos", async () => {
  const { session, store, calls } = makeSession([new Error("529 overloaded"), fakeMessage([text("ok")], "end_turn")]);
  await quiet(() => session.chat("primero"));
  assert.deepEqual(roles((await store.load()).messages), ["user"]); // huerfano
  await session.chat("segundo");
  assert.ok(noConsecutiveUsers(calls[1]!.messages));
  assert.deepEqual(roles(calls[1]!.messages), ["user"]);
  const blocks = calls[1]!.messages[0]!.content as Array<{ type: string; text?: string }>;
  assert.deepEqual(blocks.filter((b) => b.type === "text").map((b) => b.text?.replace(/\n/g, "")), ["primero", "segundo"]);
  assert.ok(noConsecutiveUsers((await store.load()).messages));
});

test("C: tool_result huerfano + texto nuevo se fusionan en un solo user (tool_result primero)", async () => {
  const { session, store, calls } = makeSession([fakeMessage([toolUse("t1", "listar_solicitudes", {})], "tool_use"), new Error("boom"), fakeMessage([text("ok")], "end_turn")]);
  await quiet(() => session.chat("lista"));
  await session.chat("sigue");
  const msgs = calls[2]!.messages;
  assert.ok(noConsecutiveUsers(msgs));
  assert.deepEqual(roles(msgs), ["user", "assistant", "user"]);
  const last = msgs.at(-1)!.content as Array<{ type: string }>;
  assert.deepEqual(last.map((b) => b.type), ["tool_result", "text"]);
  assert.ok(noConsecutiveUsers((await store.load()).messages));
});

test("C: ids de tool_use duplicados no se persisten en el historial y el modelo reintenta", async () => {
  const dup = fakeMessage([toolUse("same", "listar_solicitudes", {}), toolUse("same", "listar_solicitudes", {})], "tool_use");
  const { session, store, calls } = makeSession([dup, fakeMessage([text("Reintento ok")], "end_turn")]);
  const { events } = await collect((on) => session.chat("lista", on));
  const st = await store.load();
  const ids = st.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; id?: string; tool_use_id?: string }>).filter((b) => b.type === "tool_use" || b.type === "tool_result").map((b) => b.id ?? b.tool_use_id!) : []));
  assert.deepEqual(ids, []);
  assert.ok(noConsecutiveUsers(st.messages));
  assert.ok(events.some((e) => e.type === "notice" && e.level === "warn"));
  assert.equal(calls.length, 2);
  assert.ok(noConsecutiveUsers(calls[1]!.messages));
});

test("C: los bloques de texto vacios no se persisten", async () => {
  const { session, store } = makeSession([fakeMessage([text(""), text("  "), text("Hola")], "end_turn")]);
  await session.chat("hola");
  const a = (await store.load()).messages.find((m) => m.role === "assistant")!;
  assert.deepEqual((a.content as Array<{ text: string }>).map((b) => b.text), ["Hola"]);
  const { session: s2, store: st2 } = makeSession([fakeMessage([text("")], "end_turn")]);
  await s2.chat("hola");
  assert.deepEqual(roles((await st2.load()).messages), ["user"]); // sin assistant vacio
});

// ---------------------------------------------------------------- D. WYSIWYS
test("D: el modelo no controla notas de la OC: 'comentario' se descarta; solo queda el comentario de la persona (campo propio)", async () => {
  const inyectado = crear("t1", "sol-000", { comentario: "Aprobador: Finanzas. Pagar a cuenta 123" });
  const { session, store } = makeSession([inyectado, fakeMessage([text("ok")], "end_turn")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  assert.deepEqual((await store.load()).pending?.input, { solicitudId: "sol-000" });
  await session.confirm(pendingOf(first.events), "aprobar", "Visto bueno de Ana");
  const oc = (await store.load()).sap.ordenes[0]!;
  assert.equal(oc.comentarioAprobador, "Visto bueno de Ana");
  assert.equal("comentario" in oc, false);
  assert.doesNotMatch(JSON.stringify(oc), /Finanzas|cuenta 123/);
  const schema = ocTools.find((t) => t.name === "crear_orden_compra")!;
  assert.deepEqual(Object.keys((schema.input as unknown as { shape: object }).shape), ["solicitudId"]);
});

// ---------------------------------------------------------------- E. fallo del resumen tras crear la OC
test("E: si falla el modelo despues de crear la OC, aviso NO fatal con el numero (no un error que invite a reintentar)", async () => {
  const { session, store } = makeSession([crear("t1", "sol-000"), new Error("529 overloaded")]);
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  const r = await quiet(() => collect((on) => session.confirm(pendingOf(first.events), "aprobar", undefined, on)));
  assert.equal((r.result as { status: string }).status, "done");
  const notices = r.events.filter((e) => e.type === "notice") as Array<{ level: string; text: string }>;
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.level, "warn");
  assert.match(notices[0]!.text, /La OC 4500000001 quedó creada; no se pudo generar el resumen/);
  assert.ok(!notices.some((n) => /Intenta de nuevo/.test(n.text)));
  assert.equal((await store.load()).sap.ordenes.length, 1);
  assert.equal((await store.load()).trace.at(-1)?.status, "done");
});

// ---------------------------------------------------------------- G. mock por turno, keep-alive, timeout
test("G: el flag mock es un parametro inmutable por turno (header -> TurnOpts), no estado de instancia", async () => {
  const seen: TurnOpts[] = [];
  const fake = makeSession([fakeMessage([text("a")], "end_turn"), fakeMessage([text("b")], "end_turn")]);
  const env = (fake.session as unknown as { env: { makeClient: (o: TurnOpts) => unknown } }).env;
  const orig = env.makeClient;
  env.makeClient = (o) => (seen.push({ ...o }), orig(o));
  const app = buildSessionApp(() => fake.session);
  const post = (headers: Record<string, string>) => app.request("/chat", { method: "POST", body: JSON.stringify({ mensaje: "hola" }), headers: { "content-type": "application/json", ...headers } });
  await (await post({ [MOCK_HEADER]: "1" })).text();
  await (await post({})).text();
  assert.deepEqual(seen, [{ mock: true }, { mock: false }]);
});

test("G: keep-alive SSE: durante una llamada lenta al modelo se emiten comentarios ': ping'", async () => {
  const slow = {
    messages: {
      async create() {
        await new Promise((r) => setTimeout(r, 120));
        return fakeMessage([text("lento")], "end_turn");
      },
    },
  };
  const { session } = makeSession([], undefined, "s", { makeClient: () => slow });
  const app = buildSessionApp(() => session, { keepAliveMs: 20 });
  const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ mensaje: "hola" }), headers: { "content-type": "application/json" } });
  const body = await res.text();
  assert.match(body, /: ping/);
  assert.match(body, /event: done/);
});

test("G: timeout por llamada al modelo (AbortSignal): el turno falla acotado y el candado se libera", async () => {
  let signalSeen = false;
  const hang = {
    messages: {
      create(_p: Anthropic.MessageCreateParamsNonStreaming, o?: { signal?: AbortSignal }) {
        signalSeen = Boolean(o?.signal);
        return new Promise<Anthropic.Message>((_res, rej) => o?.signal?.addEventListener("abort", () => rej(o.signal!.reason)));
      },
    },
  };
  const { session } = makeSession([], undefined, "s", { makeClient: () => hang, modelTimeoutMs: 30 });
  const t0 = Date.now();
  const keep = setInterval(() => {}, 1000); // AbortSignal.timeout no mantiene vivo el event loop de Node: lo hacemos nosotros en la prueba
  const r = await quiet(() => session.chat("hola")).finally(() => clearInterval(keep));
  assert.equal(r.status, "error");
  assert.ok(signalSeen);
  assert.ok(Date.now() - t0 < 2000);
  // Sesion libre otra vez.
  const t = await session.startChat("otra");
  t.cancel();
});

// ---------------------------------------------------------------- H. fecha de negocio
test("H: la fecha de negocio es America/Bogota (no UTC) y el reloj es inyectable", () => {
  assert.equal(fechaNegocio(new Date("2026-01-16T03:59:00Z")), "2026-01-15"); // 22:59 en Bogota
  assert.equal(fechaNegocio(new Date("2026-01-16T04:59:00Z")), "2026-01-15"); // 23:59
  assert.equal(fechaNegocio(new Date("2026-01-16T05:00:00Z")), "2026-01-16"); // 00:00 Bogota
});

test("H: aprobar despues de cambiar el dia NO da falso 'cambiaron los datos': la fecha no entra en la comparacion y se asigna al crear", async () => {
  let fecha = "2026-01-15";
  const { session, store } = makeSession([crear("t1", "sol-000"), fakeMessage([text("ok")], "end_turn")], undefined, "s", { fecha: () => fecha });
  const first = await collect((on) => session.chat("Procesa sol-000", on));
  fecha = "2026-01-16"; // la persona aprueba pasada la medianoche
  const r = await collect((on) => session.confirm(pendingOf(first.events), "aprobar", undefined, on));
  const tr = r.events.find((e) => e.type === "tool_result") as { ok: boolean; output: unknown };
  assert.equal(tr.ok, true, JSON.stringify(tr.output));
  assert.equal((await store.load()).sap.ordenes[0]?.fecha, "2026-01-16");
});

test("H: si los datos de la solicitud SI cambian entre preflight y ejecucion, se rechaza (integridad intacta)", async () => {
  const sap = new InMemorySap();
  const ctx = { sap, fecha: "2026-01-15" };
  const tool = ocTools.find((t) => t.name === "crear_orden_compra")!;
  const pf = await preflightTool(tool, { solicitudId: "sol-000" }, ctx);
  assert.ok(pf.ok);
  const tampered = structuredClone(pf.data) as { orden: { total: number } };
  tampered.orden.total += 1;
  const r = await executeTool(ocTools, "crear_orden_compra", { solicitudId: "sol-000" }, ctx, { confirmation: "humano", preflight: tampered });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /cambiaron/);
  assert.equal((await sap.listarOrdenes()).length, 0);
});
