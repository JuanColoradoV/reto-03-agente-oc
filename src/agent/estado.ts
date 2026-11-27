// Estado de UNA sesión de chat (vive en un Durable Object) y eventos que renderiza el front.
import type { Mensaje } from "../llm/adapter";
import type { Derivados, Hallazgo, OrdenCompra } from "../domain/tipos";

/** Lo que ve el usuario al pedirle confirmación: datos deterministas de las herramientas (no la prosa del modelo). */
export interface VistaPendiente {
  caso: string;
  solicitud_id: string;
  confirmaciones: Hallazgo[];
  derivados: Derivados;
  retroactiva: boolean;
  payload: OrdenCompra | null;
}

export type UiEvent = (
  | { type: "user_text"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown; ms: number }
  | { type: "pending_confirmation"; pending: VistaPendiente }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "usage"; usage: TurnUsage }
) & { ts?: number };

export interface TurnUsage {
  traceId: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  simulado?: boolean;
}

export interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
}

export interface TurnTrace {
  traceId: string;
  ts: string;
  model: string;
  status: string;
  iterations: number;
  tools: ToolTrace[];
  usage: TurnUsage;
}

export interface CostoAcumulado {
  turnos: number;
  llamadasModelo: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costoUsd: number;
  simulado?: boolean;
}
export const emptyCosto = (): CostoAcumulado => ({ turnos: 0, llamadasModelo: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costoUsd: 0 });

export interface SessionState {
  /** Historial neutral (sin el mensaje de sistema). */
  messages: Mensaje[];
  /** Confirmación humana esperada (la fija el servidor a partir de lo que devuelven las herramientas). */
  pendiente: VistaPendiente | null;
  events: UiEvent[];
  trace: TurnTrace[];
  turns: number;
  costo: CostoAcumulado;
}

export const emptyState = (): SessionState => ({ messages: [], pendiente: null, events: [], trace: [], turns: 0, costo: emptyCosto() });

export const CAPS = {
  MESSAGES: 160,
  TURNS: 80,
  EVENTS: 400,
  TRACE: 50,
  MENSAJE_CHARS: 4000,
  /** Tope en bytes (JSON) de cada valor guardado en el storage del DO. */
  VALUE_BYTES: 2 * 1024 * 1024,
};
