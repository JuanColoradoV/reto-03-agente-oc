// Lee fixtures/ (recursivo) y agent/prompt.md y genera src/data/fixtures.generated.ts
// (mapa ruta-relativa-a-la-raiz -> contenido). Asi Workers no necesita fs en runtime.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const files: Record<string, string> = {};

function walk(dir: string): void {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
}

// Recursivo: incluye maestros/*.json (proveedores y, si existen, centros-costo, indicadores-iva, condiciones-pago) y todas las solicitudes.
walk(join(root, "fixtures"));
files["agent/prompt.md"] = readFileSync(join(root, "agent", "prompt.md"), "utf8");

const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const out =
  "// ARCHIVO GENERADO por scripts/bundle-fixtures.ts - no editar a mano.\n" +
  `export const FILES: Record<string, string> = ${JSON.stringify(sorted, null, 2)};\n`;
const target = join(root, "src", "data", "fixtures.generated.ts");
// Solo se escribe si cambio: `wrangler dev` vigila src/ y reejecuta el bundle (build personalizado); reescribir el mismo
// contenido dispararia un bucle infinito de recargas que mata los turnos en curso.
const changed = !existsSync(target) || readFileSync(target, "utf8") !== out;
if (changed) writeFileSync(target, out);
console.log(`bundle-fixtures: ${Object.keys(sorted).length} archivos -> src/data/fixtures.generated.ts${changed ? "" : " (sin cambios)"}`);
