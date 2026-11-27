// Durable Object UNICO ("global") que lleva el gasto estimado del dia de toda la demo. Solo se importa desde el Worker.
// Se usa por RPC. Sus llamadas son atomicas (compuertas de entrada del DO): lectura y escritura no se intercalan con otra peticion.
import { DurableObject } from "cloudflare:workers";
import { fechaNegocio } from "../domain/fecha";
import { BudgetLedger } from "./ledger";

export class BudgetDO extends DurableObject {
  private ledger = new BudgetLedger(this.ctx.storage, () => fechaNegocio(new Date()));

  // Metodos RPC nativos del DO (los invoca el Worker como `stub.consultar(...)` / `stub.sumar(...)`, sin Request/Response falsos).
  consultar(tope: number) {
    return this.ledger.consultar(tope);
  }

  sumar(usd: number) {
    return this.ledger.sumar(usd);
  }
}

/** Nombre fijo del objeto global. */
export const BUDGET_ID = "global";
