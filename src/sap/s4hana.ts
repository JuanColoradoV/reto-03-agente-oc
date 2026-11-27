// ESQUELETO (NO USADO) de un adaptador SAP real para S/4HANA vía OData V2 `API_PURCHASEORDER_PROCESS_SRV`.
//
// ESTADO: borrador de diseño que compila y respeta la interfaz `SapAdapter`. NO está conectado: ni `src/session`, ni `demo.ts`,
// ni las pruebas lo importan, y no hay ningún SAP real al que apuntar. Hacerlo funcionar exige, como mínimo:
//   1. Validar TODOS los nombres de campos/entidades de abajo contra el `$metadata` del sistema real (están escritos de memoria
//      y pueden diferir por versión/release o por campos Z/YY1_ personalizados).
//   2. Definir con el PRD/consultoría SAP los valores fijos de `S4HanaConfig` (sociedad, org. y grupo de compras, centro, tipo de documento).
//   3. Resolver autenticación (OAuth2 vía BTP / Cloud Connector, ver SOLUCION.md) y la gestión de cookies de sesión + token CSRF.
//   4. Probar contra un sandbox. Nada de esto se ha ejecutado.
//
// Ver SOLUCION.md > "Diseño del adaptador SAP real" para el razonamiento (idempotencia, reintentos, TESTRUN, auditoría).
import type { ItemSolicitud, OrdenCompra } from "../domain/types";
import { SapError, type CrearOrdenInput, type SapAdapter } from "./adapter";

export interface S4HanaConfig {
  /** Ej.: https://mi-sistema.s4hana.cloud.sap/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV */
  baseUrl: string;
  /** Devuelve un access token OAuth2 vigente (cliente-credenciales o principal propagation). Nunca se guarda en el código. */
  getToken(): Promise<string>;
  /** Valores fijos de organización de compras: los define SAP/Compras, no el modelo ni el usuario. [TODO: PRD] */
  companyCode: string;
  purchasingOrganization: string;
  purchasingGroup: string;
  plant: string;
  /** Tipo de documento de compra (p. ej. "NB" = pedido estándar). [TODO: PRD] */
  documentType?: string;
  /** Unidad de medida por defecto de las posiciones (ISO/SAP, p. ej. "PC"). [TODO: PRD] */
  unit?: string;
  /**
   * Modo simulación (equivalente conceptual al flag TESTRUN de BAPI_PO_CREATE1): arma y valida el payload y consulta
   * idempotencia, pero NO hace POST. OData V2 no tiene TESTRUN nativo; con RFC/BAPI sí (`TESTRUN = 'X'`, sin COMMIT).
   */
  testRun?: boolean;
  /** Inyectables para pruebas. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Reintentos máximos ante errores transitorios (por defecto 3). */
  maxRetries?: number;
  /** Auditoría: se llama por cada petición a SAP (sin tokens ni datos sensibles). */
  audit?: (entry: { op: string; status?: number; ms: number; ref?: string; ok: boolean }) => void;
}

/** Error técnico de SAP (red, 5xx, 401/403...). Los errores de negocio se mapean a SapError. */
export class S4HanaError extends Error {
  constructor(
    message: string,
    public status: number | undefined,
    public retryable: boolean,
  ) {
    super(message);
  }
}

// ---- Tipos del payload OData (forma ASUMIDA; verificar con $metadata) ----
interface ODataAccountAssignment {
  CostCenter: string;
  GLAccount?: string;
}
interface ODataPurchaseOrderItem {
  PurchaseOrderItem: string;
  PurchaseOrderItemText: string;
  Plant: string;
  OrderQuantity: string;
  PurchaseOrderQuantityUnit: string;
  NetPriceAmount: string;
  DocumentCurrency: string;
  /** "K" = imputación a centro de costo. */
  AccountAssignmentCategory: "K";
  to_AccountAssignment: { results: ODataAccountAssignment[] };
}
export interface ODataPurchaseOrder {
  PurchaseOrder?: string;
  CompanyCode: string;
  PurchasingDocumentType: string;
  Supplier: string;
  PurchasingOrganization: string;
  PurchasingGroup: string;
  DocumentCurrency: string;
  /** Clave de idempotencia: el id de la solicitud viaja como referencia externa de la OC. [campo a validar] */
  CorrespncExternalReference: string;
  to_PurchaseOrderItem: { results: ODataPurchaseOrderItem[] };
}

