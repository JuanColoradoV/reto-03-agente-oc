import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../agent/loop";

export const MODEL_AGENT = "claude-sonnet-5-5";

export class MissingApiKeyError extends Error {
  constructor() {
    super("Falta configurar ANTHROPIC_API_KEY. Defínela en .dev.vars (local) o con `wrangler secret put ANTHROPIC_API_KEY`.");
  }
}

/**
 * true si `key` tiene la forma de una clave real de Anthropic (`sk-ant-...` con cuerpo alfanumérico). Un valor de ejemplo como
 * `sk-ant-...` (el de `.dev.vars.example`) NO cuenta: se trata como "falta la clave" y la UI muestra el aviso en español en
 * vez de un error genérico de autenticación. No valida que la clave funcione, solo descarta placeholders obvios.
 */
export function claveUsable(key: string | undefined): key is string {
  return typeof key === "string" && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/**
 * `maxRetries: 0`: el SDK reintenta por defecto 2 veces (429/5xx/red) sin que el bucle lo sepa, lo que haría falsa la cuenta de
 * "máx. 8 llamadas por turno". Sin reintentos ocultos, cada intento del bucle es exactamente una petición HTTP (el bucle ya
 * cuenta cada intento en `iterations`, también los que fallan). Un fallo transitorio se muestra al usuario, que puede repetir.
 */
export function getClient(apiKey: string | undefined): Anthropic & LlmClient {
  if (!claveUsable(apiKey)) throw new MissingApiKeyError();
  return new Anthropic({ apiKey: apiKey.trim(), maxRetries: 0 }) as Anthropic & LlmClient;
}
