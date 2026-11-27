// Contexto de ejecución de las herramientas y resolución de sus dependencias (almacén out/, fixtures, SAP, reloj).
import { fixturesEmpaquetados, type FuenteFixtures } from "../domain/fixtures";
import type { OutStore } from "../out/store";
import type { SapAdapter } from "../sap/adapter";
import { SapMock } from "../sap/mock";
import { cargarMaestros } from "../domain/paquete";

/** Contrato del PRD: { directory, sessionId }. El resto es opcional: sin él las herramientas usan fs bajo `directory`. */
export interface ToolCtx {
  /** Raíz del proyecto: de aquí se resuelven fixtures/ y out/. */
  directory: string;
  sessionId: string;
  /** Almacén de out/. Por defecto: archivos reales en <directory>/out/ (Node). En el Worker lo inyecta la sesión. */
  store?: OutStore;
  /** Fuente de fixtures. Por defecto: <directory>/fixtures/reto-03/ en disco. */
  fixtures?: FuenteFixtures;
  /** Reloj inyectable (determinismo en demo y pruebas). */
  ahora?: () => Date;
  /**
   * Confirmación HUMANA vigente: la pone el servidor/demo, NUNCA el modelo. Solo habilita oc_crear para el caso indicado
   * (o cualquiera si `confirmadoCaso` no se define) cuando además el argumento `confirmado` es true.
   */
  confirmadoPor?: string;
  confirmadoCaso?: string;
}

export interface Servicios {
  store: OutStore;
  fixtures: FuenteFixtures;
  ahora: () => Date;
}

// El módulo con fs se importa de forma dinámica y solo si hace falta: el Worker siempre inyecta `store` y `fixtures`.
const RUTA_NODE = "../out/node";

export async function servicios(ctx: ToolCtx): Promise<Servicios> {
  let store = ctx.store;
  let fixtures = ctx.fixtures;
  if (!store || !fixtures) {
    const nodo = (await import(/* @vite-ignore */ RUTA_NODE)) as typeof import("../out/node");
    store ??= new nodo.NodeOutStore(ctx.directory);
    fixtures ??= new nodo.NodeFixtures(ctx.directory);
  }
  return { store, fixtures: fixtures ?? fixturesEmpaquetados, ahora: ctx.ahora ?? (() => new Date()) };
}

export async function crearSap(sv: Servicios): Promise<SapAdapter | { error: string }> {
  const m = await cargarMaestros(sv.fixtures);
  if (!m.ok) return { error: m.error };
  return new SapMock(sv.store, m.data.proveedores, () => sv.ahora().toISOString());
}
