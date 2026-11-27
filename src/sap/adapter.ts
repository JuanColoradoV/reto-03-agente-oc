// Contrato del SAP. La implementacion real (OData V4 API_PURCHASEORDER_2 en S/4HANA Cloud; V2 o BAPI_PO_CREATE1 como
// alternativa en releases anteriores) viviria detras de esta misma interfaz; ver SOLUCION.md.
import type { CrearOrdenInput, OrdenCompra } from "../domain/types";

export type { CrearOrdenInput } from "../domain/types";

export class SapError extends Error {
  constructor(
    public code: "DUPLICADA" | "NO_ENCONTRADA" | "INVALIDA" | "EN_PROCESO" | "INCIERTA",
    message: string,
  ) {
    super(message);
  }
}

export interface SapAdapter {
  crearOrdenCompra(input: CrearOrdenInput): Promise<OrdenCompra>;
  consultarOrden(numero: string): Promise<OrdenCompra | null>;
  /**
   * Busca la OC de UNA solicitud por su referencia. Es la consulta que usan los controles (C0) y el preflight: una lectura
   * puntual y filtrada en origen (en S/4HANA un `$filter` por referencia externa), nunca un barrido de las ultimas N ordenes.
   */
  buscarPorSolicitud(solicitudId: string): Promise<OrdenCompra | null>;
  /** Listado completo (UI/diagnostico). NO usar para decidir duplicados: en un SAP real es paginado y acotado. */
  listarOrdenes(): Promise<OrdenCompra[]>;
}

/**
 * DISENO (sin implementar): simulacion REAL contra SAP, operacion separada de `crearOrdenCompra`. Seria la unica forma de mostrar
 * a la persona los avisos de negocio de SAP (precios, impuestos, presupuesto) antes de aprobar; p. ej. BAPI_PO_CREATE1 con
 * TESTRUN = 'X' vía un servicio intermedio, con el BAPIRET2 devuelto. No existe equivalente nativo en OData: la comprobacion
 * local de S4HanaSap (payload + busqueda de duplicados) NO sustituye a esto.
 */
export interface SapSimulacion {
  simularOrdenCompra(input: CrearOrdenInput): Promise<{ errores: string[]; avisos: string[] }>;
}
