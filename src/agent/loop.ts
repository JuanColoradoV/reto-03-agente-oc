// Bucle de tool-use de Anthropic Messages con human-in-the-loop, sobre el estado de UNA sesion.
// - El historial vive en el servidor (SessionState); el cliente nunca lo envia.
// - Una tool con requiresConfirmation: primero preflight determinista (zod + dominio). Si falla o
//   bloquea, el error vuelve al modelo y NO se molesta a la persona. Si pasa, se guarda la accion
//   pendiente (con los datos del preflight) y se espera una decision que solo vale una vez.
// - Nunca se deja un tool_use sin su tool_result en el historial.
import type Anthropic from "@anthropic-ai/sdk";
import { MSG_APROBACION_OBSOLETA, CODIGO } from "../domain/errores";
import { MODEL_AGENT } from "../llm/client";
import { executeTool, preflightTool, toAnthropicTools, type ToolContext, type ToolDef } from "../tools/registry";
import type { PendingView, UiEvent } from "./events";
import type { RawUsage } from "./cost";
import type { Message, PendingAction, SessionState, ToolTrace } from "./state";

export const LIMITS = {
  MAX_ITERATIONS: 8, // llamadas REALES al modelo por turno, reintentos incluidos (la ultima va sin herramientas: resumen final)
  MAX_TOKENS: 8192, // Sonnet 5.5 piensa por defecto: el razonamiento cuenta como salida
  MAX_TOKENS_RETRY: 16000, // reintento unico si se corta con un tool_use a medias
  MAX_TOTAL_OUTPUT_TOKENS: 40000, // tope acumulado por turno (se calcula el saldo antes de CADA llamada, reintento incluido)
  MIN_CALL_TOKENS: 256, // con menos saldo que esto no se llama al modelo (una respuesta asi de corta no sirve)
  MODEL_TIMEOUT_MS: 120_000, // tope por llamada al modelo (AbortSignal)
  TURN_TIMEOUT_MS: 240_000, // tope del turno completo: una racha de llamadas lentas no puede retener la sesion indefinidamente
};

/** Cliente minimo que usa el bucle: el SDK real lo cumple y las pruebas inyectan un falso. */
export interface LlmClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> };
}

export interface LoopDeps {
  client: LlmClient;
  systemPrompt: string;
  tools: ToolDef[];
  ctx: ToolContext;
  /** Guarda el estado completo de la sesion (atomico). El bucle lo llama tras cada paso durable. */
  persist(): Promise<void>;
  now(): string;
  model?: string;
  /** Tope por llamada al modelo (ms). Por defecto LIMITS.MODEL_TIMEOUT_MS. */
  modelTimeoutMs?: number;
  /** Tope del turno completo (ms). Por defecto LIMITS.TURN_TIMEOUT_MS. */
  turnTimeoutMs?: number;
}

export interface TurnAcc {
  traceId: string;
  /** epoch ms de inicio del turno (para el tope TURN_TIMEOUT_MS). */
  startedAt: number;
  iterations: number;
  usage: RawUsage & { calls: number };
  tools: ToolTrace[];
}

export const newTurn = (traceId: string): TurnAcc => ({
  traceId,
  startedAt: Date.now(),
  iterations: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  tools: [],
});

export type Emit = (e: UiEvent) => Promise<void>;
export type TurnStatus = "done" | "pending_confirmation";

const ERR_INTERRUMPIDA = "Herramienta no ejecutada: la solicitud se interrumpió antes de completarse.";

/** Copia de los mensajes con cache_control en el ultimo bloque (prefijo de la conversacion). */
function withMessageCache(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const lb = blocks[blocks.length - 1];
  if (!lb) return messages;
  blocks[blocks.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { role: last.role, content: blocks } as Message];
}

const toolUses = (content: Anthropic.ContentBlock[]) => content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

const toolResultBlock = (id: string, ok: boolean, output: unknown): Anthropic.ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: id,
  content: typeof output === "string" ? output : JSON.stringify(output),
  ...(ok ? {} : { is_error: true }),
});

