import type { OutStore } from "../src/out/store";
import { KvOutStore } from "../src/out/do";
import { fixturesEmpaquetados } from "../src/domain/fixtures";
import { MemoryKV } from "../src/session/storage";
import type { ToolCtx } from "../src/tools/contexto";
import { ejecutarHerramienta } from "../src/tools/registry";

export const RELOJ = new Date("2026-09-01T15:00:00.000Z");

/** Contexto de herramientas en memoria (sin disco): store sobre MemoryKV y fixtures empaquetados. */
export function ctxMemoria(extra: Partial<ToolCtx> = {}): ToolCtx & { store: OutStore } {
  const store = new KvOutStore(new MemoryKV());
  return { directory: "/", sessionId: "test", store, fixtures: fixturesEmpaquetados, ahora: () => RELOJ, ...extra };
}

export interface Salida {
  ok: boolean;
  error?: string;
  data?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  pendiente?: boolean;
  bloqueos?: { codigo: string }[];
  confirmaciones?: { codigo: string }[];
}

export async function llamar(nombre: string, args: unknown, ctx: ToolCtx): Promise<Salida> {
  return JSON.parse(await ejecutarHerramienta(nombre, args, ctx)) as Salida;
}
