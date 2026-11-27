// Logica de una sesion de chat (sin dependencias de Workers: se prueba con MemoryKV).
// El Durable Object (do.ts) solo la envuelve. Un turno a la vez por sesion.
//
// NOTA DE ALCANCE (autenticacion): aqui NO se identifica a la persona aprobadora. Cualquiera que
// conozca el sessionId (UUID aleatorio, actua como secreto) puede aprobar. En produccion la identidad
// del aprobador vendria de SSO/OIDC (p. ej. Cloudflare Access) y se registraria en el audit log.
import { estimateCostUsd } from "../agent/cost";
import type { TurnUsage, UiEvent, PendingView } from "../agent/events";
import { appendUserText, newTurn, resolvePending, runAgentLoop, sanitizeHistory, type Emit, type LlmClient, type LoopDeps, type TurnStatus } from "../agent/loop";
import { CAPS, type SessionState, type TurnTrace } from "../agent/state";
import { MODEL_AGENT, MissingApiKeyError } from "../llm/client";
import { InMemorySap } from "../sap";
import type { ToolDef } from "../tools/registry";
import type { SessionStore } from "./storage";

export class SessionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 409 | 503,
  ) {
    super(message);
  }
}

/** Parametros INMUTABLES de un turno (se fijan al aceptar la peticion; nunca viven en el estado de la instancia). */
export interface TurnOpts {
  /** Modo simulado (solo dev): lo decide el Worker por peticion. */
  mock?: boolean;
}

export interface SessionEnv {
  /** Lanza MissingApiKeyError si no hay clave. */
  makeClient(opts: TurnOpts): LlmClient;
  systemPrompt: string;
  tools: ToolDef[];
  /** Tools segun los parametros del turno (por defecto `tools`). */
  toolsFor?(opts: TurnOpts): ToolDef[];
  fecha(): string;
  now(): string;
  log(entry: Record<string, unknown>): void;
  model?: string;
  /** Reloj en ms (inyectable en pruebas). */
  nowMs?(): number;
  /** Duracion del lease del turno (ms). Por defecto 75 s. */
  leaseMs?: number;
  /** Tope por llamada al modelo (ms). Por defecto LIMITS.MODEL_TIMEOUT_MS. */
  modelTimeoutMs?: number;
}

export const LEASE_MS = 75_000;

export interface TurnResult {
  status: TurnStatus | "error";
  traceId: string;
  usage: TurnUsage;
}

export interface PreparedTurn {
  run(onEvent: (e: UiEvent) => Promise<void> | void): Promise<TurnResult>;
  /** Libera el turno si nunca se llega a ejecutar `run` (idempotente; `run` libera por su cuenta). */
  cancel(): void;
}

export interface SessionSnapshot {
  events: UiEvent[];
  pending: PendingView | null;
  turns: number;
  busy: boolean;
  /** OC ya creadas en esta sesion (para que la UI no ofrezca procesar de nuevo una solicitud con OC). */
  ordenes: { solicitudId: string; numero: string }[];
}

type TurnBody = (deps: LoopDeps, turn: ReturnType<typeof newTurn>, emit: Emit) => Promise<TurnStatus>;

/** Recorta salidas enormes de tools antes de guardarlas en el historial de eventos. */
function compactEvent(e: UiEvent): UiEvent {
  if (e.type !== "tool_result") return e;
  const s = typeof e.output === "string" ? e.output : JSON.stringify(e.output);
  return s.length > 6000 ? { ...e, output: s.slice(0, 6000) + "… [truncado]" } : e;
}

export class Session {
  // Candado del turno: se toma de forma SINCRONA (antes de cualquier await) y se libera siempre al terminar o fallar.
  // La fuente de verdad entre isolates/reinicios es ademas el lease persistido.
  private locked = false;

  constructor(
    private sessionId: string,
    private store: SessionStore,
    private env: SessionEnv,
  ) {}

  private nowMs(): number {
    return this.env.nowMs?.() ?? Date.now();
  }

  private busyError(): SessionError {
    return new SessionError("sesion_ocupada", "Hay una operación en curso en esta conversación. Espera a que termine.", 409);
  }

  /** Toma el candado sin await entre la comprobacion y la asignacion: dos peticiones concurrentes no pueden pasar ambas. */
  private lock(): void {
    if (this.locked) throw this.busyError();
    this.locked = true;
  }