/** Quita bloques de texto vacios (la API los rechaza); conserva el resto (thinking, tool_use...). */
const cleanContent = (content: Anthropic.ContentBlock[]) => content.filter((b) => b.type !== "text" || b.text.trim() !== "");

const asBlocks = (m: Message): Anthropic.ContentBlockParam[] => (typeof m.content === "string" ? (m.content.trim() ? [{ type: "text", text: m.content }] : []) : [...m.content]);

/** Une dos mensajes `user` consecutivos en uno (los tool_result primero, como exige la API). */
function mergeUser(a: Message, b: Message): Message {
  const blocks = [...asBlocks(a), ...asBlocks(b)];
  const results = blocks.filter((x) => x.type === "tool_result");
  return { role: "user", content: [...results, ...blocks.filter((x) => x.type !== "tool_result")] };
}

/** Agrega texto del usuario al historial SIN dejar dos mensajes `user` seguidos (lo fusiona con el ultimo si es `user`). */
export function appendUserText(state: SessionState, text: string): void {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "user") state.messages[state.messages.length - 1] = mergeUser(last, { role: "user", content: text });
  else state.messages.push({ role: "user", content: text });
}

/**
 * Repara el historial antes de usarlo (si hay una accion pendiente no se toca):
 * 1) si termina en tool_use sin respuesta, lo cierra con tool_result de error;
 * 2) fusiona mensajes `user` consecutivos (p. ej. un turno que fallo tras guardar el mensaje del usuario).
 */
export function sanitizeHistory(state: SessionState): void {
  if (state.pending) return;
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant" && typeof last.content !== "string") {
    const uses = (last.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlockParam[];
    if (uses.length > 0) state.messages.push({ role: "user", content: uses.map((u) => toolResultBlock(u.id, false, ERR_INTERRUMPIDA)) });
  }
  const out: Message[] = [];
  for (const m of state.messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user") out[out.length - 1] = mergeUser(prev, m);
    else out.push(m);
  }
  if (out.length !== state.messages.length) state.messages = out;
}

async function callModel(
  deps: LoopDeps,
  state: SessionState,
  turn: TurnAcc,
  tools: Anthropic.Tool[],
  maxTokens: number,
  toolChoice: Anthropic.ToolChoice,
): Promise<Anthropic.Message> {
  turn.iterations++;
  // Cada llamada se acota por el timeout del modelo Y por lo que queda del turno.
  const restanteTurno = turn.startedAt + (deps.turnTimeoutMs ?? LIMITS.TURN_TIMEOUT_MS) - Date.now();
  if (restanteTurno <= 0) throw new Error("El turno superó su tiempo máximo.");
  const res = await deps.client.messages.create(
    {
      model: deps.model ?? MODEL_AGENT,
      max_tokens: maxTokens,
      system: [{ type: "text", text: deps.systemPrompt, cache_control: { type: "ephemeral" } }],
      tools,
      tool_choice: toolChoice,
      output_config: { effort: "medium" },
      messages: withMessageCache(state.messages),
    },
    { signal: AbortSignal.timeout(Math.min(deps.modelTimeoutMs ?? LIMITS.MODEL_TIMEOUT_MS, restanteTurno)) },
  );
  turn.usage.calls++;
  turn.usage.input += res.usage.input_tokens;
  turn.usage.output += res.usage.output_tokens;
  turn.usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
  turn.usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
  return res;
}

/** Saldo de tokens de salida del turno: ningun max_tokens puede superarlo. */
const restante = (turn: TurnAcc): number => Math.max(0, LIMITS.MAX_TOTAL_OUTPUT_TOKENS - turn.usage.output);

const AUTO: Anthropic.ToolChoice = { type: "auto", disable_parallel_tool_use: true };

export interface LoopOpts {
  /**
   * Turno posterior a una decision humana: solo se redacta el resumen final (tool_choice none, sin herramientas). Lo que
   * hacia falta ya esta en el historial (resultado de la accion); permitir mas acciones aqui abriria un camino para que un
   * texto inyectado en los documentos encadene otra accion justo despues de aprobar o rechazar.
   */
  soloResumen?: boolean;
  /** Historial anterior al mensaje del usuario de este turno: si el contexto se desborda, se restaura (el mensaje se descarta). */
  rollbackTo?: Message[];
}

