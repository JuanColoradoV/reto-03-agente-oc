// Interfaz del adaptador SAP (PRD 7.4). La implementación simulada está en mock.ts; el diseño real, en SOLUCION.md.
import type { OrdenCompra } from "../domain/tipos";

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}

export type { OrdenCompra };
