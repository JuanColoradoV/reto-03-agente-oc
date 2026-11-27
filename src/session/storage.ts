// Almacenamiento del estado de sesion detras de una interfaz minima (la de DurableObjectStorage:
// get(keys[]) / put(obj) atomico / deleteAll). Asi la logica se prueba con MemoryKV sin Workers.
import { emptyCosto, emptyState, type SessionState } from "../agent/state";

export interface KVStorage {
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
  delete?(key: string): Promise<unknown>;
}

/** Implementacion en memoria (pruebas y demo). Clona para imitar la serializacion real. */
export class MemoryKV implements KVStorage {
  private m = new Map<string, unknown>();
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of keys) if (this.m.has(k)) out.set(k, structuredClone(this.m.get(k)) as T);
    return out;
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.m.set(k, structuredClone(v));
  }
  async deleteAll(): Promise<void> {
    this.m.clear();
  }
  async delete(key: string): Promise<boolean> {
    return this.m.delete(key);
  }
}

function costoDesdeTraza(trace: SessionState["trace"] | undefined): SessionState["costo"] {
  const c = emptyCosto();
  for (const t of trace ?? []) {
    c.turnos++;
    c.llamadasModelo += t.usage.calls;
    c.input += t.usage.input;
    c.output += t.usage.output;
    c.cacheRead += t.usage.cacheRead;
    c.cacheWrite += t.usage.cacheWrite;
    c.costoUsd += t.usage.costUsd;
  }
  return c;
}

const KEYS = ["messages", "pending", "sap", "audit", "events", "trace", "turns", "costo"] as const;

export class SessionStore {
  constructor(private kv: KVStorage) {}

  async load(): Promise<SessionState> {
    const got = await this.kv.get([...KEYS]);
    const base = emptyState();
    return {
      messages: (got.get("messages") as SessionState["messages"]) ?? base.messages,
      pending: (got.get("pending") as SessionState["pending"]) ?? null,
      sap: (got.get("sap") as SessionState["sap"]) ?? base.sap,
      audit: (got.get("audit") as SessionState["audit"]) ?? base.audit,
      events: (got.get("events") as SessionState["events"]) ?? base.events,
      trace: (got.get("trace") as SessionState["trace"]) ?? base.trace,
      turns: (got.get("turns") as number) ?? 0,
      // Sesiones guardadas antes de existir el acumulador: se parte de la traza disponible (mejor aproximacion).
      costo: (got.get("costo") as SessionState["costo"]) ?? costoDesdeTraza(got.get("trace") as SessionState["trace"] | undefined),
    };
  }

  /** Una sola llamada put => escritura atomica de todo el estado. */
  async save(s: SessionState): Promise<void> {
    await this.kv.put({
      messages: s.messages,
      pending: s.pending,
      sap: s.sap,
      audit: s.audit,
      events: s.events,
      trace: s.trace,
      turns: s.turns,
      costo: s.costo,
    });
  }

  /** Lease del turno en curso (epoch ms de expiracion). Clave aparte: save() no la toca. */
  async getLease(): Promise<number> {
    const got = await this.kv.get<number>(["lease"]);
    return got.get("lease") ?? 0;
  }
  async setLease(until: number): Promise<void> {
    await this.kv.put({ lease: until });
  }
  async clearLease(): Promise<void> {
    if (this.kv.delete) await this.kv.delete("lease");
    else await this.kv.put({ lease: 0 });
  }

  clear(): Promise<void> {
    return this.kv.deleteAll();
  }
}
