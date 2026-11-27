// Tools del agente de OC. Estructura: schema zod -> handler fino que delega en src/domain y src/sap.
// [TODO: ajustar descripciones/schemas cuando llegue el PRD; la logica de negocio va en src/domain]
import { z } from "zod";
import { cargarCaso, cargarMaestros, listCases } from "../domain/casos";
import { validarControles } from "../domain/controles";
import { fmt } from "../domain/dinero";
import { BusinessError, CODIGO, MSG_APROBACION_OBSOLETA } from "../domain/errores";
import { huellaAprobacion } from "../domain/huella";
import { prepararOrden, vistaOrden } from "../domain/ordenes";
import type { CrearOrdenInput, ResultadoControl } from "../domain/types";
import type { ControlCtx } from "../domain/controles";
import { defineTool, type ToolContext, type ToolDef } from "./registry";

/**
 * Contexto de los controles: la OC de ESTA solicitud, consultada puntualmente en SAP (filtro por referencia en origen),
 * y la fecha de negocio. Nunca se descarga un listado global para decidir duplicados.
 */
async function ctxControles(ctx: ToolContext, solicitudId: string): Promise<ControlCtx> {
  const existente = await ctx.sap.buscarPorSolicitud(solicitudId);
  return { ordenes: existente ? [existente] : [], fecha: ctx.fecha };
}

export const listarSolicitudes = defineTool({
  name: "listar_solicitudes",
  description: "Lista las solicitudes de compra disponibles (id, asunto del correo, solicitante).",
  input: z.object({}),
  requiresConfirmation: false,
  handler: () =>
    listCases().map((id) => {
      const c = cargarCaso(id);
      return { id, asunto: c.correo.asunto ?? null, solicitante: c.solicitud.solicitante ?? null };
    }),
});

export const leerSolicitud = defineTool({
  name: "leer_solicitud",
  description:
    "Lee todos los documentos de una solicitud: correo, solicitud, cotización (texto), aprobación y factura (null si no existe).",
  input: z.object({ id: z.string().describe("ID de la solicitud, por ejemplo sol-001") }),
  requiresConfirmation: false,
  handler: ({ id }) => cargarCaso(id),
});

export const validarControlesTool = defineTool({
  name: "validar_controles",
  description:
    "Ejecuta los controles de la solicitud. Devuelve la lista de {id, nombre, resultado: OK|FALLA|ALERTA, detalle} y si es aprobable (sin FALLAS).",
  input: z.object({ id: z.string() }),
  requiresConfirmation: false,
  handler: async ({ id }, ctx) => validarControles(cargarCaso(id), cargarMaestros(), await ctxControles(ctx, id)),
});

const errorControles = (controles: ResultadoControl[]) =>
  `No se puede crear la OC. Controles en FALLA: ${controles.filter((c) => c.resultado === "FALLA").map((c) => `${c.id} ${c.nombre}: ${c.detalle}`).join(" | ")}`;

export const crearOrdenCompra = defineTool({
  name: "crear_orden_compra",
  description:
    "Crea la orden de compra en SAP para una solicitud. Solo indica el id de la solicitud: el sistema arma la OC " +
    "(proveedor, centro de costo, líneas y total) desde los documentos, no desde tu texto. Requiere confirmación humana: " +
    "primero se validan los controles; si alguno bloquea, recibirás un error y no se molesta a la persona.",
  // Sin campos de texto libre: el modelo no puede escribir notas en SAP (solo el comentario de la persona que aprueba).
  input: z.object({
    solicitudId: z.string().describe("ID de la solicitud, por ejemplo sol-001"),
  }),
  requiresConfirmation: true,
  // Recibo estructurado y pequeno: se guarda aparte del detalle tecnico (que puede truncarse) y sobrevive a recargas.
  recibo: (o) => {
    const x = o as Partial<CrearOrdenInput & { numero: string }> | null;
    if (!x || typeof x !== "object" || !x.numero) return undefined;
    const { numero, solicitudId, proveedorId, centroCosto, moneda, total, fecha, items, comentarioAprobador } = x;
    return { numero, solicitudId, proveedorId, centroCosto, moneda, total, fecha, ...(items ? { items } : {}), ...(comentarioAprobador ? { comentarioAprobador } : {}) };
  },
  preflight: async ({ solicitudId }, ctx) => {
    const caso = cargarCaso(solicitudId); // lanza BusinessError si no existe
    const maestros = cargarMaestros();
    // C0 (OC existente) se evalua contra el SAP de la sesion: si ya hay OC, es FALLA antes de molestar a la persona.
    const prep = prepararOrden(caso, maestros, ctx.fecha, await ctxControles(ctx, solicitudId));
    if (!prep.orden) return { ok: false, error: errorControles(prep.controles), code: CODIGO.CONTROLES_FALLA };
    return {
      ok: true,
      data: { orden: prep.orden },
      vista: vistaOrden(prep.orden, prep.controles, maestros, caso),
      resumen: `Crear OC en SAP para ${solicitudId}: ${fmt(prep.orden.total, prep.orden.moneda)}.`,
      huella: await huellaAprobacion(prep.orden, prep.controles, caso, maestros),
    };
  },
  handler: async ({ solicitudId }, ctx, run) => {
    // Defensa en profundidad (la huella la comprueba el bucle antes): se revalida (incluida C0 contra el SAP actual)
    // y se compara con lo que la persona vio y aprobo.
    const prep = prepararOrden(cargarCaso(solicitudId), cargarMaestros(), ctx.fecha, await ctxControles(ctx, solicitudId));
    if (!prep.orden) throw new BusinessError(CODIGO.CONTROLES_FALLA, errorControles(prep.controles));
    const guardada = (run.preflight as { orden?: CrearOrdenInput } | undefined)?.orden;
    if (!guardada) throw new BusinessError("PREFLIGHT_FALTANTE", "Falta la orden validada previamente (preflight).");
    // La fecha de emision NO entra en la comparacion (cambia si se aprueba despues de medianoche): se asigna al crear.
    const { fecha: _fechaAprobada, ...aprobada } = guardada;
    const { fecha, ...actual } = prep.orden;
    if (JSON.stringify(aprobada) !== JSON.stringify(actual)) {
      throw new BusinessError(CODIGO.APROBACION_OBSOLETA, MSG_APROBACION_OBSOLETA);
    }
    const nota = run.comentarioAprobador?.trim();
    // La verificacion atomica final (idempotencia por solicitud) vive en el SAP: SapError DUPLICADA.
    return ctx.sap.crearOrdenCompra({ ...aprobada, fecha, ...(nota ? { comentarioAprobador: nota } : {}) });
  },
});

export const consultarOrden = defineTool({
  name: "consultar_orden",
  description: "Consulta una orden de compra en SAP por número.",
  input: z.object({ numero: z.string() }),
  requiresConfirmation: false,
  handler: async ({ numero }, ctx) =>
    (await ctx.sap.consultarOrden(numero)) ?? { error: `OC ${numero} no encontrada` },
});

export const listarOrdenes = defineTool({
  name: "listar_ordenes",
  description: "Lista las órdenes de compra creadas en SAP en esta sesión.",
  input: z.object({}),
  requiresConfirmation: false,
  handler: (_i, ctx) => ctx.sap.listarOrdenes(),
});

export const ocTools: ToolDef[] = [
  listarSolicitudes,
  leerSolicitud,
  validarControlesTool,
  crearOrdenCompra,
  consultarOrden,
  listarOrdenes,
];
