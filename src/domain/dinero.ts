// Dinero en unidades menores enteras (centavos): evita igualdad de floats (0.1 + 0.2 !== 0.3).
// Los montos "mayores" (los de los fixtures/OC) se convierten con redondeo a 2 decimales.
// [TODO: si el PRD define monedas sin decimales o tolerancias de cotizacion, ajustar aqui.]
import type { ItemSolicitud } from "./types";

export const toMinor = (n: number): number => Math.round(n * 100);
export const fromMinor = (m: number): number => m / 100;
export const lineaMinor = (it: ItemSolicitud): number => Math.round(it.cantidad * it.precioUnitario * 100);
export const totalMinor = (items: ItemSolicitud[]): number => items.reduce((s, it) => s + lineaMinor(it), 0);
export const fmt = (n: number, moneda: string): string => `${n.toLocaleString("es-CO")} ${moneda}`;
