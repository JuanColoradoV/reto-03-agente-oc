// DISEÑO EJECUTABLE (NO CONECTADO) de un adaptador SAP real para S/4HANA vía OData V4 `API_PURCHASEORDER_2`.
//
// Por qué V4: para integraciones NUEVAS en S/4HANA Cloud, SAP documenta como deprecado el servicio OData V2
// `API_PURCHASEORDER_PROCESS_SRV` (desde Public Cloud 2308) y como sucesor el V4 `API_PURCHASEORDER_2` (fuentes en SOLUCION.md).
// Deprecado no es retirado: para releases on-premise anteriores el fallback es V2 o BAPI_PO_CREATE1 (otro mapeador, no incluido).
//
// ESTADO: borrador de diseño que compila y respeta la interfaz `SapAdapter`. NO está conectado: ni el Worker (`src/`), ni `demo.ts`
// lo importan (solo las pruebas de esta carpeta, con `fetch` falso), y no hay ningún SAP real al que apuntar. Hacerlo funcionar exige:
//   1. Validar TODOS los nombres de campos/entidades/rutas contra el `$metadata` del sistema real. Lista de lo NO verificado
//      (escrito por analogía con V2): ver CAMPOS_A_VERIFICAR abajo. Solo `PurchaseOrderType` coincide con el ejemplo
//      oficial de creación de OC de SAP Help (enlace en SOLUCION.md).
//   2. Definir con el PRD/consultoría SAP los valores fijos de `S4HanaConfig` (sociedad, org. y grupo de compras, centro, tipo).
//   3. Resolver autenticación (OAuth2 vía BTP / Cloud Connector). Ya implementado, solo contra un SAP falso: token CSRF con las cookies de sesión del mismo GET,
//      renovación del token una vez ante 401 y reintento único ante CSRF requerido.
//   4. Conectar el estado persistido por solicitud (idempotencia.ts + solicitud-do.ts). Sin él, este adaptador no se debe usar.
//   5. Probar contra un sandbox. Nada de esto se ha ejecutado contra un SAP real.
//
// Ver SOLUCION.md > "Diseño del adaptador SAP real" (idempotencia con estados, reintentos, comprobación local vs. simulación real).
import { fromMinor, totalMinor } from "../../src/domain/dinero";
import type { ItemSolicitud, OrdenCompra } from "../../src/domain/types";
import { canonico, sha256Hex } from "../../src/domain/huella";
import { SapError, type CrearOrdenInput, type SapAdapter } from "../../src/sap/adapter";
import type { SolicitudStateStore } from "./idempotencia";

/** Nombres a confirmar en `$metadata` antes de usar el adaptador (todos salvo PurchaseOrderType). */
export const CAMPOS_A_VERIFICAR = [
  "ruta del servicio V4 (…/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/<versión>)",
  "entity set PurchaseOrder; navegaciones _PurchaseOrderItem y _PurOrdAccountAssignment",
  "CorrespncExternalReference: ¿filtrable? NO es única (SAP no impide dos OC con la misma referencia) y puede tener longitud máxima corta (en el modelo clásico EKKO-IHREZ son 12 caracteres: confirmar y, si aplica, mapear el solicitudId a un código corto); PurchaseOrderDate",
  "posiciones de texto libre (sin material) con imputación a centro de costo: MaterialGroup y GLAccount suelen ser obligatorios; TaxCode (indicador de IVA) y PaymentTerms (condiciones de pago)",
  "forma de la respuesta 201 de la inserción profunda (¿devuelve las posiciones o solo la cabecera?) y de las cookies de sesión (SAP_SESSIONID_*) que acompañan al token CSRF",
  "CompanyCode, Supplier, PurchasingOrganization, PurchasingGroup, DocumentCurrency",
  "PurchaseOrderItem, PurchaseOrderItemText, Plant, OrderQuantity, PurchaseOrderQuantityUnit, NetPriceAmount, AccountAssignmentCategory",
  "CostCenter (imputación), forma del error V4 (error.message / error.details[])",
  "cómo se serializan los decimales (número o cadena) y las fechas en V4",
] as const;

