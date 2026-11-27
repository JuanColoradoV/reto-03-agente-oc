// Pruebas de contrato de S4HanaSap con `fetch` inyectado: simulan lo que un S/4HANA real hace (token CSRF ligado a cookies de sesion,
// $filter por referencia, 201 con posiciones diferidas, 401 con token caducado, 5xx tras el POST). No hay SAP real: es el
// comportamiento DOCUMENTADO que el adaptador debe respetar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SapError } from "../src/sap/adapter";
import { MemorySolicitudStore } from "../src/sap/idempotencia";
import { S4HanaSap } from "../src/sap/s4hana";

const input = { solicitudId: "sol-7", proveedorId: "P-1", centroCosto: "CC-1", moneda: "COP", items: [{ descripcion: "Silla", cantidad: 2, precioUnitario: 1250.5 }, { descripcion: "Mesa", cantidad: 1, precioUnitario: 900 }], total: 3401, fecha: "2026-01-15" };
const ocCompleta = (num = "4500000009") => ({ PurchaseOrder: num, CorrespncExternalReference: "sol-7", Supplier: "P-1", DocumentCurrency: "COP", PurchaseOrderDate: "2026-01-15", _PurchaseOrderItem: [{ PurchaseOrderItemText: "Silla", OrderQuantity: "2", NetPriceAmount: "1250.50", _PurOrdAccountAssignment: [{ CostCenter: "CC-1" }] }, { PurchaseOrderItemText: "Mesa", OrderQuantity: "1", NetPriceAmount: "900.00", _PurOrdAccountAssignment: [{ CostCenter: "CC-1" }] }] });

interface Llamada { method: string; url: string; headers: Record<string, string>; body?: string }

function fakeSap(opts: { post?: (n: number, h: Record<string, string>) => Response | Promise<Response>; visible?: () => unknown | null } = {}) {
  const calls: Llamada[] = [];
  let posts = 0;
  const f: typeof fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const u = String(url);
    calls.push({ method, url: u, headers, ...(init?.body ? { body: String(init.body) } : {}) });
    if (method === "GET" && u.endsWith("/svc/")) {
      return new Response("{}", { headers: [["x-csrf-token", "TOKEN-1"], ["set-cookie", "SAP_SESSIONID_ABC_100=sess123; path=/; HttpOnly; Secure"], ["set-cookie", "sap-usercontext=sap-client=100; path=/"]] });
    }
    if (method === "GET") {
      const v = opts.visible?.() ?? null;
      return Response.json({ value: v ? [v] : [] });
    }
    posts++;
    // Como SAP: sin token CSRF o sin la cookie de sesion => 403 con `x-csrf-token: Required`.
    if (headers["x-csrf-token"] !== "TOKEN-1" || !/SAP_SESSIONID_ABC_100=sess123/.test(headers.cookie ?? "")) {
      return new Response(JSON.stringify({ error: { message: "CSRF token validation failed" } }), { status: 403, headers: { "x-csrf-token": "Required" } });
    }
    return (opts.post ?? (() => Response.json(ocCompleta(), { status: 201 })))(posts, headers);
  };
  return { f, calls, get posts() { return posts; } };
}

function adaptador(sap: ReturnType<typeof fakeSap>, extra: Record<string, unknown> = {}) {
  const tokens: Array<boolean | undefined> = [];
  const store = new MemorySolicitudStore();
  const adapter = new S4HanaSap({
    baseUrl: "https://sap.test/svc",
    getToken: async (renovar) => {
      tokens.push(renovar);
      return renovar ? "token-nuevo" : "token-viejo";
    },
    companyCode: "1000", purchasingOrganization: "1000", purchasingGroup: "001", plant: "1000",
    store, fetch: sap.f, sleep: async () => {}, ...extra,
  });
  return { adapter, store, tokens };
}

test("CSRF: el POST reenvia el token Y las cookies de sesion del GET previo (sin ellas SAP responde 403)", async () => {
  const sap = fakeSap();
  const { adapter } = adaptador(sap);
  const oc = await adapter.crearOrdenCompra(input);
  assert.equal(oc.numero, "4500000009");
  const post = sap.calls.find((c) => c.method === "POST")!;
  assert.equal(post.headers["x-csrf-token"], "TOKEN-1");
  assert.match(post.headers.cookie!, /SAP_SESSIONID_ABC_100=sess123/);
  assert.match(post.headers.cookie!, /sap-usercontext=sap-client=100/);
  assert.doesNotMatch(post.headers.cookie!, /HttpOnly|path=/i, "solo nombre=valor, sin atributos");
});

