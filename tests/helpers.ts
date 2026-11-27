import type Anthropic from "@anthropic-ai/sdk";
import type { UiEvent } from "../src/agent/events";
import type { LlmClient } from "../src/agent/loop";
import { getPrompt } from "../src/data/repo";
import { Session, type SessionEnv } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";
import { ocTools } from "../src/tools/oc";

export type Script = Array<Anthropic.Message | Error>;

export function fakeMessage(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason | null, output = 50): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
  } as unknown as Anthropic.Message;
}
export const text = (t: string): Anthropic.ContentBlock => ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;
export const toolUse = (id: string, name: string, input: unknown): Anthropic.ContentBlock => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.ContentBlock;

/** Cliente falso: devuelve las respuestas en orden (o lanza el Error) y registra los parametros de cada llamada. */
export function fakeClient(script: Script) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const client: LlmClient = {
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const r = script[i++];
        if (!r) throw new Error("fakeClient: guion agotado");
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { client, calls };
}

export function makeSession(script: Script, kv = new MemoryKV(), id = "sess-test", overrides: Partial<SessionEnv> = {}) {
  const fake = fakeClient(script);
  const env: SessionEnv = {
    makeClient: () => fake.client,
    systemPrompt: getPrompt(),
    tools: ocTools,
    fecha: () => "2026-01-15",
    now: () => "2026-01-15T00:00:00.000Z",
    log: () => {},
    ...overrides,
  };
  const store = new SessionStore(kv);
  return { session: new Session(id, store, env), store, kv, ...fake };
}

export async function collect(fn: (on: (e: UiEvent) => void) => Promise<unknown>): Promise<{ events: UiEvent[]; result: unknown }> {
  const events: UiEvent[] = [];
  const result = await fn((e) => void events.push(e));
  return { events, result };
}

export const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = orig;
  });
};
