// Huella de lo que la persona vio al aprobar: SHA-256 de (OC sin fecha + resultados de controles + documentos de la solicitud
// + registro del proveedor en el maestro). Si al confirmar la huella recalculada difiere, la aprobacion ya no vale.
import type { CasoSolicitud, CrearOrdenInput, Maestros, ResultadoControl } from "./types";

/** JSON canonico (claves ordenadas): la misma informacion siempre produce la misma cadena. */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** La fecha de emision no entra (cambia si se aprueba despues de medianoche y se asigna al crear). */
export function huellaAprobacion(orden: CrearOrdenInput, controles: ResultadoControl[], caso: CasoSolicitud, maestros: Maestros): Promise<string> {
  const { fecha: _f, ...sinFecha } = orden;
  const proveedor = maestros.proveedores.find((p) => p.id === orden.proveedorId) ?? null;
  return sha256Hex(canonico({ orden: sinFecha, controles, documentos: caso, proveedor }));
}
