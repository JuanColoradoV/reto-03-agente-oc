// MODO SIMULADO (solo desarrollo): cliente "Anthropic" con guion para recorrer el flujo completo sin API key.
// No hay estado en el cliente: cada respuesta se deduce del historial (el cliente se crea por peticion).
// Seguridad: `mockEnabled` solo devuelve true en localhost/127.0.0.1 (o con ENV=dev explicito). El Worker es
// el unico que lo evalua y lo comunica al Durable Object con una cabecera que el cliente no controla.
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../agent/loop";
import type { ToolDef } from "../tools/registry";

export interface MockEnv {
  MOCK_LLM?: string;
  ENV?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** true solo si MOCK_LLM=1 Y (host local O ENV=dev). Nunca en un despliegue normal. */
export function mockEnabled(env: MockEnv, requestUrl: string): boolean {
  if (env.MOCK_LLM !== "1") return false;
  if (env.ENV === "dev") return true;
  try {
    return LOCAL_HOSTS.has(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = () => 300 + Math.floor(Math.random() * 400); // 300-700 ms

/** Envuelve las tools con una latencia visible (la UI muestra "ejecutando…"). */
export function withLatency(tools: ToolDef[]): ToolDef[] {
  return tools.map((t) => ({
    ...t,
    handler: async (input, ctx, run) => {
      await sleep(jitter());
      return t.handler(input, ctx, run);
    },
  }));
}

let seq = 0;
function message(content: unknown[], stop: "end_turn" | "tool_use"): Anthropic.Message {
  const output = 60 + Math.floor(Math.random() * 140);
  return {
    id: `msg_mock_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1800 + Math.floor(Math.random() * 400), output_tokens: output, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const text = (t: string) => ({ type: "text", text: t, citations: null });
const use = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_mock_${++seq}`, name, input });

type Block = { type: string; text?: string; name?: string; content?: unknown; is_error?: boolean };
const blocks = (m: Anthropic.MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]));
const asString = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

function extractId(s: string): string | null {
  const m = s.match(/sol-[0-9a-z]+/i);
  if (!m) return null;
  const rest = m[0].slice(4);
  return "sol-" + (/^\d+$/.test(rest) ? rest : rest.toUpperCase());
}

function reply(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.Message {
  const msgs = params.messages;
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "user" && blocks(m).some((b) => b.type === "text")) {
      start = i;
      break;
    }
  }
  const request = start >= 0 ? blocks(msgs[start]!).find((b) => b.type === "text")?.text ?? "" : "";
  const after = msgs.slice(start + 1);
  const uses = after.filter((m) => m.role === "assistant").flatMap((m) => blocks(m).filter((b) => b.type === "tool_use")) as Array<{ name: string }>;
  const results = after.filter((m) => m.role === "user").flatMap((m) => blocks(m).filter((b) => b.type === "tool_result"));
  const last = results[results.length - 1];
  const lastText = last ? asString(last.content) : "";
  const id = extractId(request);
  const n = uses.length;

  if (!id) {
    if (/lista|solicitudes|disponibles/i.test(request)) {
      if (n === 0) return message([text("Reviso qué solicitudes hay disponibles."), use("listar_solicitudes", {})], "tool_use");
      return message([text("Estas son las solicitudes disponibles. Para procesar una, escribe por ejemplo: «Procesa la solicitud sol-000».")], "end_turn");
    }
    return message([text("Hola. Estás en modo simulado: no hay un modelo real conectado. Puedo recorrer el flujo completo de una solicitud; prueba con «Procesa la solicitud sol-000» o «Procesa la solicitud sol-00X».")], "end_turn");
  }

  if (n === 0) return message([text(`Voy a procesar la solicitud ${id}. Primero leo los documentos.`), use("leer_solicitud", { id })], "tool_use");
  if (n === 1) {
    if (last?.is_error) return message([text(`No pude leer la solicitud ${id}: ${lastText}\n\nVerifica el identificador e inténtalo de nuevo.`)], "end_turn");
    return message([text("Documentos leídos. Ahora ejecuto los controles."), use("validar_controles", { id })], "tool_use");
  }
  if (n === 2) return message([text("Controles ejecutados. Solicito crear la orden de compra; el sistema los revalida antes de pedir aprobación humana."), use("crear_orden_compra", { solicitudId: id })], "tool_use");

  // n >= 3: resultado de crear_orden_compra
  if (last?.is_error) {
    if (/RECHAZADA/.test(lastText)) {
      return message([text(`Entendido: la orden de ${id} no se creó. ${lastText.replace(/^RECHAZADA por la persona\.\s*/, "")}\n\nEstado final: pendiente. Dime si quieres revisar otra solicitud.`)], "end_turn");
    }
    const dup = lastText.match(/C0 OC existente: La solicitud \S+ ya tiene la OC (\d+)/);
    if (dup) {
      return message([text(`La solicitud ${id} ya tiene la OC ${dup[1]}: no se crea una duplicada y no hace falta tu aprobación.\n\nEstado final: OC creada (${dup[1]}).`)], "end_turn");
    }
    const fallas = lastText.replace(/^.*Controles en FALLA:\s*/s, "").split(" | ").filter(Boolean);
    const lista = fallas.map((f) => `- ${f}`).join("\n");
    return message([text(`No puedo crear la OC para ${id}: hay controles bloqueantes en FALLA.\n\n${lista}\n\nHay que corregir estos puntos en la solicitud o la cotización y volver a validar.\n\nEstado final: rechazada por controles.`)], "end_turn");
  }
  let numero = "(sin número)";
  try {
    numero = (JSON.parse(lastText) as { numero?: string }).numero ?? numero;
  } catch {
    /* salida no JSON */
  }
  return message([text(`Listo: la orden de compra ${numero} quedó creada en SAP (simulado) para ${id}.\n\nEstado final: OC creada (${numero}).`)], "end_turn");
}

export function createMockClient(): LlmClient {
  return {
    messages: {
      async create(params) {
        await sleep(jitter());
        return reply(params);
      },
    },
  };
}