const ref = (solicitudId: string) => solicitudId.replace(/'/g, "''"); // escapa comillas en literales OData

export class S4HanaSap implements SapAdapter {
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private cfg: S4HanaConfig) {
    this.f = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Mapeo puro CrearOrdenInput -> payload OData. El contenido sale del servidor (prepararOrden), nunca del modelo. */
  toPayload(input: CrearOrdenInput): ODataPurchaseOrder {
    if (input.items.length === 0) throw new SapError("INVALIDA", "La OC no tiene posiciones.");
    return {
      CompanyCode: this.cfg.companyCode,
      PurchasingDocumentType: this.cfg.documentType ?? "NB",
      Supplier: input.proveedorId,
      PurchasingOrganization: this.cfg.purchasingOrganization,
      PurchasingGroup: this.cfg.purchasingGroup,
      DocumentCurrency: input.moneda,
      CorrespncExternalReference: input.solicitudId,
      to_PurchaseOrderItem: {
        results: input.items.map((it: ItemSolicitud, i) => ({
          PurchaseOrderItem: String((i + 1) * 10), // 10, 20, 30...
          PurchaseOrderItemText: it.descripcion.slice(0, 40), // texto corto SAP: 40 caracteres
          Plant: this.cfg.plant,
          OrderQuantity: String(it.cantidad),
          PurchaseOrderQuantityUnit: this.cfg.unit ?? "PC",
          NetPriceAmount: it.precioUnitario.toFixed(2),
          DocumentCurrency: input.moneda,
          AccountAssignmentCategory: "K",
          to_AccountAssignment: { results: [{ CostCenter: input.centroCosto }] },
        })),
      },
      // [TODO] comentarioAprobador: iría como nota de cabecera (entidad A_PurchaseOrderNote) y/o en el log de auditoría propio.
    };
  }

  /** Idempotencia: busca una OC ya creada para esta solicitud (referencia externa). */
  private async buscarPorSolicitud(solicitudId: string): Promise<OrdenCompra | null> {
    const q = `/A_PurchaseOrder?$filter=CorrespncExternalReference eq '${ref(solicitudId)}'&$expand=to_PurchaseOrderItem/to_AccountAssignment&$top=1&$format=json`;
    const res = await this.request("GET", q, undefined, `buscar:${solicitudId}`);
    const first = ((await res.json()) as { d?: { results?: unknown[] } }).d?.results?.[0];
    return first ? this.fromOData(first as Record<string, unknown>) : null;
  }

  async crearOrdenCompra(input: CrearOrdenInput): Promise<OrdenCompra> {
    const payload = this.toPayload(input);
    // 1) Idempotencia previa (mismo contrato que C0 / DUPLICADA de InMemorySap).
    const existente = await this.buscarPorSolicitud(input.solicitudId);
    if (existente) throw new SapError("DUPLICADA", `La solicitud ${input.solicitudId} ya tiene la OC ${existente.numero}.`);
    // 2) Simulación: no escribe nada.
    if (this.cfg.testRun) return { numero: `SIMULADA-${input.solicitudId}`, ...input };
    // 3) Creación. Un POST que falla por red puede haber tenido éxito: antes de reintentar se vuelve a consultar por referencia.
    let intento = 0;
    for (;;) {
      try {
        const res = await this.request("POST", "/A_PurchaseOrder", payload, `crear:${input.solicitudId}`, { reintentar: false });
        const creada = this.fromOData(((await res.json()) as { d: Record<string, unknown> }).d);
        return { ...creada, comentarioAprobador: input.comentarioAprobador, fecha: input.fecha };
      } catch (e) {
        if (!(e instanceof S4HanaError) || !e.retryable || ++intento > (this.cfg.maxRetries ?? 3)) throw e;
        await this.sleep(backoff(intento));
        const yaCreada = await this.buscarPorSolicitud(input.solicitudId);
        if (yaCreada) return { ...yaCreada, comentarioAprobador: input.comentarioAprobador, fecha: input.fecha };
      }
    }
  }

  async consultarOrden(numero: string): Promise<OrdenCompra | null> {
    if (!/^\d{10}$/.test(numero)) return null; // número SAP de 10 dígitos; evita inyectar en la ruta OData
    try {
      const res = await this.request("GET", `/A_PurchaseOrder('${numero}')?$expand=to_PurchaseOrderItem/to_AccountAssignment&$format=json`, undefined, `consultar:${numero}`);
      return this.fromOData(((await res.json()) as { d: Record<string, unknown> }).d);
    } catch (e) {
      if (e instanceof SapError && e.code === "NO_ENCONTRADA") return null;
      throw e;
    }
  }

  async listarOrdenes(): Promise<OrdenCompra[]> {
    // [TODO] En producción: paginar ($skiptoken) y filtrar por referencia externa/fecha; aquí un tope simple.
    const res = await this.request("GET", "/A_PurchaseOrder?$top=100&$orderby=PurchaseOrder desc&$expand=to_PurchaseOrderItem/to_AccountAssignment&$format=json", undefined, "listar");
    const results = ((await res.json()) as { d?: { results?: Record<string, unknown>[] } }).d?.results ?? [];
    return results.map((r) => this.fromOData(r));
  }

  // ---- Transporte: auth, CSRF, reintentos con backoff, mapeo de errores ----
  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    etiqueta: string,
    opts: { reintentar?: boolean } = {},
  ): Promise<Response> {
    const max = opts.reintentar === false ? 0 : (this.cfg.maxRetries ?? 3);
    for (let intento = 0; ; intento++) {
      const t0 = Date.now();
      try {
        const token = await this.cfg.getToken();
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
        if (method === "POST") {
          headers["content-type"] = "application/json";
          // [TODO] SAP exige un token CSRF para escrituras: GET previo con `x-csrf-token: Fetch`, reenviar el token Y las cookies
          // de sesión devueltas. Un Worker no tiene jar de cookies: hay que reenviarlas a mano (o usar un proxy/BTP destination).
          headers["x-csrf-token"] = await this.fetchCsrf(token);
        }
        const res = await this.f(this.cfg.baseUrl + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        this.cfg.audit?.({ op: etiqueta, status: res.status, ms: Date.now() - t0, ok: res.ok });
        if (res.ok) return res;
        throw await mapError(res);
      } catch (e) {
        const transitorio = e instanceof S4HanaError ? e.retryable : !(e instanceof SapError); // fallo de red = transitorio
        if (!(e instanceof S4HanaError) && !(e instanceof SapError)) this.cfg.audit?.({ op: etiqueta, ms: Date.now() - t0, ok: false });
        if (!transitorio || intento >= max) {
          if (e instanceof SapError || e instanceof S4HanaError) throw e;
          throw new S4HanaError(`Error de red hacia SAP: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
        }
        await this.sleep(backoff(intento + 1));
      }
    }
  }

  private async fetchCsrf(token: string): Promise<string> {
    const res = await this.f(this.cfg.baseUrl + "/", { method: "GET", headers: { authorization: `Bearer ${token}`, "x-csrf-token": "Fetch" } });
    const csrf = res.headers.get("x-csrf-token");
    if (!csrf) throw new S4HanaError("SAP no devolvió token CSRF.", res.status, false);
    return csrf;
  }

  /** OData -> OrdenCompra. Los decimales de OData V2 llegan como string; las fechas como "/Date(ms)/". */
  private fromOData(r: Record<string, unknown>): OrdenCompra {
    const itemsRaw = ((r.to_PurchaseOrderItem as { results?: Record<string, unknown>[] } | undefined)?.results ?? []) as Record<string, unknown>[];
    const items: ItemSolicitud[] = itemsRaw.map((i) => ({ descripcion: String(i.PurchaseOrderItemText ?? ""), cantidad: Number(i.OrderQuantity), precioUnitario: Number(i.NetPriceAmount) }));
    const cc = (itemsRaw[0]?.to_AccountAssignment as { results?: { CostCenter?: string }[] } | undefined)?.results?.[0]?.CostCenter ?? "";
    return {
      numero: String(r.PurchaseOrder ?? ""),
      solicitudId: String(r.CorrespncExternalReference ?? ""),
      proveedorId: String(r.Supplier ?? ""),
      centroCosto: cc,
      moneda: String(r.DocumentCurrency ?? ""),
      items,
      total: Math.round(items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0) * 100) / 100,
      fecha: odataDate(r.PurchaseOrderDate),
    };
  }
}

const backoff = (n: number) => Math.min(8000, 250 * 2 ** (n - 1)) + Math.floor(Math.random() * 100); // exponencial con jitter, tope 8 s

function odataDate(v: unknown): string {
  const m = typeof v === "string" ? v.match(/\/Date\((\d+)\)\//) : null;
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/**
 * Mapea la respuesta de error de SAP. Reintentable SOLO: 429, 502, 503, 504 (y fallos de red, arriba).
 * Negocio: 404 -> NO_ENCONTRADA; 400/409/422 -> INVALIDA (o DUPLICADA si el mensaje lo indica). 401/403/otros -> técnico, sin reintento.
 * Los mensajes BAPIRET2-like llegan en `error.innererror.errordetails[]` con severidad (error / warning / info).
 */
async function mapError(res: Response): Promise<SapError | S4HanaError> {
  let msg = `SAP respondió ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: { value?: string }; innererror?: { errordetails?: { message?: string; severity?: string }[] } } };
    const det = (j.error?.innererror?.errordetails ?? []).filter((d) => d.severity === "error").map((d) => d.message).filter(Boolean);
    msg = det.length ? det.join(" | ") : (j.error?.message?.value ?? msg);
  } catch {
    /* cuerpo no JSON */
  }
  if ([429, 502, 503, 504].includes(res.status)) return new S4HanaError(msg, res.status, true);
  if (res.status === 404) return new SapError("NO_ENCONTRADA", msg);
  if (res.status === 409 || /already exists|ya existe|duplicate/i.test(msg)) return new SapError("DUPLICADA", msg);
  if (res.status === 400 || res.status === 422) return new SapError("INVALIDA", msg);
  return new S4HanaError(msg, res.status, false);
}