  private unlock(): void {
    this.locked = false;
  }

  /** Lease con expiracion: un turno interrumpido (reinicio, crash) no puede bloquear la sesion para siempre. */
  private async assertNoForeignLease(): Promise<void> {
    if ((await this.store.getLease()) > this.nowMs()) throw this.busyError();
  }

  private async renewLease(): Promise<void> {
    await this.store.setLease(this.nowMs() + (this.env.leaseMs ?? LEASE_MS));
  }

  private client(opts: TurnOpts): LlmClient {
    try {
      return this.env.makeClient(opts);
    } catch (e) {
      if (e instanceof MissingApiKeyError) throw new SessionError("missing_api_key", e.message, 503);
      throw e;
    }
  }

  /** Ejecuta la preparacion con el candado tomado; si falla, lo libera. Si sale bien, `run`/`cancel` lo liberan. */
  private async prepare(prep: () => Promise<{ state: SessionState; client: LlmClient; opts: TurnOpts; body: TurnBody }>): Promise<PreparedTurn> {
    this.lock();
    let ready: Awaited<ReturnType<typeof prep>>;
    try {
      await this.assertNoForeignLease();
      ready = await prep();
      await this.renewLease();
    } catch (e) {
      this.unlock();
      throw e;
    }
    let used = false;
    return {
      run: (onEvent) => {
        if (used) return Promise.reject(new Error("El turno ya se ejecutó o se canceló."));
        used = true;
        return this.runTurn(ready.state, ready.client, ready.opts, onEvent, ready.body);
      },
      cancel: () => {
        if (used) return;
        used = true;
        this.unlock();
        void this.store.clearLease().catch(() => {});
      },
    };
  }

  startChat(mensaje: string, opts: TurnOpts = {}): Promise<PreparedTurn> {
    return this.prepare(async () => {
      const text = mensaje.trim();
      if (!text) throw new SessionError("peticion_invalida", "El mensaje está vacío.", 400);
      if (text.length > CAPS.MENSAJE_CHARS) throw new SessionError("peticion_invalida", `El mensaje supera ${CAPS.MENSAJE_CHARS} caracteres.`, 400);
      const state = await this.store.load();
      if (state.pending) throw new SessionError("confirmacion_pendiente", "Hay una acción pendiente de confirmación: apruébala o recházala antes de continuar.", 409);
      if (state.messages.length >= CAPS.MESSAGES || state.turns >= CAPS.TURNS) {
        throw new SessionError("sesion_larga", "La conversación es demasiado larga. Inicia una nueva conversación.", 409);
      }
      const client = this.client(opts);
      return {
        state,
        client,
        opts,
        body: async (deps, turn, emit) => {
          state.turns++;
          sanitizeHistory(state); // cierra tool_use huerfanos y fusiona `user` consecutivos ANTES del nuevo mensaje
          appendUserText(state, text);
          state.audit.push({ ts: this.env.now(), type: "mensaje", chars: text.length, traceId: turn.traceId });
          await emit({ type: "user_text", text });
          await deps.persist();
          return runAgentLoop(deps, state, turn, emit);
        },
      };
    });
  }

  startConfirm(pendingId: string, decision: "aprobar" | "rechazar", comentario?: string, opts: TurnOpts = {}): Promise<PreparedTurn> {
    return this.prepare(async () => {
      // Rechazar exige un motivo: queda en el registro de auditoria y se muestra en la conversacion.
      if (decision === "rechazar" && !comentario?.trim()) throw new SessionError("motivo_requerido", "Para rechazar escribe el motivo.", 400);
      const state = await this.store.load();
      // Valida contra la accion pendiente GUARDADA en el servidor. Se consume una sola vez (resolvePending).
      if (!state.pending || state.pending.pendingId !== pendingId) {
        throw new SessionError("confirmacion_invalida", "La confirmación no es válida o ya fue procesada.", 409);
      }
      const client = this.client(opts);
      const c = comentario?.trim() || undefined;
      return {
        state,
        client,
        opts,
        body: (deps, turn, emit) => resolvePending(deps, state, turn, emit, { aprobar: decision === "aprobar", ...(c ? { comentario: c } : {}) }),
      };
    });
  }

