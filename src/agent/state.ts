// Estado de UNA sesion de chat. Vive en un Durable Object (idFromName(sessionId)); el cliente nunca
// envia historial ni estado: solo {sessionId, mensaje} / {sessionId, pendingId, decision}.
import type Anthropic from "@anthropic-ai/sdk";
import type { OrdenCompra } from "../domain/types";
import type { PendingView, TurnUsage, UiEvent } from "./events";

export type Message = Anthropic.MessageParam;

export interface PendingAction {
  pendingId: string;
  toolUseId: string;
  name: string;
  /** Entrada ya validada con zod. */
  input: unknown;
  /** `data` del preflight determinista (lo que se ejecutara si se aprueba). */
  preflight: unknown;
  /** Huella de lo que vio la persona (OC + controles + documentos). Al confirmar se re-ejecuta el preflight y debe coincidir. */
  huella?: string;
  view: PendingView;
  /** tool_use ids del turno, en orden, y los resultados ya calculados de las demas tools del mismo turno. */
  order: string[];
  partial: Record<string, Anthropic.ToolResultBlockParam>;
  createdAt: string;
}

export interface AuditEntry {
  ts: string;
  type: "mensaje" | "pending_creado" | "decision" | "tool_ejecutada" | "turno_error" | "aprobacion_invalidada";
  [k: string]: unknown;
}

export interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
  /** Si no fue un error tecnico sino un resultado de negocio: bloqueada por controles, ya procesada (la solicitud ya tiene OC) o rechazada por el aprobador. */
  bloqueo?: "controles" | "rechazo" | "ya_procesada";
}

export interface TurnTrace {
  traceId: string;
  ts: string;
  model: string;
  status: string;
  /** Intentos de llamada al modelo del turno, los fallidos incluidos (el cliente no reintenta por su cuenta: maxRetries 0, así que cada intento es una petición HTTP). */
  iterations: number;
  tools: ToolTrace[];
  usage: TurnUsage;
}

/** Totales de toda la sesion, independientes de la traza (que se recorta a CAPS.TRACE turnos). */
export interface CostoAcumulado {
  turnos: number;
  llamadasModelo: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costoUsd: number;
  /** true si algún turno de la sesión fue simulado (MOCK_LLM): sus tokens son inventados y no suman costo. */
  simulado?: boolean;
}
export const emptyCosto = (): CostoAcumulado => ({ turnos: 0, llamadasModelo: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costoUsd: 0 });

export interface SessionState {
  messages: Message[];
  pending: PendingAction | null;
  sap: { seq: number; ordenes: OrdenCompra[] };
  audit: AuditEntry[];
  events: UiEvent[];
  trace: TurnTrace[];
  turns: number;
  /** Acumuladores de costo de TODA la sesion (la traza solo conserva los ultimos CAPS.TRACE turnos). */
  costo: CostoAcumulado;
}

export const emptyState = (): SessionState => ({
  messages: [],
  pending: null,
  sap: { seq: 0, ordenes: [] },
  audit: [],
  events: [],
  trace: [],
  turns: 0,
  costo: emptyCosto(),
});

export const CAPS = {
  MESSAGES: 120,
  TURNS: 60,
  EVENTS: 400,
  TRACE: 50,
  AUDIT: 200,
  MENSAJE_CHARS: 4000,
  /**
   * Tope en bytes (JSON) de cada valor que se guarda en el storage del DO. La API KV de un DO con SQLite admite hasta ~8 MB por
   * clave+valor (la de 128 KiB es del backend KV antiguo, que no usamos: `new_sqlite_classes`); 2 MiB deja un margen amplio y
   * hace que un exceso se maneje aqui (recortando eventos viejos o cerrando la sesion) en vez de fallar al guardar.
   */
  VALUE_BYTES: 2 * 1024 * 1024,
};
