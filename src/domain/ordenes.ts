// Construccion de la OC: funcion PURA. El servidor arma la orden desde el caso y los maestros;
// el modelo solo elige que solicitud procesar. [TODO: ajustar al mapeo real del PRD (IVA, condiciones de pago...)]
import { fromMinor, lineaMinor, totalMinor } from "./dinero";
import { evaluarControles, type ControlCtx } from "./controles";
import type { CasoSolicitud, CrearOrdenInput, Maestros, ResultadoControl } from "./types";

export interface OrdenPreparada {
  /** null si hay algun control bloqueante en FALLA. */
  orden: CrearOrdenInput | null;
  controles: ResultadoControl[];
  bloqueante: boolean;
}

export function prepararOrden(caso: CasoSolicitud, maestros: Maestros, fecha: string, ctx?: ControlCtx): OrdenPreparada {
  const controles = evaluarControles(caso, maestros, ctx);
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
  lineas: { descripcion: string; cantidad: number; precioUnitario: number; subtotal: number }[];
  total: number;
  controles: ResultadoControl[];
  alertas: ResultadoControl[];
}

export function vistaOrden(orden: CrearOrdenInput, controles: ResultadoControl[], maestros: Maestros): VistaOrden {
  const prov = maestros.proveedores.find((p) => p.id === orden.proveedorId);
  return {
    solicitudId: orden.solicitudId,
    proveedor: { id: orden.proveedorId, nombre: prov?.nombre ?? orden.proveedorId },
    centroCosto: orden.centroCosto,
    moneda: orden.moneda,
    lineas: orden.items.map((i) => ({ ...i, subtotal: fromMinor(lineaMinor(i)) })),
    total: orden.total,
    controles,
    alertas: controles.filter((c) => c.resultado === "ALERTA"),
  };
}