  /** Conveniencia (pruebas): inicia y corre. */
  async chat(mensaje: string, onEvent: (e: UiEvent) => Promise<void> | void = () => {}, opts: TurnOpts = {}): Promise<TurnResult> {
    return (await this.startChat(mensaje, opts)).run(onEvent);
  }
  async confirm(pendingId: string, decision: "aprobar" | "rechazar", comentario?: string, onEvent: (e: UiEvent) => Promise<void> | void = () => {}, opts: TurnOpts = {}): Promise<TurnResult> {
    return (await this.startConfirm(pendingId, decision, comentario, opts)).run(onEvent);
  }

  private async runTurn(
    state: SessionState,
    client: LlmClient,
    opts: TurnOpts,
    onEvent: (e: UiEvent) => Promise<void> | void,
    body: TurnBody,
  ): Promise<TurnResult> {
    const traceId = crypto.randomUUID();
    const turn = newTurn(traceId);
    const model = this.env.model ?? MODEL_AGENT;
    const record = (e: UiEvent) => {
      state.events.push(compactEvent(e));
      if (state.events.length > CAPS.EVENTS) state.events.splice(0, state.events.length - CAPS.EVENTS);
    };
    const emit: Emit = async (ev) => {
      const e: UiEvent = ev.ts === undefined ? { ...ev, ts: this.nowMs() } : ev;
      record(e);
      try {
        await onEvent(e); // un cliente desconectado no debe abortar el turno (el estado igual se guarda)
      } catch {
        /* ignorado */
      }
    };
    const deps: LoopDeps = {
      client,
      systemPrompt: this.env.systemPrompt,
      tools: this.env.toolsFor?.(opts) ?? this.env.tools,
      ctx: { sap: new InMemorySap(state.sap), fecha: this.env.fecha() },
      persist: async () => {
        await this.store.save(state);
        await this.renewLease().catch(() => {});
      },
      now: () => this.env.now(),
      model,
      ...(this.env.modelTimeoutMs ? { modelTimeoutMs: this.env.modelTimeoutMs } : {}),
    };

    let status: TurnResult["status"] = "done";
    try {
      status = await body(deps, turn, emit);
    } catch (e) {
      status = "error";
      // Detalle solo en el log del servidor; al cliente, mensaje generico con id de correlacion.
      console.error(JSON.stringify({ level: "error", traceId, sessionId: this.sessionId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
      state.audit.push({ ts: this.env.now(), type: "turno_error", traceId });
      await emit({ type: "notice", level: "error", text: `No se pudo completar la solicitud. Intenta de nuevo. (ref: ${traceId.slice(0, 8)})` });
    }

    const u = turn.usage;
    const usage: TurnUsage = { traceId, calls: u.calls, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: estimateCostUsd(model, u) };
    const trace: TurnTrace = { traceId, ts: this.env.now(), model, status, iterations: turn.iterations, tools: turn.tools, usage };
    state.trace.push(trace);
    if (state.trace.length > CAPS.TRACE) state.trace.splice(0, state.trace.length - CAPS.TRACE);
    if (state.audit.length > CAPS.AUDIT) state.audit.splice(0, state.audit.length - CAPS.AUDIT);
    this.env.log({
      level: "info",
      event: "turn",
      traceId,
      sessionId: this.sessionId,
      model,
      status,
      iterations: turn.iterations,
      tools: turn.tools,
      tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
      costUsd: usage.costUsd,
    });
    record({ type: "usage", usage }); // se guarda con el estado ANTES de avisar al cliente (la traza que lea ya incluye este turno)
    try {
      await this.store.save(state);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", traceId, sessionId: this.sessionId, message: `persist: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      this.unlock();
      await this.store.clearLease().catch(() => {});
    }
    try {
      await onEvent({ type: "usage", usage }); // un cliente desconectado no importa: ya esta guardado
    } catch {
      /* ignorado */
    }
    return { status, traceId, usage };
  }

  async snapshot(): Promise<SessionSnapshot> {
    const s = await this.store.load();
    const busy = this.locked || (await this.store.getLease()) > this.nowMs();
    return { events: s.events, pending: s.pending?.view ?? null, turns: s.turns, busy, ordenes: s.sap.ordenes.map((o) => ({ solicitudId: o.solicitudId, numero: o.numero })) };
  }

  async trace(): Promise<TurnTrace[]> {
    return (await this.store.load()).trace;
  }

  async reset(): Promise<void> {
    this.lock();
    try {
      await this.assertNoForeignLease();
      await this.store.clear();
    } finally {
      this.unlock();
    }
  }
}
