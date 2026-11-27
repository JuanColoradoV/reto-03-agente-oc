// Durable Object UNICO ("global") que lleva el gasto estimado del dia de toda la demo. Solo se importa desde el Worker.
// Sus llamadas son atomicas (compuertas de entrada del DO): lectura y escritura no se intercalan con otra peticion.
import { DurableObject } from "cloudflare:workers";
import { fechaNegocio } from "../domain/fecha";
import { BudgetLedger } from "./ledger";

export class BudgetDO extends DurableObject {
  private ledger = new BudgetLedger(this.ctx.storage, () => fechaNegocio(new Date()));

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      const tope = Number(url.searchParams.get("tope"));
      return Response.json(await this.ledger.consultar(tope));
    }
    if (request.method === "POST" && url.pathname === "/add") {
      const { usd } = (await request.json().catch(() => ({}))) as { usd?: number };
      return Response.json(await this.ledger.sumar(Number(usd)));
    }
    return new Response("not found", { status: 404 });
  }
}

/** Nombre fijo del objeto global. */
export const BUDGET_ID = "global";
