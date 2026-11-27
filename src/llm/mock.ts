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

type Block = { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
const blocks = (m: Anthropic.MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]));
const asString = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

function extractId(s: string): string | null {
  const m = s.match(/sol-[0-9a-z]+/i);
  if (!m) return null;
  const rest = m[0].slice(4);
  return "sol-" + (/^\d+$/.test(rest) ? rest : rest.toUpperCase());
}

interface Control {
  id: string;
  nombre: string;
  resultado: "OK" | "FALLA" | "ALERTA";
  detalle: string;
}
interface Validacion {
  controles: Control[];
  aprobable: boolean;
}

function parseValidacion(raw: string): Validacion | null {
  try {
    const v = JSON.parse(raw) as Partial<Validacion>;
    return Array.isArray(v.controles) ? { controles: v.controles, aprobable: v.aprobable !== false && !v.controles.some((c) => c.resultado === "FALLA") } : null;
  } catch {
    return null;
  }
}

/** Ultima solicitud sobre la que se validaron controles en el historial (para preguntas sin id). */
function lastSolicitud(msgs: Anthropic.MessageParam[]): string | null {
  let found: string | null = null;
  for (const m of msgs) for (const b of blocks(m)) if (b.type === "tool_use" && b.name === "validar_controles") found = extractId(String((b.input as { id?: string } | undefined)?.id ?? "")) ?? found;
  return found;
}

const fallas = (v: Validacion) => v.controles.filter((c) => c.resultado === "FALLA");

/** Resumen UNICO del bloqueo: el detalle y "que hacer" estan en la tarjeta de resultado de la UI. */
function blockedText(id: string, v: Validacion): string {
  const f = fallas(v);
  const dup = f.length === 1 && f[0]!.id === "C0" ? f[0]!.detalle.match(/ya tiene la OC (\d+)/) : null;
  if (dup) return `La solicitud ${id} ya tiene la OC ${dup[1]}: no se crea otra ni hace falta tu aprobación.\n\nEstado final: **Ya procesada** (OC ${dup[1]}).`;
  const names = f.map((c) => `${c.id} ${c.nombre}`).join(", ");
  return `No creo la orden de ${id}: ${f.length === 1 ? "falló el control" : "fallaron los controles"} ${names}. El detalle y qué corregir están en el aviso de abajo; no se pide tu aprobación.\n\nEstado final: **Bloqueada por controles**.`;
}

/** Respuesta a "¿qué controles fallaron en sol-X?": se contesta con la validacion, sin tocar el flujo de creacion. */
function answerControls(id: string, v: Validacion): string {
  const f = fallas(v);
  const al = v.controles.filter((c) => c.resultado === "ALERTA");
  const items = (l: Control[]) => l.map((c) => `- ${c.id} ${c.nombre}: ${c.detalle}`).join("\n");
  if (f.length) return `En ${id} ${f.length === 1 ? "falló 1 control" : `fallaron ${f.length} controles`}:\n\n${items(f)}` + (al.length ? `\n\nAdemás hay ${al.length} alerta(s):\n\n${items(al)}` : "") + "\n\nEsta consulta no crea ni cambia nada.";
  return `En ${id} ningún control falla (${v.controles.filter((c) => c.resultado === "OK").length} OK${al.length ? `, ${al.length} alerta(s)` : ""}).` + (al.length ? `\n\n${items(al)}` : "") + "\n\nEsta consulta no crea ni cambia nada.";
}

