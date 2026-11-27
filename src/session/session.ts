// Logica de una sesion de chat (sin dependencias de Workers: se prueba con MemoryKV).
// El Durable Object (do.ts) solo la envuelve. Un turno a la vez por sesion.
//
// NOTA DE ALCANCE (autenticacion): no hay usuarios. Quien conozca el sessionId (UUID aleatorio, actua como secreto) puede
// confirmar; la confirmacion queda en excepciones[].confirmado_por del payload como "usuario (chat)". En produccion la
// identidad vendria de SSO/OIDC (p. ej. Cloudflare Access).
import { estimateCostUsd } from "../agent/cost";
import { esConfirmacion } from "../agent/efectos";
import type { ConfigCiclo } from "../agent/config";
import { CAPS, type SessionState, type TurnTrace, type TurnUsage, type UiEvent, type VistaPendiente } from "../agent/estado";
import { newTurn, runAgentLoop, type Emit, type LoopDeps, type TurnStatus } from "../agent/loop";
import { FaltaClaveError } from "../llm/anthropic";
import type { LlmAdapter } from "../llm/adapter";
import { fixturesEmpaquetados } from "../domain/fixtures";
import type { ArchivoOut } from "../out/store";
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
  /** Lanza FaltaClaveError si no hay clave. */
  makeLlm(opts: TurnOpts): LlmAdapter;
  systemPrompt: string;
  config: ConfigCiclo;
  now(): string;
  log(entry: Record<string, unknown>): void;
  /** Reloj en ms (inyectable en pruebas). */
  nowMs?(): number;
  /** Duracion del lease del turno (ms). Por defecto 75 s. */
  leaseMs?: number;
  /** Se llama al terminar cada turno con su costo estimado (USD): alimenta el presupuesto global diario. Nunca debe lanzar. */
  onSpend?(usd: number): Promise<void> | void;
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
  pending: VistaPendiente | null;
  turns: number;
  busy: boolean;
}

type TurnBody = (deps: LoopDeps, turn: ReturnType<typeof newTurn>, emit: Emit) => Promise<TurnStatus>;

const MAX_EVENT_OUTPUT = 6000;
const MAX_CAMPO_TEXTO = 1500;

/** Copia con los textos largos recortados y la estructura (claves, arreglos, numeros) intacta. */
function recortarTextos(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_CAMPO_TEXTO ? v.slice(0, MAX_CAMPO_TEXTO) + "… [truncado]" : v;
  if (Array.isArray(v)) return v.map(recortarTextos);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recortarTextos(x)]));
  return v;
}

/**
 * Recorta salidas enormes de tools antes de guardarlas en el historial de eventos. Un `output` ESTRUCTURADO (p. ej. controles de
 * oc_validar) nunca se convierte en texto: se recortan solo sus cadenas largas, para que al recargar la UI y la auditoria
 * sigan leyendo la misma forma (si fuera una cadena, un caso bloqueado se pintaria como "Listo").
 */
export function compactEvent(e: UiEvent): UiEvent {
  // Solo se trunca el detalle tecnico (`output`); el recibo estructurado (`recibo`) viaja intacto.
  if (e.type !== "tool_result") return e;
  const s = typeof e.output === "string" ? e.output : JSON.stringify(e.output);
  if (s.length <= MAX_EVENT_OUTPUT) return e;
  if (typeof e.output === "string") return { ...e, output: s.slice(0, MAX_EVENT_OUTPUT) + "… [truncado]" };
  const compacto = recortarTextos(e.output);
  return JSON.stringify(compacto).length <= MAX_EVENT_OUTPUT * 2 ? { ...e, output: compacto } : { ...e, output: s.slice(0, MAX_EVENT_OUTPUT) + "… [truncado]" };
}

