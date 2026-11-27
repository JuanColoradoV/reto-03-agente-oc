import { z } from "zod";
import { BusinessError, CODIGO } from "./errores";
import { getJson, getText, hasFile, listCases } from "../data/repo";
import type { Aprobacion, CasoSolicitud, Correo, Maestros, Proveedor, Solicitud } from "./types";

export { listCases };

// Validacion de FORMA de los fixtures al cargarlos (no de reglas de negocio: esas son controles, ver ordenes.ts).
// `looseObject`: se toleran campos extra (p. ej. `_placeholder`). Un archivo corrupto falla aqui con la ruta y el campo,
// no mas adelante con un TypeError. [TODO: ajustar al esquema real del PRD]
const num = z.number().finite();
const itemSchema = z.object({ descripcion: z.string(), cantidad: num, precioUnitario: num });
const solicitudSchema = z.looseObject({
  id: z.string(),
  solicitante: z.string().optional(),
  proveedorId: z.string(),
  centroCosto: z.string(),
  moneda: z.string(),
  items: z.array(itemSchema),
});
const correoSchema = z.looseObject({ de: z.string().optional(), asunto: z.string().optional(), cuerpo: z.string().optional() });
const aprobacionSchema = z.looseObject({ aprobada: z.boolean(), aprobador: z.string().optional(), montoAprobado: num.optional(), fecha: z.string().optional() });
const proveedoresSchema = z.array(z.looseObject({ id: z.string(), nombre: z.string(), nit: z.string().optional(), activo: z.boolean().optional(), bloqueado: z.boolean().optional() }));

/** Parsea con zod y, si falla, lanza un Error (TECNICO: dato corrupto) que nombra el archivo y cada campo con problema. */
export function validarFixture<T>(schema: z.ZodType, ruta: string, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data as T;
  const det = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
  throw new Error(`Fixture inválido (${ruta}): ${det}`);
}

export function cargarCaso(id: string): CasoSolicitud {
  if (!listCases().includes(id)) throw new BusinessError(CODIGO.SOLICITUD_NO_ENCONTRADA, `Solicitud no encontrada: ${id}`);
  const dir = `solicitudes/${id}/`;
  return {
    id,
    correo: validarFixture<Correo>(correoSchema, dir + "correo.json", getJson(dir + "correo.json")),
    solicitud: validarFixture<Solicitud>(solicitudSchema, dir + "solicitud.json", getJson(dir + "solicitud.json")),
    cotizacion: getText(dir + "cotizacion.txt"),
    aprobacion: hasFile(dir + "aprobacion.json") ? validarFixture<Aprobacion>(aprobacionSchema, dir + "aprobacion.json", getJson(dir + "aprobacion.json")) : null,
    factura: hasFile(dir + "factura.txt") ? getText(dir + "factura.txt") : null,
  };
}

/** Maestro opcional: se carga si el archivo existe (maestros/<nombre>.json); si falta, undefined (sin error). */
const opcional = (nombre: string): unknown => (hasFile(`maestros/${nombre}.json`) ? getJson<unknown>(`maestros/${nombre}.json`) : undefined);

export function cargarMaestros(): Maestros {
  const m: Maestros = { proveedores: validarFixture<Proveedor[]>(proveedoresSchema, "maestros/proveedores.json", getJson("maestros/proveedores.json")) };
  const centrosCosto = opcional("centros-costo");
  const indicadoresIva = opcional("indicadores-iva");
  const condicionesPago = opcional("condiciones-pago");
  if (centrosCosto !== undefined) m.centrosCosto = centrosCosto;
  if (indicadoresIva !== undefined) m.indicadoresIva = indicadoresIva;
  if (condicionesPago !== undefined) m.condicionesPago = condicionesPago;
  return m;
}