test("buscarPorSolicitud filtra en SAP por la referencia de ESA solicitud ($filter, $top=1): nunca un barrido global", async () => {
  const sap = fakeSap({ visible: () => ocCompleta() });
  const { adapter } = adaptador(sap);
  const oc = await adapter.buscarPorSolicitud("sol-7");
  assert.equal(oc?.numero, "4500000009");
  const get = sap.calls.find((c) => c.method === "GET" && c.url.includes("PurchaseOrder"))!;
  const url = decodeURIComponent(get.url);
  assert.match(url, /\$filter=CorrespncExternalReference eq 'sol-7'/);
  assert.match(url, /\$top=1(&|$)/);
  assert.doesNotMatch(url, /\$top=100/);
  // Comillas en el id: se escapan (no se puede romper el filtro OData).
  await adapter.buscarPorSolicitud("x' or 'a'='a");
  assert.match(decodeURIComponent(sap.calls.at(-1)!.url), /eq 'x'' or ''a''=''a'/);
});

test("201 con posiciones diferidas (__deferred): la OC devuelta conserva lineas y total (nunca total 0 ni items vacios)", async () => {
  const diferida = { PurchaseOrder: "4500000010", Supplier: "P-1", _PurchaseOrderItem: { __deferred: { uri: "x" } } };
  const sap = fakeSap({ post: () => Response.json(diferida, { status: 201 }) });
  const { adapter, store } = adaptador(sap);
  const oc = await adapter.crearOrdenCompra(input);
  assert.equal(oc.numero, "4500000010");
  assert.equal(oc.items.length, 2);
  assert.equal(oc.total, 3401);
  assert.equal(oc.centroCosto, "CC-1");
  assert.equal(oc.fecha, "2026-01-15");
  assert.equal((await store.obtener("sol-7"))?.estado, "CREADA");
});

test("201 sin cuerpo ni numero: INCIERTA y reconciliacion; no se libera ni se reenvia el POST", async () => {
  const sap = fakeSap({ post: () => new Response(null, { status: 201 }) });
  const { adapter, store } = adaptador(sap);
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal(sap.posts, 1);
  assert.equal((await store.obtener("sol-7"))?.estado, "INCIERTA");
});

test("401 con token caducado: renueva el token UNA vez y reintenta; un segundo 401 ya no se reintenta", async () => {
  const sap = fakeSap({
    post: (_n, h) => (h.authorization === "Bearer token-nuevo" ? Response.json(ocCompleta(), { status: 201 }) : new Response("{}", { status: 401 })),
  });
  const { adapter, tokens } = adaptador(sap);
  const oc = await adapter.crearOrdenCompra(input);
  assert.equal(oc.numero, "4500000009");
  assert.ok(tokens.includes(true), "pidio un token renovado");
  assert.equal(tokens.filter((t) => t === true).length, 1);
  assert.equal(sap.posts, 2, "el primer POST fue rechazado por 401 (nada se proceso) y se reenvio una sola vez");

  const siempre401 = fakeSap({ post: () => new Response("{}", { status: 401 }) });
  const b = adaptador(siempre401);
  await assert.rejects(() => b.adapter.crearOrdenCompra(input), /SAP respondió 401/);
  assert.equal(siempre401.posts, 2, "un solo reintento tras renovar, no mas");
  assert.equal(b.tokens.filter((t) => t === true).length, 1);
  assert.equal(await b.store.obtener("sol-7"), null, "401 definitivo: el registro se libera (no se grabo nada)");
});

test("503 tras el POST: INCIERTA, se reconcilia por referencia y NUNCA se hace un segundo POST", async () => {
  let visible = false;
  const sap = fakeSap({ post: () => new Response("{}", { status: 503 }), visible: () => (visible ? ocCompleta("4500000077") : null) });
  const { adapter, store } = adaptador(sap);
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal(sap.posts, 1);
  assert.equal((await store.obtener("sol-7"))?.estado, "INCIERTA");
  // Reintentos de la misma creacion mientras SAP sigue sin mostrarla: ningun POST nuevo.
  await assert.rejects(() => adapter.crearOrdenCompra(input), (e: unknown) => e instanceof SapError && e.code === "INCIERTA");
  assert.equal(sap.posts, 1);
  // SAP termina de procesar: la reconciliacion la encuentra.
  visible = true;
  const oc = await adapter.crearOrdenCompra(input);
  assert.equal(oc.numero, "4500000077");
  assert.equal(sap.posts, 1);
  assert.equal((await store.obtener("sol-7"))?.estado, "CREADA");
});

test("campos MM opcionales (grupo de articulos, cuenta, IVA, condiciones de pago) viajan en el payload cuando se configuran", () => {
  const { adapter } = adaptador(fakeSap(), { materialGroup: "L001", glAccount: "6000000", taxCode: "V1", paymentTerms: "0001" });
  const p = adapter.toPayload(input);
  assert.equal(p.PaymentTerms, "0001");
  assert.equal(p._PurchaseOrderItem[0]?.MaterialGroup, "L001");
  assert.equal(p._PurchaseOrderItem[0]?.TaxCode, "V1");
  assert.equal(p._PurchaseOrderItem[0]?._PurOrdAccountAssignment[0]?.GLAccount, "6000000");
  const sin = adaptador(fakeSap()).adapter.toPayload(input);
  assert.equal("PaymentTerms" in sin, false);
  assert.equal("MaterialGroup" in sin._PurchaseOrderItem[0]!, false);
});
