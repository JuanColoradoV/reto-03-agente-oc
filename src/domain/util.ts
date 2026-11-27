// Utilidades puras: hash, dinero en unidades menores enteras, JSON canónico.
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Monto -> unidades menores enteras (centavos): evita comparar floats. */
export const toMinor = (n: number): number => Math.round(n * 100);

/** JSON con claves ordenadas: sirve para comparar objetos por contenido. */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const soloFecha = (iso: string): string => iso.slice(0, 10);

export const formatoMonto = (n: number, moneda: string): string => `${n.toLocaleString("es-CO")} ${moneda}`;
