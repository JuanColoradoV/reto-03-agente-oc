// Tools del agente de OC. Estructura: schema zod -> handler fino que delega en src/domain y src/sap.
// [TODO: ajustar descripciones/schemas cuando llegue el PRD; la logica de negocio va en src/domain]
import { z } from "zod";
import { cargarCaso, cargarMaestros, listCases } from "../domain/casos";
import { validarControles } from "../domain/controles";
import { fmt } from "../domain/dinero";
import { prepararOrden, vistaOrden } from "../domain/ordenes";
import type { CrearOrdenInput, ResultadoControl } from "../domain/types";
import { defineTool, type ToolDef } from "./registry";

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
  handler: async ({ id }, ctx) => validarControles(cargarCaso(id), cargarMaestros(), { ordenes: await ctx.sap.listarOrdenes() }),
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
  preflight: async ({ solicitudId }, ctx) => {
    const caso = cargarCaso(solicitudId); // lanza si no existe: preflightTool lo convierte en error para el modelo
    const maestros = cargarMaestros();
    // C0 (OC existente) se evalua contra el SAP de la sesion: si ya hay OC, es FALLA antes de molestar a la persona.
    const prep = prepararOrden(caso, maestros, ctx.fecha, { ordenes: await ctx.sap.listarOrdenes() });
    if (!prep.orden) return { ok: false, error: errorControles(prep.controles) };
    return {
      ok: true,
      data: { orden: prep.orden },
      vista: vistaOrden(prep.orden, prep.controles, maestros),
      resumen: `Crear OC en SAP para ${solicitudId}: ${fmt(prep.orden.total, prep.orden.moneda)}.`,
    };
  },
  handler: async ({ solicitudId }, ctx, run) => {
    // Defensa en profundidad: se revalida (incluida C0 contra el SAP actual) y se compara con lo que la persona vio y aprobo.
    const prep = prepararOrden(cargarCaso(solicitudId), cargarMaestros(), ctx.fecha, { ordenes: await ctx.sap.listarOrdenes() });
    if (!prep.orden) throw new Error(errorControles(prep.controles));
    const guardada = (run.preflight as { orden?: CrearOrdenInput } | undefined)?.orden;
    if (!guardada) throw new Error("Falta la orden validada previamente (preflight).");
    // La fecha de emision NO entra en la comparacion (cambia si se aprueba despues de medianoche): se asigna al crear.
    const { fecha: _fechaAprobada, ...aprobada } = guardada;
    const { fecha, ...actual } = prep.orden;
    if (JSON.stringify(aprobada) !== JSON.stringify(actual)) {
      throw new Error("Los datos de la solicitud cambiaron desde la aprobación; vuelve a validar.");
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
