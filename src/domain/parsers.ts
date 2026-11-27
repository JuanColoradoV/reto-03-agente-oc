// Parsers del texto de los adjuntos (cotizacion.txt, factura.txt, aprobacion.json). Puros y sin dependencias.
import type { Aprobacion, Cotizacion, Factura } from "./tipos";

/** "900.555.111-2" -> "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(raw: string): string {
  const base = raw.trim().split("-")[0] ?? "";
  return base.replace(/\D/g, "");
}

/** Monto en formato colombiano: "11.400.000" -> 11400000; "1.234,56" -> 1234.56. null si no es numérico. */
export function parseMonto(raw: string): number | null {
  let s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const sumarDias = (fecha: string, dias: number): string => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

export type Parseo<T> = { ok: true; valor: T } | { ok: false; error: string };

export function parseCotizacion(texto: string): Parseo<Cotizacion> {
  const proveedor = texto.match(/^Proveedor:\s*(.+)$/m)?.[1]?.trim();
  const total = texto.match(/^TOTAL[^:\n]*:\s*(?:(COP|USD)\s*)?([\d.,]+)/im);
  if (!proveedor) return { ok: false, error: "cotizacion.txt: no se encontró la línea «Proveedor:»." };
  const monto = total?.[2] ? parseMonto(total[2]) : null;
  if (monto === null) return { ok: false, error: "cotizacion.txt: no se encontró un TOTAL numérico." };
  const nitRaw = texto.match(/^NIT:\s*([\d.\-]+)/m)?.[1];
  const fecha = texto.match(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
  const dias = texto.match(/^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)?.[1];
  const hasta = texto.match(/^Validez[^:\n]*:\s*(?:hasta\s*)?(\d{4}-\d{2}-\d{2})/im)?.[1];
  const validez_hasta = hasta ?? (fecha && dias ? sumarDias(fecha, Number(dias)) : null);
  const referencia = texto.match(/^COTIZACI[ÓO]N\s+(\S+)/im)?.[1] ?? null;
  return {
    ok: true,
    valor: { proveedor, nit: nitRaw ? normalizarNit(nitRaw) : null, total: monto, moneda: total?.[1] ?? "COP", validez_hasta, texto, referencia },
  };
}

export function parseFactura(texto: string): Parseo<Factura> {
  const numero = texto.match(/No\.?\s*([A-Z0-9][A-Z0-9-]*)/)?.[1];
  const fecha = texto.match(/^Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/im)?.[1];
  const total = texto.match(/^TOTAL[^:\n]*:\s*(?:(?:COP|USD)\s*)?([\d.,]+)/im)?.[1];
  const monto = total ? parseMonto(total) : null;
  if (!numero || !fecha || monto === null) return { ok: false, error: "factura.txt: no se pudo leer número, fecha o total." };
  return { ok: true, valor: { numero, fecha, total: monto } };
}

/** El correo aprueba si su cuerpo contiene "Aprobado" y no lo niega ("no aprobado"). */
export function esAprobado(cuerpo: string): boolean {
  return /\bAprobado\b/i.test(cuerpo) && !/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo);
}

export function aprobacionDesdeJson(j: { de: string; para: string; fecha: string; asunto: string; cuerpo: string }): Aprobacion {
  return { de: j.de, para: j.para, fecha: j.fecha, asunto: j.asunto, aprobado: esAprobado(j.cuerpo), texto: j.cuerpo };
}

/** "Mariana <mlopez@x.com>" -> "mlopez@x.com" (minúsculas). */
export const emailDe = (de: string): string => (de.match(/<([^>]+)>/)?.[1] ?? de).trim().toLowerCase();
