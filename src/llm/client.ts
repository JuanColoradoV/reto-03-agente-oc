import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../agent/loop";

export const MODEL_AGENT = "claude-sonnet-5-5";
export const MODEL_HELPER = "claude-haiku-5-5";

export class MissingApiKeyError extends Error {
  constructor() {
    super("Falta configurar ANTHROPIC_API_KEY. Defínela en .dev.vars (local) o con `wrangler secret put ANTHROPIC_API_KEY`.");
  }
}

export function getClient(apiKey: string | undefined): Anthropic & LlmClient {
  if (!apiKey) throw new MissingApiKeyError();
  return new Anthropic({ apiKey }) as Anthropic & LlmClient;
}
