import { getJson, getText, hasFile, listCases } from "../data/repo";
import type { Aprobacion, CasoSolicitud, Correo, Maestros, Proveedor, Solicitud } from "./types";

export { listCases };

export function cargarCaso(id: string): CasoSolicitud {
  if (!listCases().includes(id)) throw new Error(`Solicitud no encontrada: ${id}`);
  const dir = `solicitudes/${id}/`;
  return {
    id,
    correo: getJson<Correo>(dir + "correo.json"),
    solicitud: getJson<Solicitud>(dir + "solicitud.json"),
    cotizacion: getText(dir + "cotizacion.txt"),
    aprobacion: hasFile(dir + "aprobacion.json") ? getJson<Aprobacion>(dir + "aprobacion.json") : null,
    factura: hasFile(dir + "factura.txt") ? getText(dir + "factura.txt") : null,
  };
}

/** Maestro opcional: se carga si el archivo existe (maestros/<nombre>.json); si falta, undefined (sin error). */
const opcional = (nombre: string): unknown => (hasFile(`maestros/${nombre}.json`) ? getJson<unknown>(`maestros/${nombre}.json`) : undefined);

export function cargarMaestros(): Maestros {
  const m: Maestros = { proveedores: getJson<Proveedor[]>("maestros/proveedores.json") };
  const centrosCosto = opcional("centros-costo");
  const indicadoresIva = opcional("indicadores-iva");
  const condicionesPago = opcional("condiciones-pago");
  if (centrosCosto !== undefined) m.centrosCosto = centrosCosto;
  if (indicadoresIva !== undefined) m.indicadoresIva = indicadoresIva;
  if (condicionesPago !== undefined) m.condicionesPago = condicionesPago;
  return m;
}
