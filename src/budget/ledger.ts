// Presupuesto GLOBAL diario de la demo publica (cortacircuitos de costo). Cada sesion tiene sus topes (turnos, tokens), pero un
// script que rota de sessionId los multiplica; este contador suma el costo ESTIMADO de TODAS las sesiones del dia y, al superar el
// tope, /api/chat responde 503 con un mensaje amable. Es un freno blando: no cuenta el costo en vuelo (un turno corre hasta el
// final y se suma al terminar), asi que puede excederse por unos pocos turnos concurrentes (acotados por el rate limit por IP).
import type { KVStorage } from "../session/storage";

/** Tope por defecto (USD/dia). Configurable con la variable DAILY_BUDGET_USD. */
export const DEFAULT_DAILY_BUDGET_USD = 5;

export const MSG_PRESUPUESTO = "Se alcanzó el límite diario de la demo. Vuelve mañana o pídele al autor que lo amplíe.";

/** Valor numerico positivo o el defecto (variable ausente, vacia o invalida: nunca "sin tope" por error de configuracion). */
export function parseBudget(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

export interface EstadoPresupuesto {
  day: string;
  usd: number;
}

export class BudgetLedger {
  /** `hoy()` devuelve el dia de negocio (YYYY-MM-DD): el contador se reinicia al cambiar de dia. */
  constructor(
    private kv: KVStorage,
    private hoy: () => string,
  ) {}

  async estado(): Promise<EstadoPresupuesto> {
    const got = await this.kv.get<EstadoPresupuesto>(["ledger"]);
    const e = got.get("ledger");
    const day = this.hoy();
    return e && e.day === day ? e : { day, usd: 0 };
  }

  async sumar(usd: number): Promise<EstadoPresupuesto> {
    if (!Number.isFinite(usd) || usd <= 0) return this.estado();
    const e = await this.estado();
    const nuevo = { day: e.day, usd: e.usd + usd };
    await this.kv.put({ ledger: nuevo });
    return nuevo;
  }

  async consultar(tope: number): Promise<{ permitido: boolean; usd: number; tope: number; day: string }> {
    const e = await this.estado();
    return { permitido: e.usd < tope, usd: e.usd, tope, day: e.day };
  }
}
