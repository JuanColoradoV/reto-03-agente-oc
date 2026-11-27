// Tipos y esquemas zod del dominio (PRD secciones 7.1, 7.2 y 7.4).
import { z } from "zod";

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "fecha con formato AAAA-MM-DD");

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().finite().positive(),
  valor_unitario: z.number().finite().nonnegative(),
  valor_total: z.number().finite().nonnegative(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaIso,
});
export type Solicitud = z.infer<typeof SolicitudSchema>;

export const AprobacionJsonSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
});

export interface Cotizacion {
  proveedor: string;
  nit: string | null;
  total: number;
  moneda: string;
  validez_hasta: string | null;
  texto: string;
  /** Número de la cotización (ej. COT-TS-2026-0451), si el texto lo trae. */
  referencia: string | null;
}

export interface Aprobacion {
  de: string;
  fecha: string;
  aprobado: boolean;
  texto: string;
  para: string;
  asunto: string;
}

export interface Factura {
  numero: string;
  fecha: string;
  total: number;
}

export interface Paquete {
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: Cotizacion | null;
  aprobacion: Aprobacion | null;
  factura: Factura | null;
  /** Nombres de los adjuntos que faltan (los campos correspondientes van en null). */
  faltantes: string[];
}

// ---- Maestros (7.1) ----
export interface Proveedor {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}
export interface CentroCosto {
  centro_costo: string;
  subareas: string[];
  aprobadores: { email: string; tope: number }[];
}
export interface Maestros {
  proveedores: Proveedor[];
  centros_costo: CentroCosto[];
  indicadores_iva: { codigo: string; descripcion: string; tasa: number }[];
  condiciones_pago: { codigo: string; descripcion: string; dias: number }[];
}

// ---- Resultado de las reglas (7.3) ----
export interface Hallazgo {
  codigo: string;
  detalle: string;
  /** Solo en bloqueos: qué hacer. */
  accion_sugerida?: string;
  /** Valores comparados (RC5: solicitud vs cotización; RC8: fechas; ...). */
  valores?: Record<string, string | number>;
}
export interface Derivados {
  indicador_iva?: string;
  condiciones_pago?: string;
}
export interface Validacion {
  apta: boolean;
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: Derivados;
  retroactiva: boolean;
}

// ---- Payload de la OC (7.4) ----
export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
});
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

export interface CampoTraza {
  campo: string;
  valor: unknown;
  fuente: "solicitud" | "cotizacion" | "derivado" | `maestro.${string}`;
  detalle?: string;
}
