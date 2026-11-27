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

export function cargarMaestros(): Maestros {
  return {
    proveedores: getJson<Proveedor[]>("maestros/proveedores.json"),
  };
}
