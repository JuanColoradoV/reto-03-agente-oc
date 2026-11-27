// Contadores de abuso/costo por clave (una instancia de GuardDO por IP y otra por sesion). Logica pura sobre KVStorage: se prueba con MemoryKV.
import { fechaNegocio } from "../domain/fecha";
import type { KVStorage } from "../session/storage";

export interface Bloqueo {
  bloqueado: boolean;
  /** ms epoch hasta cuando dura el bloqueo (0 si no hay). */
  hasta: number;
}

interface Estado {
  /** Marcas de tiempo (ms) de los strikes dentro de la ventana. */
  strikes: number[];
  hasta: number;
}

export class GuardLedger {
  constructor(
    private kv: KVStorage,
    private ahora: () => number = Date.now,
    private hoy: () => string = () => fechaNegocio(new Date()),
  ) {}

  private async leer<T>(k: string, def: T): Promise<T> {
    return ((await this.kv.get<T>([k])).get(k) as T | undefined) ?? def;
  }

  async bloqueo(): Promise<Bloqueo> {
    const e = await this.leer<Estado>("estado", { strikes: [], hasta: 0 });
    return { bloqueado: e.hasta > this.ahora(), hasta: e.hasta };
  }

  /** Registra un strike; al llegar a `max` dentro de `ventanaMs` bloquea `bloqueoMs`. */
  async strike(max: number, ventanaMs: number, bloqueoMs: number): Promise<Bloqueo> {
    const now = this.ahora();
    const e = await this.leer<Estado>("estado", { strikes: [], hasta: 0 });
    if (e.hasta > now) return { bloqueado: true, hasta: e.hasta };
    const strikes = [...e.strikes.filter((t) => now - t < ventanaMs), now];
    if (strikes.length >= max) {
      const hasta = now + bloqueoMs;
      await this.kv.put({ estado: { strikes: [], hasta } });
      return { bloqueado: true, hasta };
    }
    await this.kv.put({ estado: { strikes, hasta: 0 } });
    return { bloqueado: false, hasta: 0 };
  }

  /** Cuenta un mensaje que llegara al modelo en el dia de negocio. permitido=false si ya se alcanzo `max` (no se cuenta). */
  async consumirDia(max: number): Promise<{ permitido: boolean; usados: number }> {
    const day = this.hoy();
    const c = await this.leer<{ day: string; n: number }>("dia", { day, n: 0 });
    const n = c.day === day ? c.n : 0;
    if (n >= max) return { permitido: false, usados: n };
    await this.kv.put({ dia: { day, n: n + 1 } });
    return { permitido: true, usados: n + 1 };
  }

  /** Total (sin reinicio diario) de mensajes de una sesion. */
  async consumirSesion(max: number): Promise<{ permitido: boolean; usados: number }> {
    const n = await this.leer<number>("sesion", 0);
    if (n >= max) return { permitido: false, usados: n };
    await this.kv.put({ sesion: n + 1 });
    return { permitido: true, usados: n + 1 };
  }
}

/** Lo que el Worker usa del DO (RPC). Definido aqui para no depender de "cloudflare:workers" en Node. */
export interface GuardRpc {
  bloqueo(): Promise<Bloqueo>;
  strike(max: number, ventanaMs: number, bloqueoMs: number): Promise<Bloqueo>;
  consumirDia(max: number): Promise<{ permitido: boolean; usados: number }>;
  consumirSesion(max: number): Promise<{ permitido: boolean; usados: number }>;
}
export interface GuardNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): GuardRpc;
}