const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** Descarta los eventos mas viejos hasta que el arreglo guardado quepa en `max` bytes (la UI solo los usa para repintar el chat). */
export function acotarEventos(events: UiEvent[], max: number): void {
  let total = bytes(events);
  while (total > max && events.length > 1) {
    const quitados = Math.max(1, Math.floor(events.length / 10));
    events.splice(0, quitados);
    total = bytes(events);
  }
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

  private llm(opts: TurnOpts): LlmAdapter {
    try {
      return this.env.makeLlm(opts);
    } catch (e) {
      if (e instanceof FaltaClaveError) throw new SessionError("missing_api_key", e.message, 503);
      throw e;
    }
  }

  /** Ejecuta la preparacion con el candado tomado; si falla, lo libera. Si sale bien, `run`/`cancel` lo liberan. */
  private async prepare(prep: () => Promise<{ state: SessionState; llm: LlmAdapter; opts: TurnOpts; body: TurnBody }>): Promise<PreparedTurn> {
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
        return this.runTurn(ready.state, ready.llm, ready.opts, onEvent, ready.body);
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
      if (state.messages.length >= CAPS.MESSAGES || state.turns >= CAPS.TURNS) {
        throw new SessionError("sesion_larga", "La conversación es demasiado larga. Inicia una nueva conversación.", 409);
      }
      if (bytes(state.messages) > CAPS.VALUE_BYTES) throw new SessionError("sesion_larga", "La conversación es demasiado larga. Inicia una nueva conversación.", 409);
      const llm = this.llm(opts);
      return {
        state,
        llm,
        opts,
        body: async (deps, turn, emit) => {
          state.turns++;
          state.messages.push({ rol: "usuario", texto: text });
          // Confirmacion humana: SOLO si hay una accion pendiente (fijada por el servidor) y este mensaje la confirma.
          // El boton de la UI envia el mismo texto. Se expone a las herramientas por el contexto, nunca por el modelo.
          if (state.pendiente && esConfirmacion(text)) deps.ctx = { ...deps.ctx, confirmadoPor: "usuario (chat)", confirmadoCaso: state.pendiente.caso };
          await emit({ type: "user_text", text });
          await deps.persist();
          return runAgentLoop(deps, state, turn, emit);
        },
      };
    });
  }

  /** Conveniencia (pruebas): inicia y corre. */
  async chat(mensaje: string, onEvent: (e: UiEvent) => Promise<void> | void = () => {}, opts: TurnOpts = {}): Promise<TurnResult> {
    return (await this.startChat(mensaje, opts)).run(onEvent);
  }

  private async runTurn(
    state: SessionState,
    llm: LlmAdapter,
    opts: TurnOpts,
    onEvent: (e: UiEvent) => Promise<void> | void,
    body: TurnBody,
  ): Promise<TurnResult> {
    const traceId = crypto.randomUUID();
    const turn = newTurn(traceId);
    const model = llm.modelo;
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
      llm,
      systemPrompt: this.env.systemPrompt,
      ctx: { directory: "/", sessionId: this.sessionId, store: this.store.outStore(), fixtures: fixturesEmpaquetados, ahora: () => new Date(this.env.now()) },
      config: this.env.config,
      persist: async () => {
        acotarEventos(state.events, CAPS.VALUE_BYTES);
        await this.store.save(state);
        await this.renewLease().catch(() => {});
      },
    };

    // Heartbeat del lease: una llamada al modelo puede durar mas que el lease (hasta MODEL_TIMEOUT_MS). Mientras ESTE proceso
    // sigue vivo y ejecutando el turno, se renueva; si muere, el lease caduca solo y la sesion se libera.
    const heartbeat = setInterval(() => void this.renewLease().catch(() => {}), Math.max(10, (this.env.leaseMs ?? LEASE_MS) / 3));

    let status: TurnResult["status"] = "done";
    try {
      status = await body(deps, turn, emit);
    } catch (e) {
      status = "error";
      // Detalle solo en el log del servidor; al cliente, mensaje generico con id de correlacion.
      console.error(JSON.stringify({ level: "error", traceId, sessionId: this.sessionId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
      await emit({ type: "notice", level: "error", text: `No se pudo completar la solicitud. Intenta de nuevo. (ref: ${traceId.slice(0, 8)})` });
    }

    clearInterval(heartbeat);
    const u = turn.usage;
    // Modo simulado: los tokens los inventa el guion, asi que NO se estima un costo (se reporta 0 y se marca `simulado`).
    const simulado = opts.mock === true;
    const usage: TurnUsage = { traceId, calls: u.calls, input: u.entrada, output: u.salida, cacheRead: u.cacheLeida, cacheWrite: u.cacheEscrita, costUsd: simulado ? 0 : estimateCostUsd(model, { input: u.entrada, output: u.salida, cacheRead: u.cacheLeida, cacheWrite: u.cacheEscrita }), ...(simulado ? { simulado: true } : {}) };
    const trace: TurnTrace = { traceId, ts: this.env.now(), model, status, iterations: turn.iterations, tools: turn.tools, usage };
    state.trace.push(trace);
    const c = state.costo; // acumuladores de toda la sesion (no se recortan con la traza)
    c.turnos++;
    c.llamadasModelo += u.calls;
    c.input += u.entrada;
    c.output += u.salida;
    c.cacheRead += u.cacheLeida;
    c.cacheWrite += u.cacheEscrita;
    c.costoUsd += usage.costUsd;
    if (simulado) c.simulado = true;
    try {
      if (usage.costUsd > 0) await this.env.onSpend?.(usage.costUsd);
    } catch {
      /* el contador global es de mejor esfuerzo: no rompe el turno */
    }
    if (state.trace.length > CAPS.TRACE) state.trace.splice(0, state.trace.length - CAPS.TRACE);
    this.env.log({
      level: "info",
      event: "turn",
      traceId,
      sessionId: this.sessionId,
      model,
      status,
      iterations: turn.iterations,
      tools: turn.tools,
      tokens: { input: u.entrada, output: u.salida, cacheRead: u.cacheLeida, cacheWrite: u.cacheEscrita },
      costUsd: usage.costUsd,
    });
    record({ type: "usage", usage }); // se guarda con el estado ANTES de avisar al cliente (la traza que lea ya incluye este turno)
    let guardado = true;
    try {
      acotarEventos(state.events, CAPS.VALUE_BYTES);
      await this.store.save(state);
    } catch (e) {
      guardado = false;
      console.error(JSON.stringify({ level: "error", traceId, sessionId: this.sessionId, message: `persist: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      this.unlock();
      await this.store.clearLease().catch(() => {});
    }
    if (!guardado) {
      // El guardado final fallo: lo que el cliente vio en este turno puede no estar persistido. NO se informa exito: aviso explicito,
      // estado `error` y sin evento `usage` (la traza guardada no incluye este turno). Los pasos durables anteriores (p. ej. la
      // decision consumida o la OC creada) se guardaron por separado; recargar muestra el estado real.
      status = "error";
      try {
        await onEvent({ type: "notice", level: "error", text: `No se pudo guardar el resultado de este turno; puede que la conversación no refleje lo último. Recarga la página para ver el estado real. (ref: ${traceId.slice(0, 8)})` });
      } catch {
        /* ignorado */
      }
      return { status, traceId, usage };
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
    return { events: s.events, pending: s.pendiente, turns: s.turns, busy };
  }

  async trace(): Promise<TurnTrace[]> {
    return (await this.store.load()).trace;
  }

  /** Totales de toda la sesion (independientes de la traza recortada). */
  async costo(): Promise<SessionState["costo"]> {
    return (await this.store.load()).costo;
  }

  /** Archivos generados en out/ de esta sesion (para la UI y la API). */
  async archivos(): Promise<ArchivoOut[]> {
    return this.store.outStore().listar();
  }
  async archivo(ruta: string): Promise<Uint8Array | null> {
    try {
      return await this.store.outStore().leerBytes(ruta);
    } catch {
      return null;
    }
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
