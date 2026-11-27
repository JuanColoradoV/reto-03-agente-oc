// Parser DETERMINISTA de cotizacion.txt (texto libre).
// !!! STUB: [TODO: implementar contra el formato real de cotizacion.txt cuando llegue el PRD/fixtures] !!!
// Hoy entiende el formato del fixture de ejemplo:
//   COTIZACION 0001 - Proveedor Demo SAS
//   10 x Silla de oficina ergonomica @ 250.000
//   TOTAL: 2500000 COP
// Devuelve lo que pudo leer y la lista de campos que NO pudo (para decidir si usar el fallback LLM,
// ver src/llm/extract.ts). Es puro: sin IO ni LLM.

export interface ItemCotizado {
  cantidad: number;
  descripcion: string;
  precioUnitario: number;
}

export interface CotizacionParseada {
  numero?: string;
  proveedor?: string;
  moneda?: string;
  items: ItemCotizado[];
  total?: number;
}

export type CampoCotizacion = "numero" | "proveedor" | "items" | "total" | "moneda";

export interface ParseoCotizacion {
  campos: CotizacionParseada;
  /** Campos que el parser no pudo extraer. */
  noParseados: CampoCotizacion[];
}

/** "2.500.000" / "2,500,000" / "2500000" / "1.234,56" -> numero. null si no es un monto. */
export function parseMonto(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/[.,]/g, "") + (m[2] ? "." + m[2] : ""));
  return Number.isFinite(n) ? n : null;
}

export function parseCotizacion(texto: string): ParseoCotizacion {
  const campos: CotizacionParseada = { items: [] };

  const head = texto.match(/^\s*COTIZACI[OÓ]N\s+(\S+)\s*-\s*(.+?)\s*$/im);
  if (head) {
    campos.numero = head[1];
    campos.proveedor = head[2];
  }

  for (const line of texto.split(/\r?\n/)) {
    const it = line.match(/^\s*(\d+(?:[.,]\d+)?)\s*x\s+(.+?)\s*@\s*([\d.,]+)\s*$/i);
    if (!it) continue;
    const cantidad = parseMonto(it[1] ?? "");
    const precio = parseMonto(it[3] ?? "");
    if (cantidad !== null && precio !== null && it[2]) {
      campos.items.push({ cantidad, descripcion: it[2], precioUnitario: precio });
    }
  }

  const tot = texto.match(/TOTAL:?\s*([\d.,]+)\s*([A-Z]{3})?/i);
  if (tot?.[1]) {
    const t = parseMonto(tot[1]);
    if (t !== null) campos.total = t;
    if (tot[2]) campos.moneda = tot[2].toUpperCase();
  }

  const noParseados: CampoCotizacion[] = [];
  if (!campos.numero) noParseados.push("numero");
  if (!campos.proveedor) noParseados.push("proveedor");
  if (campos.items.length === 0) noParseados.push("items");
  if (campos.total === undefined) noParseados.push("total");
  if (!campos.moneda) noParseados.push("moneda");
  return { campos, noParseados };
}
