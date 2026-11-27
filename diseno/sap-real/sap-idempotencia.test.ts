import assert from "node:assert/strict";
import { test } from "node:test";
import { SapError } from "../../src/sap/adapter";
import { MemorySolicitudStore } from "./idempotencia";
import { S4HanaSap } from "./s4hana";

const input = { solicitudId: "sol-1", proveedorId: "P-1", centroCosto: "CC-1", moneda: "COP", items: [{ descripcion: "Silla", cantidad: 2, precioUnitario: 100 }], total: 200, fecha: "2026-01-15" };

/** SAP falso (OData V4): GET raiz => CSRF; GET filtro => lo que haya "visible"; POST => segun `post`. */
function fakeSap(opts: { post?: () => Response | Promise<Response> } = {}) {
  const st = { posts: 0, visible: null as Record<string, unknown> | null };
  const oc = { PurchaseOrder: "4500000001", CorrespncExternalReference: "sol-1", Supplier: "P-1", DocumentCurrency: "COP", PurchaseOrderDate: "2026-01-15", _PurchaseOrderItem: [{ PurchaseOrderItemText: "Silla", OrderQuantity: "2", NetPriceAmount: "100.00", _PurOrdAccountAssignment: [{ CostCenter: "CC-1" }] }] };
  const f: typeof fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/svc/")) return new Response("{}", { headers: { "x-csrf-token": "tok" } });
    if (method === "GET") return Response.json({ value: st.visible ? [st.visible] : [] });
    st.posts++;
    return (opts.post ?? (() => Response.json(oc, { status: 201 })))();
  };
  return { st, oc, f };
}
const mk = (sap: ReturnType<typeof fakeSap>, extra: Record<string, unknown> = {}) => {
  const store = new MemorySolicitudStore();
  const adapter = new S4HanaSap({ baseUrl: "https://sap.test/svc", getToken: async () => "t", companyCode: "1000", purchasingOrganization: "1000", purchasingGroup: "001", plant: "1000", store, fetch: sap.f, sleep: async () => {}, ...extra });
  return { adapter, store };
};
const netFail = () => {
  throw new TypeError("fetch failed");
};

test("payload V4: usa PurchaseOrderType (no PurchasingDocumentType) y la referencia externa", () => {
  const { adapter } = mk(fakeSap());
  const p = adapter.toPayload(input);
  assert.equal(p.PurchaseOrderType, "NB");
  assert.equal("PurchasingDocumentType" in p, false);
  assert.equal(p.CorrespncExternalReference, "sol-1");
  assert.equal(p._PurchaseOrderItem[0]?._PurOrdAccountAssignment[0]?.CostCenter, "CC-1");
});

test("POST con resultado incierto: INCIERTA, se reconcilia por referencia y NUNCA se reenvia el POST", async () => {
  const sap = fakeSap({ post: netFail });
  const { adapter, store } = mk(sap);
  // 1) El POST se pierde y el GET aun no ve la OC (SAP sigue procesando): INCIERTA, un solo POST.
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal(sap.st.posts, 1);
  assert.equal((await store.obtener("sol-1"))?.estado, "INCIERTA");
  // 2) Reintentar mientras sigue incierta: no hay un segundo POST.
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal(sap.st.posts, 1);
  // 3) SAP termina: la reconciliacion la encuentra, queda CREADA y se devuelve la OC (sin POST).
  sap.st.visible = sap.oc;
  const oc = await adapter.crearOrdenCompra(input);
  assert.equal(oc.numero, "4500000001");
  assert.equal(sap.st.posts, 1);
  assert.equal((await store.obtener("sol-1"))?.estado, "CREADA");
  // 4) Ya creada: DUPLICADA con el numero.
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "DUPLICADA" && /4500000001/.test(e.message));
  assert.equal(sap.st.posts, 1);
});

test("5xx tras enviar el POST: INCIERTA (no se asume que fallo); si la OC ya existia antes, es DUPLICADA sin POST", async () => {
  const sap = fakeSap({ post: () => new Response("{}", { status: 500 }) });
  const { adapter, store } = mk(sap);
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal((await store.obtener("sol-1"))?.estado, "INCIERTA");
  // Otra solicitud cuya OC ya es visible por referencia: la comprobacion previa la detecta y no hay POST.
  const sap2 = fakeSap();
  sap2.st.visible = sap2.oc;
  await assert.rejects(() => mk(sap2).adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "DUPLICADA");
  assert.equal(sap2.st.posts, 0);
});

test("coordinacion por solicitud: dos creaciones simultaneas => un solo POST; la otra recibe EN_PROCESO", async () => {
  let liberar!: () => void;
  const gate = new Promise<void>((r) => (liberar = r));
  const sap = fakeSap({ post: async () => { await gate; return Response.json(fakeSap().oc, { status: 201 }); } });
  const { adapter } = mk(sap); // MISMO store compartido: equivale al DO por solicitudId
  const a = adapter.crearOrdenCompra(input);
  await new Promise((r) => setTimeout(r, 20)); // a ya tiene el registro EN_PROCESO y espera el POST
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "EN_PROCESO");
  liberar();
  assert.equal((await a).numero, "4500000001");
  assert.equal(sap.st.posts, 1);
});

test("rechazo de negocio (400) libera el registro: se puede corregir y reintentar; un fallo previo al POST tambien", async () => {
  const sap = fakeSap({ post: () => Response.json({ error: { message: "Proveedor bloqueado" } }, { status: 400 }) });
  const { adapter, store } = mk(sap);
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INVALIDA");
  assert.equal(await store.obtener("sol-1"), null);
  // Sin token CSRF: el POST ni salio => liberado, no incierto.
  const f2: typeof fetch = async () => new Response("{}"); // sin cabecera csrf
  const store2 = new MemorySolicitudStore();
  const a2 = new S4HanaSap({ baseUrl: "https://sap.test/svc", getToken: async () => "t", companyCode: "1", purchasingOrganization: "1", purchasingGroup: "1", plant: "1", store: store2, fetch: (u, i) => ((i?.method ?? "GET") === "GET" && String(u).includes("filter") ? Promise.resolve(Response.json({ value: [] })) : f2(u, i)), sleep: async () => {} });
  await assert.rejects(() => a2.crearOrdenCompra(input));
  assert.equal(await store2.obtener("sol-1"), null);
});

test("comprobacion local: no hace POST ni toca el estado persistido", async () => {
  const sap = fakeSap();
  const { adapter, store } = mk(sap, { comprobacionLocal: true });
  const r = await adapter.crearOrdenCompra(input);
  assert.match(r.numero, /^COMPROBADA-LOCAL/);
  assert.equal(sap.st.posts, 0);
  assert.equal(await store.obtener("sol-1"), null);
});
