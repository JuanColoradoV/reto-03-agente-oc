// Tipos del dominio. [TODO: ajustar a la forma real de los fixtures cuando lleguen]
export interface Proveedor {
  id: string;
  nombre: string;
  nit?: string;
  activo?: boolean;
  bloqueado?: boolean;
}

export interface ItemSolicitud {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
}

export interface Solicitud {
  id: string;
  solicitante?: string;
  proveedorId: string;
  centroCosto: string;
  moneda: string;
  items: ItemSolicitud[];
}

export interface Aprobacion {
  aprobada: boolean;
  aprobador?: string;
  montoAprobado?: number;
  fecha?: string;
}

export interface Correo {
  de?: string;
  asunto?: string;
  cuerpo?: string;
}

export interface CasoSolicitud {
  id: string;
  correo: Correo;
  solicitud: Solicitud;
  cotizacion: string;
  aprobacion: Aprobacion | null;
  factura: string | null;
}

/**
 * Maestros. `proveedores` es obligatorio; los otros tres son OPCIONALES hasta que llegue el PRD: se cargan si el archivo
 * existe en fixtures/reto-03/maestros/ y su forma es `unknown` a propósito (no inventar el esquema).
 * [TODO: tipar con la forma real de centros-costo.json, indicadores-iva.json y condiciones-pago.json]
 */
export interface Maestros {
  proveedores: Proveedor[];
  centrosCosto?: unknown;
  indicadoresIva?: unknown;
  condicionesPago?: unknown;
}

/** Severidad de un control: un incumplimiento bloqueante da FALLA; uno de alerta da ALERTA. */
export type Severidad = "bloqueante" | "alerta";
export type Veredicto = "OK" | "FALLA" | "ALERTA";

/** Resultado de evaluar UN control sobre UN caso. */
export interface ResultadoControl {
  id: string;
  nombre: string;
  /** Qué verifica el control, en lenguaje llano. */
  descripcion?: string;
  /** Qué hacer si el control falla, en lenguaje llano. */
  accion?: string;
  severidad: Severidad;
  resultado: Veredicto;
  detalle: string;
}

export interface ResumenControles {
  controles: ResultadoControl[];
  fallas: number;
  alertas: number;
  /** true si no hay ninguna FALLA (las ALERTAs requieren atencion humana pero no bloquean). */
  aprobable: boolean;
}

/** Entrada de SAP para crear una OC. La construye el SERVIDOR (prepararOrden), nunca el modelo. */
export interface CrearOrdenInput {
  solicitudId: string;
  proveedorId: string;
  centroCosto: string;
  moneda: string;
  items: ItemSolicitud[];
  total: number;
  /** Fecha del documento, inyectada por el llamador (determinismo). */
  fecha: string;
  /** Comentario de la PERSONA que aprobo (campo propio; el modelo no puede escribir notas en SAP). */
  comentarioAprobador?: string;
}

export interface OrdenCompra extends CrearOrdenInput {
  numero: string;
}
