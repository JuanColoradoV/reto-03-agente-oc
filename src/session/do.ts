// Durable Object: una instancia por sesion de chat (idFromName(sessionId)). Guarda el historial neutral, la confirmacion
// pendiente, el out/ de la sesion (SAP simulado, control.csv, log.jsonl, evidencias), eventos y traza. Solo se importa desde
// el Worker (usa "cloudflare:workers").
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { configDesdeEnv, type EnvConfig } from "../agent/config";
import { BUDGET_ID } from "../budget/do";
import type { BudgetNamespace } from "../budget/ledger";
import { getSystemPrompt } from "../data/textos";
import { AnthropicAdapter } from "../llm/anthropic";
import { MockAdapter } from "../llm/mock";
import { buildSessionApp, MOCK_HEADER } from "./routes";
import { Session, type SessionEnv } from "./session";
import { SessionStore } from "./storage";

export interface DoEnv extends EnvConfig {
  ANTHROPIC_API_KEY?: string;
  LLM_MODEL?: string;
  /** Contador global de gasto diario (opcional: sin el binding no se lleva la cuenta global). */
  BUDGET?: BudgetNamespace;
}

export { MOCK_HEADER };

const TTL_MS = 24 * 60 * 60 * 1000; // la sesion se borra tras 24 h sin actividad

export class SessionDO extends DurableObject<DoEnv> {
  private app: Hono;

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    // MODO SIMULADO (solo dev): lo decide el Worker por peticion y llega como parametro inmutable del turno (TurnOpts).
    const sessionEnv: SessionEnv = {
      makeLlm: ({ mock }) => (mock ? new MockAdapter() : AnthropicAdapter.conClave(this.env.ANTHROPIC_API_KEY, this.env.LLM_MODEL)),
      systemPrompt: getSystemPrompt(),
      config: configDesdeEnv(this.env),
      now: () => new Date().toISOString(),
      log: (e) => console.log(JSON.stringify(e)),
      // Suma el costo estimado de cada turno al presupuesto global del dia (mejor esfuerzo: un fallo no rompe el turno).
      onSpend: async (usd) => {
        const b = this.env.BUDGET;
        if (!b) return;
        await b.get(b.idFromName(BUDGET_ID)).sumar(usd);
      },
    };
    const session = new Session(ctx.id.name ?? ctx.id.toString(), new SessionStore(ctx.storage), sessionEnv);
    this.app = buildSessionApp(() => session);
    // Un DO recien construido no tiene turnos en vuelo (un reinicio/hot-reload los mato): libera cualquier lease huerfano.
    ctx.blockConcurrencyWhile(() => new SessionStore(ctx.storage).clearLease().catch(() => {}));
  }

  async fetch(request: Request): Promise<Response> {
    // Las lecturas (GET) nunca esperan nada: no tocan alarma ni lease.
    if (request.method !== "GET") await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
    return this.app.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