export interface S4HanaConfig {
  /** Raíz del servicio OData V4 API_PURCHASEORDER_2 (ruta exacta: verificar en el sistema). */
  baseUrl: string;
  /**
   * Devuelve un access token OAuth2 vigente (cliente-credenciales o principal propagation). Nunca se guarda en el código.
   * Con `renovar = true` (tras un 401) debe saltarse la caché y pedir uno nuevo; el adaptador lo hace UNA vez por petición.
   */
  getToken(renovar?: boolean): Promise<string>;
  /** Valores fijos de organización de compras: los define SAP/Compras, no el modelo ni el usuario. [TODO: PRD] */
  companyCode: string;
  purchasingOrganization: string;
  purchasingGroup: string;
  plant: string;
  /** Tipo de documento de compra (campo `PurchaseOrderType`; p. ej. "NB" = pedido estándar). [TODO: PRD] */
  purchaseOrderType?: string;
  /** Unidad de medida por defecto de las posiciones (ISO/SAP, p. ej. "PC"). [TODO: PRD] */
  unit?: string;
  /** Datos MM que SAP puede exigir en posiciones de texto libre con imputación (nombres a verificar). [TODO: PRD] */
  materialGroup?: string;
  glAccount?: string;
  /** Indicador de IVA (maestro indicadores-iva.json) y condiciones de pago (condiciones-pago.json). [TODO: PRD] */
  taxCode?: string;
  paymentTerms?: string;
  /**
   * COMPROBACIÓN LOCAL (no es una simulación de SAP): arma el payload y consulta si ya hay una OC con esa referencia, pero NO
   * hace POST y devuelve una OC ficticia. No ejecuta validaciones de negocio de SAP (precios, impuestos, presupuesto, avisos):
   * para eso haría falta una operación de simulación real y separada (`SapSimulacion`, p. ej. BAPI_PO_CREATE1 con TESTRUN).
   */
  comprobacionLocal?: boolean;
  /** Estado persistido por solicitud + coordinación global (DO por solicitudId). OBLIGATORIO para crear. */
  store: SolicitudStateStore;
  /** Un EN_PROCESO más viejo que esto (el proceso murió) se trata como INCIERTA. Por defecto 120 s. */
  enProcesoTtlMs?: number;
  /** Consultas de reconciliación tras un resultado incierto (por defecto 3, con backoff). */
  reconciliacionIntentos?: number;
  /** Inyectables para pruebas. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Reintentos máximos de las LECTURAS (GET) ante errores transitorios (por defecto 3). El POST nunca se reintenta. */
  maxRetries?: number;
  /** Auditoría: se llama por cada petición a SAP (sin tokens ni datos sensibles). */
  audit?: (entry: { op: string; status?: number; ms: number; ref?: string; ok: boolean }) => void;
}

/** Error técnico de SAP (red, 5xx, 401/403...). Los errores de negocio se mapean a SapError. */
export class S4HanaError extends Error {
  /** true si la petición (POST) llegó a salir: entonces el resultado puede ser ambiguo. */
  enviada = false;
  /** true si SAP rechazó por token CSRF ausente/caducado (cabecera x-csrf-token: Required). */
  csrf = false;
  constructor(
    message: string,
    public status: number | undefined,
    public retryable: boolean,
  ) {
    super(message);
  }
}

