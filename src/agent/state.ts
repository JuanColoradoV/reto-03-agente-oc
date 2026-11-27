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
  view: PendingView;
  /** tool_use ids del turno, en orden, y los resultados ya calculados de las demas tools del mismo turno. */
  order: string[];
  partial: Record<string, Anthropic.ToolResultBlockParam>;
  createdAt: string;
}

export interface AuditEntry {
  ts: string;
  type: "mensaje" | "pending_creado" | "decision" | "tool_ejecutada" | "turno_error";
  [k: string]: unknown;
}

export interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
  /** Si no fue un error tecnico sino un resultado de negocio: bloqueada por controles o rechazada por el aprobador. */
  bloqueo?: "controles" | "rechazo";
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

export interface SessionState {
  messages: Message[];
  pending: PendingAction | null;
  sap: { seq: number; ordenes: OrdenCompra[] };
  audit: AuditEntry[];
  events: UiEvent[];
  trace: TurnTrace[];
  turns: number;
}

export const emptyState = (): SessionState => ({
  messages: [],
  pending: null,
  sap: { seq: 0, ordenes: [] },
  audit: [],
  events: [],
  trace: [],
  turns: 0,
});

export const CAPS = { MESSAGES: 120, TURNS: 60, EVENTS: 400, TRACE: 50, AUDIT: 200, MENSAJE_CHARS: 4000 };
