// Acceso a datos sin fs: funciona igual en Node y en Workers.
import { FILES } from "./fixtures.generated";

const BASE = "fixtures/reto-03/";

export function hasFile(rel: string): boolean {
  return (BASE + rel) in FILES;
}

export function getText(rel: string): string {
  const v = FILES[BASE + rel];
  if (v === undefined) throw new Error(`Archivo no encontrado en fixtures: ${rel}`);
  return v;
}

export function getJson<T = unknown>(rel: string): T {
  return JSON.parse(getText(rel)) as T;
}

/** IDs de casos (sol-001...) ordenados. */
export function listCases(): string[] {
  const ids = new Set<string>();
  for (const k of Object.keys(FILES)) {
    const m = k.startsWith(BASE) ? k.slice(BASE.length).match(/^solicitudes\/([^/]+)\//) : null;
    if (m?.[1]) ids.add(m[1]);
  }
  return [...ids].sort();
}

export function getPrompt(): string {
  const p = FILES["agent/prompt.md"];
  if (!p) throw new Error("agent/prompt.md no esta en el bundle");
  return p;
}
