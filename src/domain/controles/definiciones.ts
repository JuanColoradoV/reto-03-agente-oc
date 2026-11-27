// Definiciones de controles. Cada control es DATOS + una funcion pura; el registro (index.ts) las
// expone para derivar de aqui la matriz de SOLUCION.md y la salida de demo.ts.
// [TODO: reemplazar/ampliar con la matriz de controles del PRD; las reglas actuales son PLACEHOLDER]
import { fmt, toMinor, totalMinor, fromMinor } from "../dinero";
import { parseCotizacion } from "../parsers/cotizacion";
import type { CasoSolicitud, Maestros, Severidad } from "../types";

/** Contexto transaccional (SAP de la sesion) para controles que no salen solo de los documentos. */
export interface ControlCtx {
  /** OC de la solicitud evaluada segun SAP (consulta puntual por referencia; vacio = no hay). undefined = no se pudo consultar. */
  ordenes?: ReadonlyArray<{ solicitudId: string; numero: string }>;
  /** Fecha de negocio (YYYY-MM-DD) para controles de vigencia del PRD (cotizacion/aprobacion vencida). Ninguno de los provisionales la usa. */
  fecha?: string;
}

export interface EvaluacionControl {
  estado: "CUMPLE" | "INCUMPLE" | "NO_EVALUABLE";
  detalle: string;
}

export interface ControlDef {
  id: string;
  nombre: string;
  /** Regla en lenguaje natural (va a la matriz de SOLUCION.md). */
  regla: string;
  /** Qué verifica, en lenguaje llano (se muestra a quien aprueba en la UI). */
  descripcion: string;
  /** Qué hacer si no se cumple, en lenguaje llano (se muestra en el aviso de bloqueo). */
  accion: string;
  /** bloqueante: incumplir => FALLA (no se crea OC). alerta: incumplir => ALERTA (decide el humano). */
  severidad: Severidad;
  /** De donde salen los datos que evalua. */
  fuente: string;
  /** true: depende del estado de SAP (no de los documentos), por eso no figura en esperados.json del PRD. */
  contextual?: boolean;
  evaluar(caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): EvaluacionControl;
}

const ok = (detalle: string): EvaluacionControl => ({ estado: "CUMPLE", detalle });
const no = (detalle: string): EvaluacionControl => ({ estado: "INCUMPLE", detalle });
const nd = (detalle: string): EvaluacionControl => ({ estado: "NO_EVALUABLE", detalle });

export const C0_OC_EXISTENTE: ControlDef = {
  id: "C0",
  nombre: "OC existente",
  descripcion: "Que la solicitud no tenga ya una orden creada.",
  accion: "Revisa si la solicitud ya tiene su orden; no hace falta procesarla de nuevo.",
  regla: "La solicitud no tiene ya una OC en SAP (idempotencia: una solicitud genera a lo sumo una OC).",
  severidad: "bloqueante",
  fuente: "SAP (OC de la sesión)",
  contextual: true,
  evaluar(caso, _maestros, ctx) {
    if (!ctx?.ordenes) return nd("No se pudo consultar SAP para verificar OC previas.");
    const existente = ctx.ordenes.find((o) => o.solicitudId === caso.id);
    return existente ? no(`La solicitud ${caso.id} ya tiene la OC ${existente.numero}.`) : ok("Sin OC previa para esta solicitud.");
  },
};

export const C1_PROVEEDOR: ControlDef = {
  id: "C1",
  nombre: "Proveedor en maestro",
  descripcion: "Que el proveedor exista en el maestro y esté activo.",
  accion: "Cambia el proveedor de la solicitud por uno activo y vuelve a procesarla.",
  regla: "El proveedor existe en el maestro, está activo y no está bloqueado.",
  severidad: "bloqueante",
  fuente: "maestros/proveedores.json + solicitud.json",
  evaluar(caso, maestros) {
    const prov = maestros.proveedores.find((p) => p.id === caso.solicitud.proveedorId);
    if (!prov) return no(`El proveedor ${caso.solicitud.proveedorId} no existe en el maestro.`);
    if (prov.bloqueado || prov.activo === false) return no(`${prov.nombre} está inactivo o bloqueado.`);
    return ok(`${prov.nombre} activo.`);
  },
};

export const C2_COTIZACION: ControlDef = {
  id: "C2",
  nombre: "Cotización vs solicitud",
  descripcion: "Que el total de la cotización coincida con lo solicitado.",
  accion: "Corrige la cotización o la solicitud para que los totales coincidan y vuelve a procesarla.",
  regla: "El total de la cotización coincide con el total de la solicitud (comparación en centavos enteros).",
  severidad: "bloqueante",
  fuente: "cotizacion.txt + solicitud.json",
  evaluar(caso) {
    const { campos } = parseCotizacion(caso.cotizacion);
    const total = totalMinor(caso.solicitud.items);
    if (campos.total === undefined) return nd("No se pudo leer el total de la cotización (requiere revisión humana).");
    const totalCot = toMinor(campos.total);
    return totalCot === total
      ? ok(`Total coincide: ${fmt(fromMinor(total), caso.solicitud.moneda)}.`)
      : no(`Cotización ${fmt(campos.total, caso.solicitud.moneda)} ≠ solicitud ${fmt(fromMinor(total), caso.solicitud.moneda)}.`);
  },
};

export const C3_APROBACION: ControlDef = {
  id: "C3",
  nombre: "Aprobación",
  descripcion: "Que exista una aprobación vigente que cubra el monto.",
  accion: "Consigue una aprobación vigente que cubra el monto y vuelve a procesarla.",
  regla: "Existe una aprobación vigente y su monto aprobado cubre el total.",
  severidad: "bloqueante",
  fuente: "aprobacion.json + solicitud.json",
  evaluar(caso) {
    const ap = caso.aprobacion;
    const total = totalMinor(caso.solicitud.items);
    if (!ap || !ap.aprobada) return no("No hay aprobación vigente.");
    if (ap.montoAprobado !== undefined && toMinor(ap.montoAprobado) < total) {
      return no(`Monto aprobado ${fmt(ap.montoAprobado, caso.solicitud.moneda)} < total ${fmt(fromMinor(total), caso.solicitud.moneda)}.`);
    }
    return ok(`Aprobada por ${ap.aprobador ?? "n/d"}.`);
  },
};

export const C4_RETROACTIVA: ControlDef = {
  id: "C4",
  nombre: "Orden retroactiva",
  descripcion: "Que la compra no se haya hecho antes de la orden (retroactiva).",
  accion: "Confirma con compras que la factura previa es válida antes de continuar.",
  regla: "No debe existir factura previa a la OC; si existe, es una posible orden retroactiva y decide un humano.",
  severidad: "alerta",
  fuente: "factura.txt (opcional)",
  evaluar(caso) {
    return caso.factura && caso.factura.trim().length > 0
      ? no("Existe factura previa a la OC: posible orden retroactiva; requiere revisión humana.")
      : ok("Sin factura previa.");
  },
};