// ---- Tipos del payload OData V4 (forma ASUMIDA; verificar con $metadata) ----
interface ODataAccountAssignment {
  CostCenter: string;
  GLAccount?: string;
}
interface ODataPurchaseOrderItem {
  PurchaseOrderItem: string;
  PurchaseOrderItemText: string;
  Plant: string;
  MaterialGroup?: string;
  TaxCode?: string;
  OrderQuantity: string;
  PurchaseOrderQuantityUnit: string;
  NetPriceAmount: string;
  DocumentCurrency: string;
  /** "K" = imputación a centro de costo. */
  AccountAssignmentCategory: "K";
  _PurOrdAccountAssignment: ODataAccountAssignment[];
}
export interface ODataPurchaseOrder {
  PurchaseOrder?: string;
  CompanyCode: string;
  /** Confirmado por el ejemplo oficial (NO es `PurchasingDocumentType`). */
  PurchaseOrderType: string;
  Supplier: string;
  PurchasingOrganization: string;
  PurchasingGroup: string;
  DocumentCurrency: string;
  /** Referencia externa de la OC: el id de la solicitud viaja aquí y sirve para reconciliar. [campo a validar] */
  CorrespncExternalReference: string;
  PaymentTerms?: string;
  _PurchaseOrderItem: ODataPurchaseOrderItem[];
}

