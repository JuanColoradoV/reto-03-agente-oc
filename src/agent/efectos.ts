// Efectos de las herramientas sobre el estado de la sesión: de qué caso se espera confirmación humana (CA3).
// El estado lo fija el SERVIDOR a partir de lo que devuelven las herramientas; el modelo no puede crearlo ni borrarlo.
import type { Derivados, Hallazgo, OrdenCompra } from "../domain/tipos";
import type { SessionState, UiEvent, VistaPendiente } from "./estado";

interface DatosResultado {
  caso?: string;
  solicitud_id?: string;
  apta?: boolean;
  confirmaciones?: Hallazgo[];
  derivados?: Derivados;
  retroactiva?: boolean;
  payload?: OrdenCompra;
  numero_oc?: string;
}

type Salida = { ok?: boolean; data?: DatosResultado } & DatosResultado & { pendiente?: boolean };

/** Devuelve los eventos de UI a emitir (tarjeta de confirmación) y actualiza `state.pendiente`. */
export function aplicarEfectos(state: SessionState, nombre: string, args: unknown, salida: Salida): UiEvent[] {
  const caso = (args as { caso?: string } | null)?.caso ?? "";
  const d = salida.data ?? salida;
  const vista = (payload: OrdenCompra | null): VistaPendiente => ({
    caso,
    solicitud_id: d.solicitud_id ?? d.payload?.referencia.solicitud_id ?? state.pendiente?.solicitud_id ?? caso,
    confirmaciones: d.confirmaciones ?? [],
    derivados: d.derivados ?? {},
    retroactiva: d.retroactiva ?? false,
    payload,
  });
  const limpiar = () => {
    if (state.pendiente?.caso === caso) state.pendiente = null;
  };

  if (nombre === "oc_validar" && salida.ok) {
    if (d.apta && (d.confirmaciones?.length ?? 0) > 0) {
      // Sin payload todavía: si oc_construir_payload ya corrió para este caso, se conserva su payload.
      const previo = state.pendiente?.caso === caso ? state.pendiente.payload : null;
      state.pendiente = vista(previo);
      return [{ type: "pending_confirmation", pending: state.pendiente }];
    }
    limpiar();
  } else if (nombre === "oc_construir_payload" && salida.ok && (d.confirmaciones?.length ?? 0) > 0) {
    state.pendiente = vista(d.payload ?? null);
    return [{ type: "pending_confirmation", pending: state.pendiente }];
  } else if (nombre === "oc_crear") {
    if (salida.ok) limpiar();
    else if (salida.pendiente && (salida as { confirmaciones?: Hallazgo[] }).confirmaciones) {
      const previo = state.pendiente?.caso === caso ? state.pendiente.payload : null;
      state.pendiente = vista(previo);
      return [{ type: "pending_confirmation", pending: state.pendiente }];
    } else if (!salida.pendiente) limpiar();
  }
  return [];
}

/**
 * ¿El mensaje confirma la acción pendiente? Solo mensajes cortos que EMPIEZAN por «confirmo» / «sí, confirmo»:
 * «no confirmo» o una frase larga con instrucciones no cuentan.
 */
export function esConfirmacion(texto: string): boolean {
  const t = texto.trim();
  return t.length <= 140 && /^(s[ií]|ok|dale|adelante)?[\s,.!¡:;-]*(lo\s+)?confirmo\b/i.test(t);
}
