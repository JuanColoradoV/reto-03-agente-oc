// Validacion de DATOS de la solicitud (no son reglas de negocio del PRD): invariantes minimos para poder grabar una OC y
// cantidades/precios con la precision admitida. Alimenta el control V0, que evalua `evaluarControles` (asi `validar_controles` y
// `prepararOrden` nunca se contradicen). Funcion pura.
import { validarItems } from "./dinero";
import type { CasoSolicitud } from "./types";

/** Invariantes estructurales de la solicitud (campos vacios, sin lineas). Las cantidades/precios los valida `validarItems`. */
export function invariantesOrden(caso: CasoSolicitud): string[] {
  const s = caso.solicitud;
  const errs: string[] = [];
  if (s.items.length === 0) errs.push("La solicitud no tiene líneas.");
  if (!s.proveedorId.trim()) errs.push("La solicitud no indica proveedor.");
  if (!s.centroCosto.trim()) errs.push("La solicitud no indica centro de costo.");
  if (!s.moneda.trim()) errs.push("La solicitud no indica moneda.");
  s.items.forEach((it, i) => {
    if (!it.descripcion.trim()) errs.push(`Línea ${i + 1}: falta la descripción.`);
  });
  return errs;
}

/** Problemas de datos de la solicitud (vacío = válida). */
export const problemasDeDatos = (caso: CasoSolicitud): string[] => [...invariantesOrden(caso), ...validarItems(caso.solicitud.items)];
