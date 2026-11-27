// Contrato del SAP. La implementacion real (BAPI_PO_CREATE1 / OData API_PURCHASEORDER_PROCESS_SRV)
// viviria detras de esta misma interfaz; ver SOLUCION.md.
import type { CrearOrdenInput, OrdenCompra } from "../domain/types";

export type { CrearOrdenInput } from "../domain/types";

export class SapError extends Error {
  constructor(
    public code: "DUPLICADA" | "NO_ENCONTRADA" | "INVALIDA",
    message: string,
  ) {
    super(message);
  }
}

export interface SapAdapter {
  crearOrdenCompra(input: CrearOrdenInput): Promise<OrdenCompra>;
  consultarOrden(numero: string): Promise<OrdenCompra | null>;
  listarOrdenes(): Promise<OrdenCompra[]>;
}
