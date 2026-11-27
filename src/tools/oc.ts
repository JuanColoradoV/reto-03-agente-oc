// Herramientas del agente (PRD 6.2). Cada export es una herramienta: el modelo la ve como `oc_<export>`.
// Contrato: { description, args (zod con .describe), execute(args, ctx) -> string JSON {ok:true,data}|{ok:false,error}, nunca lanza }.
// Fuente de verdad = servidor: el modelo solo elige el caso; paquete, derivados y payload se RECALCULAN aquí desde los fixtures.
import { z } from "zod";
import { generarEvidencia } from "../domain/evidencia";
import { CASO_RE } from "../domain/fixtures";
import { cargarMaestros, leerPaquete, type Resultado } from "../domain/paquete";
import { construirOrden } from "../domain/payload";
import { validar as validarReglas } from "../domain/reglas";
import type { Maestros, Paquete, Validacion } from "../domain/tipos";
import { canonico } from "../domain/util";
import { crearSap, servicios, type Servicios, type ToolCtx } from "./contexto";

export type { ToolCtx };

const ok = (data: unknown): string => JSON.stringify({ ok: true, data });
const fallo = (error: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ok: false, error, ...extra });

/** Envoltorio: ninguna herramienta lanza; un error inesperado se devuelve como {ok:false,error}. */
async function seguro(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return fallo(`Error interno de la herramienta: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface Base {
  sv: Servicios;
  paquete: Paquete;
  maestros: Maestros;
  validacion: Validacion;
}

async function cargar(caso: string, ctx: ToolCtx): Promise<Resultado<Base>> {
  if (!CASO_RE.test(caso)) return { ok: false, error: `Identificador de caso inválido: «${caso}».` };
  const sv = await servicios(ctx);
  const paquete = await leerPaquete(sv.fixtures, caso);
  if (!paquete.ok) return paquete;
  const maestros = await cargarMaestros(sv.fixtures);
  if (!maestros.ok) return maestros;
  return { ok: true, data: { sv, paquete: paquete.data, maestros: maestros.data, validacion: validarReglas(paquete.data, maestros.data) } };
}

const casoArg = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo «sol-004»");
const eco = (nombre: string) => `Opcional. Si lo envías se ignora: el servidor recalcula ${nombre} desde el caso (no se acepta nada del modelo).`;

export const leer_paquete = {
  description: "Lee y normaliza el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe); un adjunto ausente sale como null y su nombre en `faltantes`.",
  args: { caso: casoArg },
  async execute(args: { caso: string }, ctx: ToolCtx): Promise<string> {
    return seguro(async () => {
      if (!CASO_RE.test(args.caso)) return fallo(`Identificador de caso inválido: «${args.caso}».`);
      const sv = await servicios(ctx);
      const r = await leerPaquete(sv.fixtures, args.caso);
      return r.ok ? ok(r.data) : fallo(r.error);
    });
  },
};

export const validar = {
  description: "Aplica las reglas RC1–RC10 al caso y devuelve { apta, bloqueos[], confirmaciones[], derivados, retroactiva }; los bloqueos impiden crear la OC y las confirmaciones exigen la confirmación del usuario.",
  args: { caso: casoArg, paquete: z.unknown().optional().describe(eco("el paquete")) },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ToolCtx): Promise<string> {
    return seguro(async () => {
      const c = await cargar(args.caso, ctx);
      if (!c.ok) return fallo(c.error);
      return ok({ caso: args.caso, solicitud_id: c.data.paquete.solicitud.solicitud_id, ...c.data.validacion });
    });
  },
};

const RUTA_TRAZA = (caso: string) => `${caso}/trazabilidad.json`;

export const construir_payload = {
  description: "Construye el payload OrdenCompra exactamente como quedaría en SAP (válido contra su esquema), guarda su trazabilidad campo a campo y devuelve también las confirmaciones pendientes y los derivados.",
  args: { caso: casoArg, paquete: z.unknown().optional().describe(eco("el paquete")), derivados: z.unknown().optional().describe(eco("los derivados")) },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: ToolCtx): Promise<string> {
    return seguro(async () => {
      const c = await cargar(args.caso, ctx);
      if (!c.ok) return fallo(c.error);
      const { sv, paquete, maestros, validacion } = c.data;
      const r = await construirOrden({ paquete, maestros, validacion, confirmadoPor: null });
      if (!r.ok) return fallo(r.error, { bloqueos: validacion.bloqueos });
      await sv.store.escribir(RUTA_TRAZA(args.caso), JSON.stringify({ caso: args.caso, solicitud_id: paquete.solicitud.solicitud_id, campos: r.trazabilidad }, null, 2));
      await sv.store.escribir(`${args.caso}/payload.json`, JSON.stringify(r.payload, null, 2));
      return ok({
        caso: args.caso,
        payload: r.payload,
        trazabilidad: `out/${RUTA_TRAZA(args.caso)}`,
        confirmaciones: validacion.confirmaciones,
        derivados: validacion.derivados,
        retroactiva: validacion.retroactiva,
      });
    });
  },
};

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación del caso (out/<caso>/aprobacion.txt y aprobacion.pdf) y devuelve { ruta, sha256 }.",
  args: { caso: casoArg },
  async execute(args: { caso: string }, ctx: ToolCtx): Promise<string> {
    return seguro(async () => {
      const c = await cargar(args.caso, ctx);
      if (!c.ok) return fallo(c.error);
      const a = c.data.paquete.aprobacion;
      if (!a) return fallo("No hay correo de aprobación (aprobacion.json) en el paquete: no se puede generar la evidencia. Pide al solicitante el correo de aprobación.");
      return ok(await generarEvidencia(c.data.sv.store, args.caso, a, c.data.sv.ahora()));
    });
  },
};

const CSV_ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";

async function registrarControl(sv: Servicios, fila: { solicitud_id: string; resultado: "creada" | "idempotente" | "bloqueada" | "pendiente"; numero_oc: string | null; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] }): Promise<void> {
  if (!(await sv.store.leer("control.csv"))) await sv.store.agregarLinea("control.csv", CSV_ENCABEZADO);
  const campos = [fila.solicitud_id, fila.resultado, fila.numero_oc ?? "", String(fila.retroactiva), fila.bloqueos.join(";"), fila.confirmaciones.join(";"), sv.ahora().toISOString()];
  await sv.store.agregarLinea("control.csv", campos.join(","));
}

export const crear = {
  description: "Crea la OC en SAP simulado: solo si el caso es apto y, cuando hay confirmaciones, el usuario las confirmó (confirmado=true); es idempotente por solicitud y devuelve { numero_oc, fecha, idempotente }.",
  args: {
    caso: casoArg,
    payload: z.unknown().optional().describe("Opcional: el payload de oc_construir_payload. Si lo envías, el servidor lo compara con el que recalcula y RECHAZA la creación si difiere en cualquier valor."),
    confirmado: z.boolean().optional().describe("true solo si el usuario acaba de confirmar en el chat las confirmaciones pendientes. Sin confirmación humana registrada por el servidor, se ignora."),
  },
  async execute(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: ToolCtx): Promise<string> {
    return seguro(async () => {
      const c = await cargar(args.caso, ctx);
      if (!c.ok) return fallo(c.error);
      const { sv, paquete, maestros, validacion } = c.data;
      const sap = await crearSap(sv);
      if ("error" in sap) return fallo(sap.error);
      const solicitud_id = paquete.solicitud.solicitud_id;
      const base = { solicitud_id, retroactiva: validacion.retroactiva, bloqueos: validacion.bloqueos.map((b) => b.codigo), confirmaciones: validacion.confirmaciones.map((x) => x.codigo) };

      // Idempotencia: la misma solicitud devuelve su OC existente, sin crear otra.
      const existente = await sap.buscarOrdenPorReferencia(solicitud_id);
      if (existente) {
        const fecha = "fecha" in existente && typeof existente.fecha === "string" ? existente.fecha : null;
        await registrarControl(sv, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc });
        return ok({ numero_oc: existente.numero_oc, fecha, idempotente: true, retroactiva: validacion.retroactiva });
      }

      if (!validacion.apta) {
        await registrarControl(sv, { ...base, resultado: "bloqueada", numero_oc: null });
        return fallo(`OC NO creada: bloqueada por ${base.bloqueos.join(", ")}. ${validacion.bloqueos.map((b) => b.detalle).join(" ")}`, { bloqueos: validacion.bloqueos, acciones_sugeridas: validacion.bloqueos.map((b) => b.accion_sugerida) });
      }

      const hayConfirmaciones = validacion.confirmaciones.length > 0;
      const humano = ctx.confirmadoPor && (!ctx.confirmadoCaso || ctx.confirmadoCaso === args.caso) ? ctx.confirmadoPor : null;
      if (hayConfirmaciones && !(args.confirmado === true && humano)) {
        await registrarControl(sv, { ...base, resultado: "pendiente", numero_oc: null });
        return fallo("OC NO creada: hay confirmaciones pendientes y el usuario aún no las ha confirmado en el chat. Muéstraselas, termina el turno con una pregunta explícita y espera su confirmación.", { pendiente: true, confirmaciones: validacion.confirmaciones, derivados: validacion.derivados, retroactiva: validacion.retroactiva });
      }

      const construido = await construirOrden({ paquete, maestros, validacion, confirmadoPor: hayConfirmaciones ? humano : null });
      if (!construido.ok) return fallo(construido.error);
      if (args.payload !== undefined) {
        const sinConfirmador = (o: unknown) => canonico(JSON.parse(JSON.stringify(o), (k, v) => (k === "confirmado_por" ? null : v)));
        if (sinConfirmador(args.payload) !== sinConfirmador(construido.payload)) {
          await registrarControl(sv, { ...base, resultado: "bloqueada", numero_oc: null, bloqueos: ["PAYLOAD"] });
          return fallo("OC NO creada: el payload recibido no coincide con el que el servidor calcula desde el caso (montos y datos solo salen de las herramientas). Vuelve a llamar a oc_construir_payload y no modifiques sus valores.", { bloqueos: [{ codigo: "PAYLOAD", detalle: "payload alterado" }] });
        }
      }

      const prov = await sap.consultarProveedor(construido.payload.proveedor.nit);
      if (!prov?.activo) return fallo("SAP no reconoce al proveedor como activo; no se crea la OC.");
      const evidencia = await generarEvidencia(sv.store, args.caso, paquete.aprobacion!, sv.ahora());
      const { numero_oc, fecha } = await sap.crearOrden(construido.payload);
      await registrarControl(sv, { ...base, resultado: "creada", numero_oc });
      return ok({ numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: evidencia.ruta, evidencia_pdf: evidencia.ruta_pdf, confirmado_por: hayConfirmaciones ? humano : null });
    });
  },
};
