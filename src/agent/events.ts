/** Eventos que el frontend renderiza (se emiten por SSE y se guardan en la sesion para restaurar el chat). */
export type UiEvent = (
  | { type: "user_text"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown; ms: number }
  | { type: "pending_confirmation"; pending: PendingView }
  | { type: "decision"; pendingId: string; decision: "aprobar" | "rechazar"; comentario?: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "usage"; usage: TurnUsage }
) & {
  /** Marca de tiempo (ms epoch) puesta por el servidor al emitir; permite mostrar la hora al restaurar la sesión. */
  ts?: number;
};

/** Lo que ve la persona que aprueba: datos deterministas del preflight (no la prosa del modelo). */
export interface PendingView {
  pendingId: string;
  toolUseId: string;
  name: string;
  resumen: string;
  /** Para crear_orden_compra: VistaOrden (src/domain/ordenes.ts). */
  vista: unknown;
}

export interface TurnUsage {
  traceId: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