/** Bloques de razonamiento (sin texto visible ni tool_use): un max_tokens que solo produjo esto no sirve de respuesta. */
const sinContenidoUtil = (content: Anthropic.ContentBlock[]) => !content.some((b) => (b.type === "text" && b.text.trim()) || b.type === "tool_use");

export async function runAgentLoop(deps: LoopDeps, state: SessionState, turn: TurnAcc, emit: Emit, opts: LoopOpts = {}): Promise<TurnStatus> {
  const tools = toAnthropicTools(deps.tools);
  sanitizeHistory(state);

  const pushAssistant = async (res: Anthropic.Message) => {
    for (const b of res.content) if (b.type === "text" && b.text.trim()) await emit({ type: "assistant_text", text: b.text });
    const content = cleanContent(res.content);
    if (content.length > 0) state.messages.push({ role: "assistant", content: content as Anthropic.ContentBlockParam[] });
  };
  const notice = (level: "info" | "warn" | "error", text: string) => emit({ type: "notice", level, text });

  // Presupuesto de llamadas REALES (los reintentos cuentan). Con soloResumen: el resumen y, si se corta razonando, un reintento.
  const maxCalls = opts.soloResumen ? 2 : LIMITS.MAX_ITERATIONS;
  let llamadas = 0;
  /** La ultima llamada del presupuesto (o cualquiera en soloResumen) va sin herramientas: resumen final. */
  const eleccion = (): Anthropic.ToolChoice => (opts.soloResumen || llamadas >= maxCalls - 1 ? { type: "none" } : AUTO);
  const llamar = async (maxTokens: number, choice: Anthropic.ToolChoice) => {
    llamadas++;
    return callModel(deps, state, turn, tools, maxTokens, choice);
  };

  while (llamadas < maxCalls) {
    if (restante(turn) < LIMITS.MIN_CALL_TOKENS) {
      await notice("warn", "Se alcanzó el límite de tokens de este turno.");
      return "done";
    }
    const ultima = opts.soloResumen || llamadas >= maxCalls - 1;
    const primero = Math.min(LIMITS.MAX_TOKENS, restante(turn));
    let res = await llamar(primero, eleccion());
    // max_tokens: con un tool_use a medias O con solo razonamiento (thinking consumio el presupuesto antes de producir nada)
    // se reintenta UNA vez con mas margen, si cabe en el saldo y en el presupuesto de llamadas.
    if (res.stop_reason === "max_tokens" && (toolUses(res.content).length > 0 || sinContenidoUtil(res.content)) && llamadas < maxCalls) {
      const reintento = Math.min(LIMITS.MAX_TOKENS_RETRY, restante(turn));
      if (reintento > primero) res = await llamar(reintento, eleccion());
    }

    switch (res.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        await pushAssistant(res);
        return "done";

      case "max_tokens": {
        if (toolUses(res.content).length > 0) {
          // Sigue cortado con un tool_use a medias: se descarta el turno entero (nada dangling).
          await notice("warn", "La respuesta del agente se cortó por límite de tokens y se descartó. Intenta de nuevo con una petición más acotada.");
          return "done";
        }
        const hayTexto = res.content.some((b) => b.type === "text" && b.text.trim());
        if (hayTexto) await pushAssistant(res);
        await notice("warn", hayTexto ? "La respuesta se cortó por límite de tokens." : "El modelo agotó su límite de tokens razonando y no produjo respuesta. Intenta de nuevo con una petición más acotada.");
        return "done";
      }

      case "tool_use": {
        if (ultima) {
          // No deberia ocurrir con tool_choice none; si ocurre, no se ejecuta nada.
          await notice("warn", opts.soloResumen ? "El modelo intentó usar herramientas al resumir; no se ejecutó nada." : "Se alcanzó el máximo de iteraciones del agente.");
          return "done";
        }
        if (toolUses(res.content).length === 0) {
          // stop_reason tool_use sin ningun bloque tool_use: guardar un mensaje `user` vacio rompe la siguiente llamada (400).
          await pushAssistant(res);
          await notice("warn", "El modelo indicó que usaría una herramienta pero no envió ninguna llamada. Intenta de nuevo.");
          return "done";
        }
        const status = await handleToolUse(deps, state, turn, emit, res);
        if (status === "pending_confirmation") return status;
        break; // seguir el bucle
      }

      case "refusal":
        for (const b of res.content) if (b.type === "text" && b.text.trim()) await emit({ type: "assistant_text", text: b.text });
        await notice("error", "El modelo declinó responder a esta solicitud.");
        return "done";

      case "pause_turn":
        await notice("warn", "El modelo pausó el turno (no soportado en este agente). Intenta de nuevo.");
        return "done";

      case "model_context_window_exceeded":
        if (opts.rollbackTo) {
          // El mensaje de este turno no cabe: se descarta del historial para que la conversacion siga usable (y no falle cada turno).
          state.messages = opts.rollbackTo;
          state.pending = null;
          await deps.persist();
          await notice("error", "La conversación excedió la ventana de contexto: tu último mensaje se descartó. Inicia una nueva conversación para continuar.");
        } else {
          await notice("error", "La conversación excedió la ventana de contexto. Inicia una nueva conversación.");
        }
        return "done";

      default:
        await notice("error", `El modelo terminó con un estado inesperado (${String(res.stop_reason)}).`);
        return "done";
    }

    if (ultima) return "done";
  }
  await notice("warn", "Se alcanzó el máximo de iteraciones del agente.");
  return "done";
}