const isQuestion = (t: string) => !/procesa|procesar|crea\b|crear|genera/i.test(t) && /qu[eé] controles|cu[aá]les|por qu[eé]|motivo|fall(ó|o|aron|an|a)\b/i.test(t);

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
  const before = msgs.slice(0, start >= 0 ? start : 0);
  const after = msgs.slice(start + 1);
  const uses = after.filter((m) => m.role === "assistant").flatMap((m) => blocks(m).filter((b) => b.type === "tool_use")) as Array<{ name: string }>;
  const results = after.filter((m) => m.role === "user").flatMap((m) => blocks(m).filter((b) => b.type === "tool_result"));
  const last = results[results.length - 1];
  const lastText = last ? asString(last.content) : "";
  const id = extractId(request);
  const n = uses.length;

  // Pregunta sobre controles ("¿Qué controles fallaron en sol-00X?"): se responde con una validacion de solo lectura de esa
  // solicitud (o la ultima consultada), siempre fresca, sin pasar por el flujo de creacion de OC.
  if (isQuestion(request)) {
    const qid = id ?? lastSolicitud(before);
    if (!qid) return message([text("Indica la solicitud (por ejemplo, sol-00X) y reviso sus controles.")], "end_turn");
    if (n === 0) return message([text(`Reviso los controles de ${qid}.`), use("validar_controles", { id: qid })], "tool_use");
    const v = last?.is_error ? null : parseValidacion(lastText);
    return message([text(v ? answerControls(qid, v) : `No pude revisar los controles de ${qid}: ${lastText}`)], "end_turn");
  }

  if (!id) {
    if (/lista|solicitudes|disponibles/i.test(request)) {
      if (n === 0) return message([text("Reviso qué solicitudes hay disponibles."), use("listar_solicitudes", {})], "tool_use");
      return message([text("Estas son las solicitudes disponibles. Para procesar una, escribe por ejemplo: «Procesa la solicitud sol-000».")], "end_turn");
    }
    return message([text("Hola. Estás en modo simulado: no hay un modelo real conectado. Puedo recorrer el flujo completo de una solicitud; prueba con «Procesa la solicitud sol-000» o «Procesa la solicitud sol-00X», o pregunta «¿Qué controles fallaron en sol-00X?».")], "end_turn");
  }

  if (n === 0) return message([text(`Voy a procesar la solicitud ${id}. Primero leo los documentos.`), use("leer_solicitud", { id })], "tool_use");
  if (n === 1) {
    if (last?.is_error) return message([text(`No pude leer la solicitud ${id}: ${lastText}\n\nVerifica el identificador e inténtalo de nuevo.`)], "end_turn");
    return message([text("Documentos leídos. Ahora ejecuto los controles."), use("validar_controles", { id })], "tool_use");
  }
  if (n === 2) {
    // Como un modelo bien instruido: con cualquier control bloqueante en FALLA NO se llama a crear_orden_compra.
    const v = last?.is_error ? null : parseValidacion(lastText);
    if (!v) return message([text(`No pude validar los controles de ${id}: ${lastText}\n\nEstado final: **Bloqueada por controles**.`)], "end_turn");
    if (!v.aprobable) return message([text(blockedText(id, v))], "end_turn");
    const al = v.controles.filter((c) => c.resultado === "ALERTA").length;
    return message([text(`Los controles pasaron${al ? ` (con ${al} alerta(s) para que las consideres)` : ""}. Solicito crear la orden de compra: queda **Pendiente de aprobación** hasta que decidas.`), use("crear_orden_compra", { solicitudId: id })], "tool_use");
  }

  // n >= 3: resultado de crear_orden_compra
  if (last?.is_error) {
    if (/RECHAZADA/.test(lastText)) {
      const motivo = lastText.replace(/^RECHAZADA por la persona\.\s*(Comentario:\s*)?/, "");
      return message([text(`Entendido: no se creó la orden de ${id}. Motivo registrado: ${motivo}\n\nEstado final: **Rechazada por el aprobador**. Dime si quieres revisar otra solicitud.`)], "end_turn");
    }
    const f = lastText.replace(/^.*Controles en FALLA:\s*/s, "").split(" | ").filter(Boolean);
    return message([text(`No se creó la orden de ${id}: la revalidación del sistema encontró ${f.length === 1 ? "un control" : `${f.length} controles`} en falla. El detalle está en el aviso de abajo.\n\nEstado final: **Bloqueada por controles**.`)], "end_turn");
  }
  let numero = "(sin número)";
  try {
    numero = (JSON.parse(lastText) as { numero?: string }).numero ?? numero;
  } catch {
    /* salida no JSON */
  }
  return message([text(`Listo: la orden de compra ${numero} quedó creada en SAP (simulado) para ${id}.\n\nEstado final: **OC creada** (${numero}).`)], "end_turn");
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
