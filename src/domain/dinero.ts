// Dinero en unidades menores enteras (centavos): evita igualdad de floats (0.1 + 0.2 !== 0.3).
// Los montos "mayores" (los de los fixtures/OC) se convierten con redondeo a 2 decimales.
// [TODO: si el PRD define monedas sin decimales o tolerancias de cotizacion, ajustar aqui.]
import type { ItemSolicitud } from "./types";

export const toMinor = (n: number): number => Math.round(n * 100);
export const fromMinor = (m: number): number => m / 100;
export const lineaMinor = (it: ItemSolicitud): number => Math.round(it.cantidad * it.precioUnitario * 100);
export const totalMinor = (items: ItemSolicitud[]): number => items.reduce((s, it) => s + lineaMinor(it), 0);
export const fmt = (n: number, moneda: string): string => `${n.toLocaleString("es-CO")} ${moneda}`;

// ---- Precision admitida (lo que se muestra es EXACTAMENTE lo que se graba) ----
// [TODO: PRD] Decimales reales por unidad de medida y moneda; estos limites son los del esqueleto SAP (cantidad 3, precio 2).
export const MAX_DEC_CANTIDAD = 3;
export const MAX_DEC_PRECIO = 2;

const conDecimales = (x: number, max: number): boolean => Number.isFinite(x) && Number(x.toFixed(max)) === x;

/** Valida cantidades y precios ANTES del preflight. Devuelve un mensaje por cada problema (vacio = valido). */
export function validarItems(items: ItemSolicitud[]): string[] {
  const errs: string[] = [];
  items.forEach((it, i) => {
    const n = `Línea ${i + 1}`;
    if (!Number.isFinite(it.cantidad) || it.cantidad <= 0) errs.push(`${n}: la cantidad debe ser un número positivo.`);
    else if (!conDecimales(it.cantidad, MAX_DEC_CANTIDAD)) errs.push(`${n}: la cantidad admite como máximo ${MAX_DEC_CANTIDAD} decimales (recibido ${it.cantidad}).`);
    if (!Number.isFinite(it.precioUnitario) || it.precioUnitario < 0) errs.push(`${n}: el precio unitario debe ser un número no negativo.`);
    else if (!conDecimales(it.precioUnitario, MAX_DEC_PRECIO)) errs.push(`${n}: el precio unitario admite como máximo ${MAX_DEC_PRECIO} decimales (recibido ${it.precioUnitario}).`);
  });
  return errs;
}
