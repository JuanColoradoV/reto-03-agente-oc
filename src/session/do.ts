// Durable Object: una instancia por sesion de chat (idFromName(sessionId)). Guarda historial de
// Anthropic, accion pendiente, SAP simulado (OC + contador), audit log y traza. Solo se importa desde
// el Worker (usa "cloudflare:workers").
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { BUDGET_ID } from "../budget/do";
import { getPrompt } from "../data/repo";
import { getClient } from "../llm/client";
import { createMockClient, withLatency } from "../llm/mock";
import { ocTools } from "../tools/oc";
import { fechaNegocio } from "../domain/fecha";
import { buildSessionApp, MOCK_HEADER } from "./routes";
import { Session, type SessionEnv } from "./session";
import { SessionStore } from "./storage";

export interface DoEnv {
  ANTHROPIC_API_KEY?: string;
  /** Contador global de gasto diario (opcional: sin el binding no se lleva la cuenta global). */
  BUDGET?: DurableObjectNamespace;
}

export { MOCK_HEADER };

const TTL_MS = 24 * 60 * 60 * 1000; // la sesion se borra tras 24 h sin actividad

export class SessionDO extends DurableObject<DoEnv> {
  private app: Hono;

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    // MODO SIMULADO (solo dev): lo decide el Worker por peticion y llega como parametro inmutable del turno (TurnOpts);
    // el DO no guarda ningun flag mutable que otra peticion concurrente pueda pisar.
    const sessionEnv: SessionEnv = {
      makeClient: ({ mock }) => (mock ? createMockClient() : getClient(this.env.ANTHROPIC_API_KEY)),
      systemPrompt: getPrompt(),
      tools: ocTools,
      toolsFor: ({ mock }) => (mock ? withLatency(ocTools) : ocTools),
      fecha: () => fechaNegocio(new Date()), // dia calendario en America/Bogota (no UTC)
      now: () => new Date().toISOString(),
      log: (e) => console.log(JSON.stringify(e)),
      // Suma el costo estimado de cada turno al presupuesto global del dia (mejor esfuerzo: un fallo no rompe el turno).
      onSpend: async (usd) => {
        const b = this.env.BUDGET;
        if (!b) return;
        await b.get(b.idFromName(BUDGET_ID)).fetch("https://budget/add", { method: "POST", body: JSON.stringify({ usd }) });
      },
    };
    const session = new Session(ctx.id.name ?? ctx.id.toString(), new SessionStore(ctx.storage), sessionEnv);
    this.app = buildSessionApp(() => session);
    // Un DO recien construido no tiene turnos en vuelo (un reinicio/hot-reload los mato): libera cualquier lease huerfano.
    ctx.blockConcurrencyWhile(() => new SessionStore(ctx.storage).clearLease().catch(() => {}));
  }

  async fetch(request: Request): Promise<Response> {
    // Las lecturas (GET state/trace) nunca esperan nada: no tocan alarma ni lease.
    if (request.method !== "GET") await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
    return this.app.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