const lit = (v: string) => v.replace(/'/g, "''"); // escapa comillas en literales OData
const EXPAND = "$expand=_PurchaseOrderItem($expand=_PurOrdAccountAssignment)";

export class S4HanaSap implements SapAdapter {
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private cfg: S4HanaConfig) {
    this.f = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = cfg.nowMs ?? Date.now;
  }

  /** Mapeo puro CrearOrdenInput -> payload OData V4. El contenido sale del servidor (prepararOrden), nunca del modelo. */
  toPayload(input: CrearOrdenInput): ODataPurchaseOrder {
    if (input.items.length === 0) throw new SapError("INVALIDA", "La OC no tiene posiciones.");
    return {
      CompanyCode: this.cfg.companyCode,
      PurchaseOrderType: this.cfg.purchaseOrderType ?? "NB",
      Supplier: input.proveedorId,
      PurchasingOrganization: this.cfg.purchasingOrganization,
      PurchasingGroup: this.cfg.purchasingGroup,
      DocumentCurrency: input.moneda,
      CorrespncExternalReference: input.solicitudId,
      ...(this.cfg.paymentTerms ? { PaymentTerms: this.cfg.paymentTerms } : {}),
      _PurchaseOrderItem: input.items.map((it: ItemSolicitud, i) => ({
        PurchaseOrderItem: String((i + 1) * 10), // 10, 20, 30...
        PurchaseOrderItemText: it.descripcion.slice(0, 40), // texto corto SAP: 40 caracteres
        Plant: this.cfg.plant,
        ...(this.cfg.materialGroup ? { MaterialGroup: this.cfg.materialGroup } : {}),
        ...(this.cfg.taxCode ? { TaxCode: this.cfg.taxCode } : {}),
        OrderQuantity: String(it.cantidad),
        PurchaseOrderQuantityUnit: this.cfg.unit ?? "PC",
        NetPriceAmount: it.precioUnitario.toFixed(2),
        DocumentCurrency: input.moneda,
        AccountAssignmentCategory: "K",
        _PurOrdAccountAssignment: [{ CostCenter: input.centroCosto, ...(this.cfg.glAccount ? { GLAccount: this.cfg.glAccount } : {}) }],
      })),
      // [TODO] comentarioAprobador: iría como nota de cabecera (entidad de notas del servicio) y/o en el log de auditoría propio.
    };
  }

  /**
   * Busca la OC de esta solicitud por referencia externa con `$filter` EN SAP (nunca un barrido de las ultimas N ordenes).
   * GET: seguro de repetir. Es la consulta de los controles, del preflight y de la reconciliacion.
   * Ojo: la referencia no es unica en SAP; si hubiera mas de una OC con ella se devuelve la primera y eso ya es una anomalia a
   * revisar (la unicidad la dan el DO por solicitud y la reconciliacion, no esta consulta).
   */
  async buscarPorSolicitud(solicitudId: string): Promise<OrdenCompra | null> {
    const filtro = encodeURIComponent(`CorrespncExternalReference eq '${lit(solicitudId)}'`);
    const res = await this.request("GET", `/PurchaseOrder?$filter=${filtro}&${EXPAND}&$top=1`, undefined, `buscar:${solicitudId}`);
    const first = ((await res.json()) as { value?: unknown[] }).value?.[0];
    return first ? this.fromOData(first as Record<string, unknown>) : null;
  }

  /**
   * Creación con estado persistido por solicitud (ver idempotencia.ts):
   *  - Solo quien gana `iniciar` (EN_PROCESO) puede enviar el POST, y lo envía UNA vez (el POST nunca se reintenta).
   *  - Resultado ambiguo (red, timeout, 5xx) => INCIERTA y reconciliación por referencia externa; NUNCA se vuelve a hacer POST.
   *  - SAP rechaza de forma definitiva (4xx de negocio) o el POST ni salió => se libera el registro (se puede corregir y reintentar).
   */
  async crearOrdenCompra(input: CrearOrdenInput): Promise<OrdenCompra> {
    const payload = this.toPayload(input);
    const sol = input.solicitudId;
    const extra = { comentarioAprobador: input.comentarioAprobador, fecha: input.fecha };

    if (this.cfg.comprobacionLocal) {
      // No toca el estado persistido ni escribe en SAP.
      const existente = await this.buscarPorSolicitud(sol);
      if (existente) throw new SapError("DUPLICADA", `La solicitud ${sol} ya tiene la OC ${existente.numero}.`);
      return { numero: `COMPROBADA-LOCAL-${sol}`, ...input };
    }

    const payloadHash = await sha256Hex(canonico(payload));
    const intentoId = crypto.randomUUID();
    const { propietario, registro } = await this.cfg.store.iniciar(sol, intentoId, payloadHash, this.now());

    if (!propietario) {
      // Otro intento (otra sesión/instancia) ya tomó la solicitud. NUNCA se envía un segundo POST.
      if (registro.estado === "CREADA") throw new SapError("DUPLICADA", `La solicitud ${sol} ya tiene la OC ${registro.numero ?? "(número por confirmar)"}.`);
      if (registro.estado === "EN_PROCESO") {
        if (this.now() - registro.actualizadoEn <= (this.cfg.enProcesoTtlMs ?? 120_000)) {
          throw new SapError("EN_PROCESO", `La solicitud ${sol} se está procesando en SAP en este momento. No se reenvía.`);
        }
        await this.cfg.store.marcar(sol, "INCIERTA", { motivo: "EN_PROCESO caducado" }, this.now());
      }
      const oc = await this.reconciliar(sol);
      if (!oc) throw this.incierta(sol);
      if (registro.payloadHash !== payloadHash) throw new SapError("DUPLICADA", `La solicitud ${sol} ya tiene la OC ${oc.numero} con otro contenido.`);
      return { ...oc, ...extra }; // mismo pedido que un intento anterior incierto: ya existe, se devuelve
    }

    // Somos propietarios (EN_PROCESO). Comprobación previa de duplicados por referencia (la OC pudo crearse fuera de este flujo).
    try {
      const existente = await this.buscarPorSolicitud(sol);
      if (existente) {
        await this.cfg.store.marcar(sol, "CREADA", { numero: existente.numero }, this.now());
        throw new SapError("DUPLICADA", `La solicitud ${sol} ya tiene la OC ${existente.numero}.`);
      }
    } catch (e) {
      if (!(e instanceof SapError && e.code === "DUPLICADA")) await this.cfg.store.liberar(sol, intentoId); // no se envió nada
      throw e;
    }

    try {
      const res = await this.request("POST", "/PurchaseOrder", payload, `crear:${sol}`, { reintentar: false });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        /* 201 sin cuerpo JSON: abajo se trata como resultado por confirmar */
      }
      const numero = typeof body.PurchaseOrder === "string" ? body.PurchaseOrder : "";
      if (!numero) {
        // SAP respondio 2xx pero no sabemos el numero: la OC PUDO crearse. Nunca se libera ni se reenvia: se reconcilia.
        await this.cfg.store.marcar(sol, "INCIERTA", { motivo: "respuesta 2xx sin número de OC" }, this.now());
        const oc = await this.reconciliar(sol);
        if (!oc) throw this.incierta(sol);
        return { ...oc, ...extra };
      }
      const creada = this.deRespuestaCreacion(body, numero, input);
      await this.cfg.store.marcar(sol, "CREADA", { numero }, this.now());
      return { ...creada, ...extra };
    } catch (e) {
      if (e instanceof SapError) {
        // SAP respondió con un rechazo de negocio definitivo: no se grabó nada.
        if (e.code === "DUPLICADA") await this.reconciliar(sol); // ya existe: fija el número si se encuentra
        else await this.cfg.store.liberar(sol, intentoId);
        throw e;
      }
      if (!this.posiblementeProcesada(e)) {
        await this.cfg.store.liberar(sol, intentoId); // falló antes de enviar (token, CSRF) o SAP respondió 4xx/429: no se grabó
        throw e;
      }
      await this.cfg.store.marcar(sol, "INCIERTA", { motivo: e instanceof Error ? e.message.slice(0, 200) : "desconocido" }, this.now());
      const oc = await this.reconciliar(sol);
      if (!oc) throw this.incierta(sol);
      return { ...oc, ...extra };
    }
  }

  /**
   * Respuesta 201 de la insercion profunda. En OData la respuesta puede traer las posiciones diferidas (`__deferred`) o solo la
   * cabecera: en ese caso los datos de la OC son los que ESTE servidor envio (lo que SAP grabo), con el numero que SAP asigno.
   * Nunca se devuelve una OC con total 0 o sin lineas por una respuesta parcial.
   */
  private deRespuestaCreacion(body: Record<string, unknown>, numero: string, input: CrearOrdenInput): OrdenCompra {
    const items = body._PurchaseOrderItem;
    const completa = Array.isArray(items) && items.length === input.items.length;
    const base: OrdenCompra = completa ? this.fromOData(body) : { ...input, numero };
    return { ...base, numero, solicitudId: input.solicitudId, total: input.total };
  }

  /** ¿Pudo SAP haber ejecutado el POST? Si salió y no hubo respuesta, o respondió 5xx: sí (se asume lo peor). */
  private posiblementeProcesada(e: unknown): boolean {
    if (!(e instanceof S4HanaError)) return true;
    if (!e.enviada) return false;
    return e.status === undefined || e.status >= 500;
  }

  private incierta(sol: string): SapError {
    return new SapError("INCIERTA", `No se pudo confirmar si SAP creó la OC de ${sol}. NO se reintenta el envío; se reconciliará por referencia externa antes de cualquier otra acción.`);
  }

  /**
   * Reconciliación: consulta por referencia externa (solo lecturas, con backoff). Si aparece la OC => CREADA. Si no aparece, el
   * registro sigue INCIERTA (SAP puede seguir procesando): se vuelve a llamar más tarde (job o acción manual). Devuelve null si no hay OC.
   */
  async reconciliar(solicitudId: string): Promise<OrdenCompra | null> {
    const intentos = this.cfg.reconciliacionIntentos ?? 3;
    for (let i = 0; i < intentos; i++) {
      try {
        const oc = await this.buscarPorSolicitud(solicitudId);
        if (oc) {
          await this.cfg.store.marcar(solicitudId, "CREADA", { numero: oc.numero }, this.now());
          return oc;
        }
      } catch {
        /* la lectura falló: se sigue intentando; el estado no cambia */
      }
      if (i < intentos - 1) await this.sleep(backoff(i + 1));
    }
    return null;
  }

  async consultarOrden(numero: string): Promise<OrdenCompra | null> {
    if (!/^\d{10}$/.test(numero)) return null; // número SAP de 10 dígitos; evita inyectar en la ruta OData
    try {
      const res = await this.request("GET", `/PurchaseOrder('${numero}')?${EXPAND}`, undefined, `consultar:${numero}`);
      return this.fromOData((await res.json()) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof SapError && e.code === "NO_ENCONTRADA") return null;
      throw e;
    }
  }

  async listarOrdenes(): Promise<OrdenCompra[]> {
    // Solo para listados de diagnostico/UI. NUNCA para decidir duplicados (eso es buscarPorSolicitud, filtrado en SAP).
    // [TODO] En producción: paginar (@odata.nextLink) y filtrar por referencia externa/fecha; aquí un tope simple.
    const res = await this.request("GET", `/PurchaseOrder?$top=100&$orderby=${encodeURIComponent("PurchaseOrder desc")}&${EXPAND}`, undefined, "listar");
    const results = ((await res.json()) as { value?: Record<string, unknown>[] }).value ?? [];
    return results.map((r) => this.fromOData(r));
  }

  // ---- Transporte: auth, CSRF, reintentos con backoff (solo GET), mapeo de errores ----
  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    etiqueta: string,
    opts: { reintentar?: boolean } = {},
  ): Promise<Response> {
    const max = opts.reintentar === false ? 0 : (this.cfg.maxRetries ?? 3);
    let tokenRenovado = false; // un 401 se atiende renovando el token UNA vez por petición
    let csrfReintentado = false; // idem para "CSRF requerido": se pide un token nuevo una vez
    let renovar = false;
    for (let intento = 0; ; intento++) {
      const t0 = Date.now();
      let enviada = false;
      try {
        const token = renovar ? await this.cfg.getToken(true) : await this.cfg.getToken();
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
        if (method === "POST") {
          headers["content-type"] = "application/json";
          // SAP liga el token CSRF a la sesión HTTP: se reenvían el token Y las cookies de sesión (SAP_SESSIONID_*) de ESE mismo GET.
          // Un Worker no tiene jar de cookies, así que se copian a mano.
          const csrf = await this.fetchCsrf(token);
          headers["x-csrf-token"] = csrf.token;
          if (csrf.cookie) headers.cookie = csrf.cookie;
        }
        enviada = method === "POST"; // a partir de aquí el POST puede haber llegado a SAP
        const res = await this.f(this.cfg.baseUrl + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        this.cfg.audit?.({ op: etiqueta, status: res.status, ms: Date.now() - t0, ok: res.ok });
        if (res.ok) return res;
        const err = await mapError(res);
        if (err instanceof S4HanaError && res.headers.get("x-csrf-token")?.toLowerCase() === "required") err.csrf = true;
        throw err;
      } catch (e) {
        if (e instanceof S4HanaError) e.enviada = enviada;
        // 401 (token caducado) o CSRF requerido: SAP los rechaza ANTES de procesar nada, así que reintentar una vez es seguro
        // incluso para el POST. No consume los reintentos de backoff.
        if (e instanceof S4HanaError && e.status === 401 && !tokenRenovado) {
          tokenRenovado = true;
          renovar = true;
          intento--;
          continue;
        }
        if (e instanceof S4HanaError && e.csrf && !csrfReintentado) {
          csrfReintentado = true;
          intento--;
          continue;
        }
        const transitorio = e instanceof S4HanaError ? e.retryable : !(e instanceof SapError); // fallo de red = transitorio
        if (!(e instanceof S4HanaError) && !(e instanceof SapError)) this.cfg.audit?.({ op: etiqueta, ms: Date.now() - t0, ok: false });
        if (!transitorio || intento >= max) {
          if (e instanceof SapError || e instanceof S4HanaError) throw e;
          const err = new S4HanaError(`Error de red hacia SAP: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
          err.enviada = enviada;
          throw err;
        }
        await this.sleep(backoff(intento + 1));
      }
    }
  }

  /** Token CSRF + cookies de sesión de la MISMA respuesta (el token solo vale con esa sesión). */
  private async fetchCsrf(token: string): Promise<{ token: string; cookie: string }> {
    const res = await this.f(this.cfg.baseUrl + "/", { method: "GET", headers: { authorization: `Bearer ${token}`, "x-csrf-token": "Fetch", accept: "application/json" } });
    const csrf = res.headers.get("x-csrf-token");
    if (!csrf) throw new S4HanaError(res.status === 401 ? "SAP rechazó el token de acceso." : "SAP no devolvió token CSRF.", res.status, false);
    // Set-Cookie -> Cookie: solo `nombre=valor` (se descartan Path/HttpOnly/Secure...).
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).filter(Boolean).join("; ");
    return { token: csrf, cookie };
  }

  /** OData V4 -> OrdenCompra. Decimales y fechas: forma a verificar (V4 puede enviarlos como número o cadena ISO). */
  private fromOData(r: Record<string, unknown>): OrdenCompra {
    const itemsRaw = ((r._PurchaseOrderItem as Record<string, unknown>[] | undefined) ?? []) as Record<string, unknown>[];
    const items: ItemSolicitud[] = itemsRaw.map((i) => ({ descripcion: String(i.PurchaseOrderItemText ?? ""), cantidad: Number(i.OrderQuantity), precioUnitario: Number(i.NetPriceAmount) }));
    const cc = (itemsRaw[0]?._PurOrdAccountAssignment as { CostCenter?: string }[] | undefined)?.[0]?.CostCenter ?? "";
    return {
      numero: String(r.PurchaseOrder ?? ""),
      solicitudId: String(r.CorrespncExternalReference ?? ""),
      proveedorId: String(r.Supplier ?? ""),
      centroCosto: cc,
      moneda: String(r.DocumentCurrency ?? ""),
      items,
      total: fromMinor(totalMinor(items)),
      fecha: odataDate(r.PurchaseOrderDate),
    };
  }
}

const backoff = (n: number) => Math.min(8000, 250 * 2 ** (n - 1)) + Math.floor(Math.random() * 100); // exponencial con jitter, tope 8 s

function odataDate(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : ""; // V4: "YYYY-MM-DD"
}

/**
 * Mapea la respuesta de error de SAP. Reintentable (solo lecturas): 429, 502, 503, 504 (y fallos de red, arriba).
 * Negocio: 404 -> NO_ENCONTRADA; 400/409/422 -> INVALIDA (o DUPLICADA si el mensaje lo indica). 401/403/otros -> técnico.
 * Forma del error V4 a verificar: `error.message` (cadena) y `error.details[]` (en V2 era `message.value` + `innererror.errordetails`).
 */
async function mapError(res: Response): Promise<SapError | S4HanaError> {
  let msg = `SAP respondió ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string | { value?: string }; details?: { message?: string; severity?: string }[]; innererror?: { errordetails?: { message?: string; severity?: string }[] } } };
    const dets = (j.error?.details ?? j.error?.innererror?.errordetails ?? []).filter((d) => !d.severity || d.severity === "error").map((d) => d.message).filter(Boolean);
    const top = typeof j.error?.message === "string" ? j.error.message : j.error?.message?.value;
    msg = dets.length ? dets.join(" | ") : (top ?? msg);
  } catch {
    /* cuerpo no JSON */
  }
  if ([429, 502, 503, 504].includes(res.status)) return new S4HanaError(msg, res.status, true);
  if (res.status === 404) return new SapError("NO_ENCONTRADA", msg);
  if (res.status === 409 || /already exists|ya existe|duplicate/i.test(msg)) return new SapError("DUPLICADA", msg);
  if (res.status === 400 || res.status === 422) return new SapError("INVALIDA", msg);
  return new S4HanaError(msg, res.status, false);
}
