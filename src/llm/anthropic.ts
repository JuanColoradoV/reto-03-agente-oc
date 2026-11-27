// Implementación de LlmAdapter para Anthropic (Messages API). Traduce los tipos neutrales a los del SDK y viceversa.
import Anthropic from "@anthropic-ai/sdk";
import { ErrorLlm, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type OpcionesEnvio, type Respuesta } from "./adapter";

export const MODELO_POR_DEFECTO = "claude-sonnet-5-5";

/** Cliente mínimo que usa el adaptador: el SDK real lo cumple y las pruebas inyectan un falso. */
export interface ClienteAnthropic {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> };
}

export class FaltaClaveError extends Error {
  constructor() {
    super("Falta configurar ANTHROPIC_API_KEY. Defínela en .dev.vars (local) o con `wrangler secret put ANTHROPIC_API_KEY`.");
  }
}

/** true si `key` parece una clave real (`sk-ant-...`); un placeholder como `sk-ant-...` no cuenta. */
export function claveUsable(key: string | undefined): key is string {
  return typeof key === "string" && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

type Bloque = Anthropic.ContentBlockParam;

function aMensajesSdk(mensajes: Mensaje[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system = mensajes.filter((m) => m.rol === "sistema").map((m) => m.texto).join("\n\n");
  const out: Anthropic.MessageParam[] = [];
  const agregar = (role: "user" | "assistant", content: Bloque[]): void => {
    const previo = out[out.length - 1];
    // La API exige alternar roles: se fusionan mensajes consecutivos del mismo rol (tool_result primero).
    if (previo && previo.role === role) {
      const bloques = [...(previo.content as Bloque[]), ...content];
      const ordenados = [...bloques.filter((b) => b.type === "tool_result"), ...bloques.filter((b) => b.type !== "tool_result")];
      out[out.length - 1] = { role, content: ordenados };
    } else out.push({ role, content });
  };
  for (const m of mensajes) {
    if (m.rol === "usuario") agregar("user", [{ type: "text", text: m.texto }]);
    else if (m.rol === "herramienta") agregar("user", m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, ...(r.error ? { is_error: true } : {}) })));
    else if (m.rol === "asistente") {
      const bloques: Bloque[] = Array.isArray(m.opaco)
        ? (m.opaco as Bloque[])
        : [...(m.texto.trim() ? [{ type: "text" as const, text: m.texto }] : []), ...m.llamadas.map((l) => ({ type: "tool_use" as const, id: l.id, name: l.nombre, input: (l.args ?? {}) as Record<string, unknown> }))];
      if (bloques.length) agregar("assistant", bloques);
    }
  }
  // Cache del prefijo de la conversación: marca el último bloque.
  const last = out[out.length - 1];
  if (last) {
    const bloques = [...(last.content as Bloque[])];
    const lb = bloques[bloques.length - 1];
    if (lb) bloques[bloques.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as Bloque;
    out[out.length - 1] = last.role === "user" ? { role: "user", content: bloques } : { role: "assistant", content: bloques };
  }
  return { system, messages: out };
}

function aHerramientasSdk(hs: DefinicionHerramienta[]): Anthropic.Tool[] {
  return hs.map((h, i) => ({
    name: h.nombre,
    description: h.descripcion,
    input_schema: h.esquema as Anthropic.Tool.InputSchema,
    ...(i === hs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** Clasifica un error del SDK/red en un ErrorLlm con mensaje claro. */
export function clasificarError(e: unknown): ErrorLlm {
  if (e instanceof ErrorLlm) return e;
  const nombre = e instanceof Error ? e.name : "";
  if (nombre === "TimeoutError" || nombre === "AbortError" || (e instanceof Error && /timeout|timed out|aborted/i.test(e.message))) return new ErrorLlm("timeout", "El modelo tardó demasiado en responder.");
  const status = (e as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return new ErrorLlm("clave", "El proveedor rechazó la clave de API configurada.");
  if (status === 429) return new ErrorLlm("limite", "El proveedor del modelo está limitando las solicitudes (límite de uso). Espera un momento y reintenta.");
  if (status === 400 && /context|too long|prompt is too long/i.test(e instanceof Error ? e.message : "")) return new ErrorLlm("contexto", "La conversación excedió la ventana de contexto del modelo.");
  return new ErrorLlm("proveedor", status && status >= 500 ? "El proveedor del modelo no está disponible en este momento." : "No se pudo obtener respuesta del modelo.");
}

export class AnthropicAdapter implements LlmAdapter {
  readonly proveedor = "anthropic";
  constructor(
    private cliente: ClienteAnthropic,
    readonly modelo: string = MODELO_POR_DEFECTO,
  ) {}

  /** `maxRetries: 0`: cada intento del ciclo es exactamente una petición HTTP (el tope de iteraciones es real). */
  static conClave(apiKey: string | undefined, modelo?: string): AnthropicAdapter {
    if (!claveUsable(apiKey)) throw new FaltaClaveError();
    return new AnthropicAdapter(new Anthropic({ apiKey: apiKey.trim(), maxRetries: 0 }) as unknown as ClienteAnthropic, modelo || MODELO_POR_DEFECTO);
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio = {}): Promise<Respuesta> {
    const { system, messages } = aMensajesSdk(mensajes);
    let res: Anthropic.Message;
    try {
      res = await this.cliente.messages.create(
        {
          model: this.modelo,
          max_tokens: opciones.maxTokens ?? 8192,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools: aHerramientasSdk(herramientas),
          tool_choice: opciones.sinHerramientas ? { type: "none" } : { type: "auto", disable_parallel_tool_use: true },
          output_config: { effort: "medium" },
          messages,
        },
        opciones.signal ? { signal: opciones.signal } : undefined,
      );
    } catch (e) {
      throw clasificarError(e);
    }
    const contenido = res.content.filter((b) => b.type !== "text" || b.text.trim() !== "");
    const llamadas = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, nombre: b.name, args: b.input }));
    const fin = res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence" ? "fin" : res.stop_reason === "tool_use" ? "herramientas" : res.stop_reason === "max_tokens" ? "limite_tokens" : res.stop_reason === "refusal" ? "rechazo" : "otro";
    return {
      texto: res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim(),
      llamadas,
      fin,
      uso: { entrada: res.usage.input_tokens, salida: res.usage.output_tokens, cacheLeida: res.usage.cache_read_input_tokens ?? 0, cacheEscrita: res.usage.cache_creation_input_tokens ?? 0 },
      opaco: contenido,
    };
  }
}