async function runPlainTool(deps: LoopDeps, turn: TurnAcc, emit: Emit, u: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  await emit({ type: "tool_call", id: u.id, name: u.name, input: u.input });
  const t0 = Date.now();
  const r = await executeTool(deps.tools, u.name, u.input, deps.ctx);
  const ms = Date.now() - t0;
  const output = r.ok ? r.output : r.error;
  turn.tools.push({ name: u.name, ms, ok: r.ok });
  await emit({ type: "tool_result", id: u.id, name: u.name, ok: r.ok, output, ms, ...(r.ok ? {} : { ...(r.code ? { code: r.code } : {}), ...(r.ref ? { ref: r.ref } : {}) }) });
  return toolResultBlock(u.id, r.ok, output);
}

async function handleToolUse(
  deps: LoopDeps,
  state: SessionState,
  turn: TurnAcc,
  emit: Emit,
  res: Anthropic.Message,
): Promise<TurnStatus | "continue"> {
  const uses = toolUses(res.content);
  const assistant: Message = { role: "assistant", content: cleanContent(res.content) as Anthropic.ContentBlockParam[] };
  for (const b of res.content) if (b.type === "text" && b.text.trim()) await emit({ type: "assistant_text", text: b.text });

  const ids = uses.map((u) => u.id);
  if (new Set(ids).size !== ids.length) {
    // Ids repetidos: la API rechazaria el historial. No se guarda el tool_use; solo el texto y un aviso, y el modelo reintenta.
    const textos = assistant.content as Anthropic.ContentBlockParam[];
    const soloTexto = textos.filter((b) => b.type === "text");
    state.messages.push(
      { role: "assistant", content: soloTexto.length ? soloTexto : [{ type: "text", text: "(llamada a herramientas inválida descartada)" }] },
      { role: "user", content: "Sistema: tu llamada a herramientas se descartó porque repetía ids de tool_use. Vuelve a intentarlo con llamadas válidas." },
    );
    await emit({ type: "notice", level: "warn", text: "El modelo envió llamadas con ids duplicados; se descartaron y se reintenta." });
    await deps.persist();
    return "continue";
  }
  const results = new Map<string, Anthropic.ToolResultBlockParam>();
  let gated: { use: Anthropic.ToolUseBlock; input: unknown; data: unknown; view: PendingView["vista"]; resumen: string; huella?: string } | null = null;

  for (const u of uses) {
    const tool = deps.tools.find((t) => t.name === u.name);
    if (!tool?.requiresConfirmation) {
      results.set(u.id, await runPlainTool(deps, turn, emit, u)); // tool desconocida => executeTool devuelve el error
      continue;
    }
    await emit({ type: "tool_call", id: u.id, name: u.name, input: u.input });
    const pf = await preflightTool(tool, u.input, deps.ctx);
    if (!pf.ok) {
      // Bloqueado o invalido: el error vuelve al modelo; la persona no se entera.
      turn.tools.push({ name: u.name, ms: 0, ok: false, ...(pf.code === CODIGO.CONTROLES_FALLA ? { bloqueo: "controles" as const } : pf.code === CODIGO.YA_PROCESADA ? { bloqueo: "ya_procesada" as const } : {}) });
      await emit({ type: "tool_result", id: u.id, name: u.name, ok: false, output: pf.error, ms: 0, ...(pf.code ? { code: pf.code } : {}), ...(pf.ref ? { ref: pf.ref } : {}) });
      results.set(u.id, toolResultBlock(u.id, false, pf.error));
    } else if (gated) {
      const msg = "No ejecutada: solo se admite una acción con confirmación por turno. Pídela por separado.";
      await emit({ type: "tool_result", id: u.id, name: u.name, ok: false, output: msg, ms: 0 });
      results.set(u.id, toolResultBlock(u.id, false, msg));
    } else {
      gated = { use: u, input: pf.input, data: pf.data, view: pf.vista, resumen: pf.resumen, ...(pf.huella ? { huella: pf.huella } : {}) };
    }
  }

  if (!gated) {
    state.messages.push(assistant, { role: "user", content: uses.map((u) => results.get(u.id)!) });
    await deps.persist();
    return "continue";
  }

  const pending: PendingAction = {
    pendingId: crypto.randomUUID(),
    toolUseId: gated.use.id,
    name: gated.use.name,
    input: gated.input,
    preflight: gated.data,
    ...(gated.huella ? { huella: gated.huella } : {}),
    view: { pendingId: "", toolUseId: gated.use.id, name: gated.use.name, resumen: gated.resumen, vista: gated.view },
    order: ids,
    partial: Object.fromEntries(results),
    createdAt: deps.now(),
  };
  pending.view.pendingId = pending.pendingId;
  state.messages.push(assistant);
  state.pending = pending;
  // Se guardan los controles tal como los vio la persona que aprueba (para el informe de auditoría).
  const vista = gated.view as { solicitudId?: string; controles?: unknown } | undefined;
  state.audit.push({
    ts: deps.now(),
    type: "pending_creado",
    pendingId: pending.pendingId,
    tool: pending.name,
    input: pending.input,
    traceId: turn.traceId,
    ...(pending.huella ? { huella: pending.huella } : {}),
    ...(vista?.solicitudId ? { solicitudId: vista.solicitudId, controles: vista.controles } : {}),
  });
  await deps.persist();
  await emit({ type: "pending_confirmation", pending: pending.view });
  return "pending_confirmation";
}

