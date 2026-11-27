// Construccion de la OC: funcion PURA. El servidor arma la orden desde el caso y los maestros;
// el modelo solo elige que solicitud procesar. [TODO: ajustar al mapeo real del PRD (IVA, condiciones de pago...)]
import { fromMinor, lineaMinor, totalMinor, validarItems } from "./dinero";
import { fmtCantidad, fmtMonto } from "./formato";
import { evaluarControles, type ControlCtx } from "./controles";
import type { CasoSolicitud, CrearOrdenInput, Maestros, ResultadoControl } from "./types";

export interface OrdenPreparada {
  /** null si hay algun control bloqueante en FALLA. */
  orden: CrearOrdenInput | null;
  controles: ResultadoControl[];
  bloqueante: boolean;
}

/** Invariantes estructurales de la solicitud (campos vacios, sin lineas). Las cantidades/precios los valida `validarItems`. */
export function invariantesOrden(caso: CasoSolicitud): string[] {
  const s = caso.solicitud;
  const errs: string[] = [];
  if (s.items.length === 0) errs.push("La solicitud no tiene líneas.");
  if (!s.proveedorId.trim()) errs.push("La solicitud no indica proveedor.");
  if (!s.centroCosto.trim()) errs.push("La solicitud no indica centro de costo.");
  if (!s.moneda.trim()) errs.push("La solicitud no indica moneda.");
  s.items.forEach((it, i) => {
    if (!it.descripcion.trim()) errs.push(`Línea ${i + 1}: falta la descripción.`);
  });
  return errs;
}

export function prepararOrden(caso: CasoSolicitud, maestros: Maestros, fecha: string, ctx?: ControlCtx): OrdenPreparada {
  const controles = evaluarControles(caso, maestros, ctx);
  // Validacion de DATOS (no es una regla de negocio del PRD): invariantes minimos para poder grabar una OC y cantidades/precios
  // con precision admitida. Se evalua ANTES de abrir la tarjeta: una OC invalida no llega a la persona. Solo aparece si falla.
  const errPrecision = [...invariantesOrden(caso), ...validarItems(caso.solicitud.items)];
  if (errPrecision.length) {
    controles.push({
      id: "V0",
      nombre: "Cantidades y precios",
      descripcion: "Que la solicitud tenga datos mínimos válidos (proveedor, centro de costo, moneda, al menos una línea) y que cantidades (máx. 3 decimales, positivas) y precios (máx. 2 decimales) se graben exactamente como se muestran.",
      accion: "Corrige las cantidades o precios de la solicitud y vuelve a procesarla.",
      severidad: "bloqueante",
      resultado: "FALLA",
      detalle: errPrecision.join(" "),
    });
  }
  const bloqueante = controles.some((c) => c.resultado === "FALLA");
  if (bloqueante) return { orden: null, controles, bloqueante };
  const s = caso.solicitud;
  const orden: CrearOrdenInput = {
    solicitudId: caso.id,
    proveedorId: s.proveedorId,
    centroCosto: s.centroCosto,
    moneda: s.moneda,
    items: s.items.map((i) => ({ ...i })),
    total: fromMinor(totalMinor(s.items)),
    fecha,
  };
  return { orden, controles, bloqueante };
}

/** Lo que ve la persona que aprueba: datos deterministas, no la prosa del modelo. */
export interface VistaOrden {
  solicitudId: string;
  proveedor: { id: string; nombre: string };
  centroCosto: string;
  moneda: string;
  /** Los `*Txt` son el texto exacto a mostrar (formato es-CO sin perdida de precision). */
  lineas: { descripcion: string; cantidad: number; precioUnitario: number; subtotal: number; cantidadTxt: string; precioTxt: string; subtotalTxt: string }[];
  total: number;
  controles: ResultadoControl[];
  alertas: ResultadoControl[];
  /** Documentos de la solicitud en forma legible ("Ver documentos"). Topados en tamano; la huella usa los completos. */
  documentos?: VistaDocumentos;
}

export interface VistaDocumentos {
  correo: { de?: string; asunto?: string; cuerpo?: string };
  cotizacion: string;
  aprobacion: Record<string, string | number | boolean> | null;
  factura: string | null;
}

const MAX_DOC_CHARS = 4000;
const tope = (t: string) => (t.length > MAX_DOC_CHARS ? t.slice(0, MAX_DOC_CHARS) + "… [recortado]" : t);

function vistaDocumentos(c: CasoSolicitud): VistaDocumentos {
  const ap: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(c.aprobacion ?? {})) {
    if (k.startsWith("_")) continue; // marcas internas (p. ej. _placeholder)
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") ap[k] = typeof v === "string" ? tope(v) : v;
  }
  const { de, asunto, cuerpo } = c.correo;
  return {
    correo: { ...(de !== undefined ? { de } : {}), ...(asunto !== undefined ? { asunto } : {}), ...(cuerpo !== undefined ? { cuerpo: tope(cuerpo) } : {}) },
    cotizacion: tope(c.cotizacion),
    aprobacion: c.aprobacion ? ap : null,
    factura: c.factura === null ? null : tope(c.factura),
  };
}

export function vistaOrden(orden: CrearOrdenInput, controles: ResultadoControl[], maestros: Maestros, caso?: CasoSolicitud): VistaOrden {
  const prov = maestros.proveedores.find((p) => p.id === orden.proveedorId);
  return {
    solicitudId: orden.solicitudId,
    proveedor: { id: orden.proveedorId, nombre: prov?.nombre ?? orden.proveedorId },
    centroCosto: orden.centroCosto,
    moneda: orden.moneda,
    lineas: orden.items.map((i) => {
      const subtotal = fromMinor(lineaMinor(i)); // subtotal por linea redondeado a centavos; el total es la suma de estos
      return { ...i, subtotal, cantidadTxt: fmtCantidad(i.cantidad), precioTxt: fmtMonto(i.precioUnitario), subtotalTxt: fmtMonto(subtotal) };
    }),
    total: orden.total,
    controles,
    alertas: controles.filter((c) => c.resultado === "ALERTA"),
    ...(caso ? { documentos: vistaDocumentos(caso) } : {}),
  };
}
