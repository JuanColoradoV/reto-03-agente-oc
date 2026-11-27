// Durable Object de guardas (uno por IP: "ip:<ip>", y uno por sesion: "ses:<id>"). Solo se importa desde el Worker. Se usa por RPC.
import { DurableObject } from "cloudflare:workers";
import { GuardLedger } from "./ledger";

export class GuardDO extends DurableObject {
  private ledger = new GuardLedger(this.ctx.storage);
  bloqueo() {
    return this.ledger.bloqueo();
  }
  strike(max: number, ventanaMs: number, bloqueoMs: number) {
    return this.ledger.strike(max, ventanaMs, bloqueoMs);
  }
  consumirDia(max: number) {
    return this.ledger.consumirDia(max);
  }
  consumirSesion(max: number) {
    return this.ledger.consumirSesion(max);
  }
}