/**
 * Aplica la decision humana sobre la accion pendiente de la sesion y sigue el bucle.
 * La decision se CONSUME de forma atomica (persistida) ANTES de ejecutar: no hay reproduccion posible.
 * Precondicion (la verifica Session): state.pending.pendingId === pendingId.
 */
export async function resolvePending(
  deps: LoopDeps,
  state: SessionState,
  turn: TurnAcc,
  emit: Emit,
  decision: { aprobar: boolean; comentario?: string },
): Promise<TurnStatus> {
  const p = state.pending;
  if (!p) throw new Error("No hay acción pendiente.");
  state.pending = null;
  state.audit.push({
    ts: deps.now(),
    type: "decision",
    pendingId: p.pendingId,
    decision: decision.aprobar ? "aprobar" : "rechazar",
    comentario: decision.comentario ?? null,
    traceId: turn.traceId,
  });
  await deps.persist(); // consumida: ni un segundo POST ni un reintento tras un fallo pueden re-ejecutarla
  await emit({ type: "decision", pendingId: p.pendingId, decision: decision.aprobar ? "aprobar" : "rechazar", ...(decision.comentario ? { comentario: decision.comentario } : {}) });

  let ok = false;
  let obsoleta = false; // aprobacion invalidada porque cambiaron datos/controles: el agente SI puede volver a proponer (con nueva aprobacion)
  let output: unknown;
  let fail: { code?: string; ref?: string } = {};
  const tool = deps.tools.find((t) => t.name === p.name);
  const t0 = Date.now();
  if (decision.aprobar) {
    // La aprobacion vale SOLO para lo que la persona vio: se re-ejecuta el preflight y se compara la huella
    // (OC + controles + documentos). Si cambio algo (p. ej. aparecio una factura), no se crea nada.
    let invalida: string | null = null;
    if (tool?.preflight && p.huella !== undefined) {
      const pf = await preflightTool(tool, p.input, deps.ctx);
      if (!pf.ok) invalida = `${MSG_APROBACION_OBSOLETA} Estado actual: ${pf.error}`;
      else if (pf.huella !== p.huella) invalida = MSG_APROBACION_OBSOLETA;
    }
    if (invalida) {
      output = invalida;
      obsoleta = true;
      fail = { code: CODIGO.APROBACION_OBSOLETA };
      state.audit.push({ ts: deps.now(), type: "aprobacion_invalidada", pendingId: p.pendingId, tool: p.name, traceId: turn.traceId });
      await emit({ type: "notice", level: "warn", text: MSG_APROBACION_OBSOLETA });
    } else {
      const r = await executeTool(deps.tools, p.name, p.input, deps.ctx, {
        confirmation: "humano",
        preflight: p.preflight,
        ...(decision.aprobar && decision.comentario ? { comentarioAprobador: decision.comentario } : {}),
      });
      ok = r.ok;
      output = r.ok ? r.output : r.error;
      if (!r.ok) fail = { ...(r.code ? { code: r.code } : {}), ...(r.ref ? { ref: r.ref } : {}) };
      state.audit.push({ ts: deps.now(), type: "tool_ejecutada", pendingId: p.pendingId, tool: p.name, ok, resultado: output, traceId: turn.traceId });
    }
  } else {
    output = `RECHAZADA por la persona. Comentario: ${decision.comentario?.trim() || "(sin comentario)"}`;
  }
  const ms = Date.now() - t0;
  turn.tools.push({ name: p.name, ms, ok, ...(decision.aprobar ? {} : { bloqueo: "rechazo" as const }) });
  const recibo = ok ? tool?.recibo?.(output) : undefined;
  await emit({ type: "tool_result", id: p.toolUseId, name: p.name, ok, output, ms, ...fail, ...(recibo !== undefined ? { recibo } : {}) });

  const own = toolResultBlock(p.toolUseId, ok, output);
  state.messages.push({ role: "user", content: p.order.map((id) => (id === p.toolUseId ? own : p.partial[id] ?? toolResultBlock(id, false, ERR_INTERRUMPIDA))) });
  await deps.persist(); // el resultado de la tool queda guardado aunque falle la siguiente llamada al modelo
  if (decision.aprobar && ok) {
    // La OC YA existe en SAP: si falla la llamada que redacta el resumen, no es un error que invite a reintentar.
    try {
      return await runAgentLoop(deps, state, turn, emit, { soloResumen: !obsoleta });
    } catch (e) {
      const numero = (output as { numero?: string } | null)?.numero ?? "(sin número)";
      console.error(JSON.stringify({ level: "error", traceId: turn.traceId, message: `resumen post-OC: ${e instanceof Error ? e.message : String(e)}` }));
      state.audit.push({ ts: deps.now(), type: "turno_error", traceId: turn.traceId, fase: "resumen_post_oc", pendingId: p.pendingId });
      await emit({ type: "notice", level: "warn", text: `La OC ${numero} quedó creada; no se pudo generar el resumen del asistente. No hace falta repetir la aprobación.` });
      return "done";
    }
  }
  return runAgentLoop(deps, state, turn, emit, { soloResumen: !obsoleta });
}
