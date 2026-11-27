// Ciclo del agente (PRD 6.3): prompt -> modelo -> herramientas -> modelo ... con topes. Depende SOLO de la interfaz LlmAdapter.
// - CA1: tope de iteraciones herramienta->modelo por turno (config.iterMax); al alcanzarlo, una última respuesta sin herramientas.
// - CA3: la confirmación humana la fija el servidor (state.pendiente); el turno termina con la pregunta del modelo.
// - CA4: cada llamada a herramienta se emite al chat y se registra en out/log.jsonl (registry).
// - CA5: errores del proveedor -> aviso claro en el chat; la sesión sigue viva.
import { ErrorLlm, usoVacio, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type Uso } from "../llm/adapter";
import { ejecutarHerramienta, esquemaJson, herramientas } from "../tools/registry";
import type { ToolCtx } from "../tools/contexto";
import type { ConfigCiclo } from "./config";
import { aplicarEfectos } from "./efectos";
import type { SessionState, ToolTrace, UiEvent } from "./estado";

export interface LoopDeps {
  llm: LlmAdapter;
  systemPrompt: string;
  ctx: ToolCtx;
  config: ConfigCiclo;
  persist(): Promise<void>;
}

export interface TurnAcc {
  traceId: string;
  iterations: number;
  usage: Uso & { calls: number };
  tools: ToolTrace[];
}

export const newTurn = (traceId: string): TurnAcc => ({ traceId, iterations: 0, usage: { ...usoVacio(), calls: 0 }, tools: [] });

export type Emit = (e: UiEvent) => Promise<void>;
export type TurnStatus = "done" | "error";

export const definiciones = (): DefinicionHerramienta[] => herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.description, esquema: esquemaJson(h) }));

const tokensUsados = (state: SessionState, turn: TurnAcc): number => state.costo.input + state.costo.output + turn.usage.entrada + turn.usage.salida;

const NOTA_TOPE = "Sistema: se alcanzó el tope de iteraciones de este turno. Responde ahora, sin herramientas, con lo que ya tienes y lo que falta por hacer.";

function mensajeError(e: ErrorLlm, timeoutMs: number): string {
  if (e.codigo === "timeout") return `El modelo tardó más de ${Math.round(timeoutMs / 1000)} segundos en responder. Intenta de nuevo; tu conversación sigue guardada.`;
  if (e.codigo === "contexto") return "La conversación excedió la ventana de contexto del modelo. Inicia una nueva conversación.";
  return `${e.message} Tu conversación sigue guardada: puedes reintentar.`;
}

function parsear(s: string): { ok?: boolean; data?: Record<string, unknown>; error?: string } {
  try {
    return JSON.parse(s) as { ok?: boolean; data?: Record<string, unknown>; error?: string };
  } catch {
    return { ok: false, error: s };
  }
}

export async function runAgentLoop(deps: LoopDeps, state: SessionState, turn: TurnAcc, emit: Emit): Promise<TurnStatus> {
  const { llm, config } = deps;
  const defs = definiciones();
  const notice = (level: "info" | "warn" | "error", text: string) => emit({ type: "notice", level, text });
  const sistema: Mensaje = { rol: "sistema", texto: deps.systemPrompt };

  for (let iter = 1; iter <= config.iterMax; iter++) {
    if (tokensUsados(state, turn) >= config.tokensSesionMax) {
      await notice("warn", "Esta conversación alcanzó su límite de uso (tokens por sesión). Inicia una nueva conversación para continuar.");
      return "done";
    }
    const ultima = iter === config.iterMax;
    turn.iterations++;
    let res;
    try {
      const historial = ultima ? [...state.messages, { rol: "usuario" as const, texto: NOTA_TOPE }] : state.messages;
      res = await llm.enviar([sistema, ...historial], defs, { maxTokens: config.maxTokensRespuesta, sinHerramientas: ultima, signal: AbortSignal.timeout(config.llmTimeoutMs) });
    } catch (e) {
      if (e instanceof ErrorLlm) {
        await notice("error", mensajeError(e, config.llmTimeoutMs));
        return "error";
      }
      throw e;
    }
    turn.usage.calls++;
    turn.usage.entrada += res.uso.entrada;
    turn.usage.salida += res.uso.salida;
    turn.usage.cacheLeida += res.uso.cacheLeida;
    turn.usage.cacheEscrita += res.uso.cacheEscrita;

    if (res.texto) await emit({ type: "assistant_text", text: res.texto });
    const llamadas = ultima ? [] : res.llamadas;
    if (res.texto || llamadas.length) state.messages.push({ rol: "asistente", texto: res.texto, llamadas, ...(res.opaco !== undefined && !ultima ? { opaco: res.opaco } : {}) });

    if (res.fin === "rechazo") await notice("error", "El modelo declinó responder a esta solicitud.");
    else if (res.fin === "limite_tokens" && llamadas.length === 0) await notice("warn", "La respuesta se cortó por límite de tokens. Intenta con una petición más acotada.");
    if (llamadas.length === 0) {
      await deps.persist();
      if (ultima && res.llamadas.length) await notice("warn", "Se alcanzó el máximo de iteraciones del agente; el resumen refleja lo que se alcanzó a hacer.");
      return "done";
    }

    const resultados = [];
    for (const l of llamadas) {
      await emit({ type: "tool_call", id: l.id, name: l.nombre, input: l.args });
      const t0 = Date.now();
      const salida = await ejecutarHerramienta(l.nombre, l.args, deps.ctx);
      const ms = Date.now() - t0;
      const p = parsear(salida);
      turn.tools.push({ name: l.nombre, ms, ok: p.ok === true });
      await emit({ type: "tool_result", id: l.id, name: l.nombre, ok: p.ok === true, output: p.ok ? p.data : p, ms });
      for (const ev of aplicarEfectos(state, l.nombre, l.args, p as never)) await emit(ev);
      resultados.push({ id: l.id, nombre: l.nombre, contenido: salida, error: p.ok !== true });
    }
    state.messages.push({ rol: "herramienta", resultados });
    await deps.persist();
  }
  return "done";
}
