// Fuente de fixtures (solo lectura): rutas relativas a fixtures/reto-03/. En Workers se sirve desde el bundle generado;
// en Node (demo, pruebas) se lee del disco desde ctx.directory (src/out/node.ts).
import { FILES } from "../data/fixtures.generated";

export interface FuenteFixtures {
  leer(rel: string): Promise<string | null>;
  listarCasos(): Promise<string[]>;
}

const BASE = "fixtures/reto-03/";

export const fixturesEmpaquetados: FuenteFixtures = {
  async leer(rel) {
    return FILES[BASE + rel] ?? null;
  },
  async listarCasos() {
    const ids = new Set<string>();
    for (const k of Object.keys(FILES)) {
      const m = k.startsWith(BASE) ? k.slice(BASE.length).match(/^solicitudes\/([^/]+)\//) : null;
      if (m?.[1]) ids.add(m[1]);
    }
    return [...ids].sort();
  },
};

export const CASO_RE = /^[a-z0-9][a-z0-9-]{0,40}$/i;
