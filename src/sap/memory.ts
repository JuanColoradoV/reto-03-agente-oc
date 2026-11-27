import type { OrdenCompra } from "../domain/types";
import { SapError, type CrearOrdenInput, type SapAdapter } from "./adapter";

export interface SapData {
  seq: number;
  ordenes: OrdenCompra[];
}

/**
 * SAP simulado sobre un objeto de datos (`SapData`). Numeracion secuencial determinista (4500000001, ...).
 * - InMemorySap: datos propios (demo.ts y pruebas).
 * - En produccion de la demo se le pasa el `SapData` del estado de la sesion (Durable Object):
 *   ver src/agent/state.ts. Asi cada sesion tiene su propia numeracion y sus propias OC.
 */
export class InMemorySap implements SapAdapter {
  constructor(private data: SapData = { seq: 0, ordenes: [] }) {}

  async crearOrdenCompra(input: CrearOrdenInput): Promise<OrdenCompra> {
    if (input.items.length === 0) throw new SapError("INVALIDA", "La OC no tiene posiciones.");
    // Idempotencia: una solicitud genera a lo sumo una OC (dentro de la sesion).
    const existente = this.data.ordenes.find((o) => o.solicitudId === input.solicitudId);
    if (existente) throw new SapError("DUPLICADA", `La solicitud ${input.solicitudId} ya tiene la OC ${existente.numero}.`);
    const numero = String(4500000001 + this.data.seq++);
    const oc: OrdenCompra = { numero, ...input };
    this.data.ordenes.push(oc);
    return structuredClone(oc);
  }

  async consultarOrden(numero: string): Promise<OrdenCompra | null> {
    const oc = this.data.ordenes.find((o) => o.numero === numero);
    return oc ? structuredClone(oc) : null;
  }

  async buscarPorSolicitud(solicitudId: string): Promise<OrdenCompra | null> {
    const oc = this.data.ordenes.find((o) => o.solicitudId === solicitudId);
    return oc ? structuredClone(oc) : null;
  }

  async listarOrdenes(): Promise<OrdenCompra[]> {
    return this.data.ordenes.map((o) => structuredClone(o));
  }
}
