// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md desde las MISMAS fuentes que usa la aplicacion:
//   agent/prompt.md                  -> cuerpo de modulo/agent.md
//   src/knowledge/ordenes-compra.md  -> cuerpo de modulo/skill/ordenes-compra/SKILL.md
// modulo/tools/oc.ts re-exporta src/tools/oc.ts (no es una copia). tests/modulo.test.ts falla si algo diverge.
// Uso: npm run modulo   (tambien corre dentro de npm run bundle)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

export function agentMd(prompt: string): string {
  return [
    "---",
    "description: Agente de órdenes de compra SAP. Lee el paquete de una solicitud, la valida contra maestros (RC1–RC10), construye el payload, genera la evidencia de aprobación y crea la OC; pide confirmación humana ante excepciones.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    prompt.trim(),
    "",
  ].join("\n");
}

export function skillMd(conocimiento: string): string {
  return [
    "---",
    "name: ordenes-compra",
    "description: Conocimiento del proceso de órdenes de compra de Periferia — reglas de control RC1–RC10, glosario de campos SAP y qué hacer ante cada excepción. Úsalo al procesar o explicar una solicitud de compra.",
    "---",
    "",
    conocimiento.trim(),
    "",
  ].join("\n");
}

function escribir(rel: string, contenido: string): void {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p) && readFileSync(p, "utf8") === contenido) return; // no tocar si no cambio (evita recargas en dev)
  writeFileSync(p, contenido);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const prompt = readFileSync(join(ROOT, "agent/prompt.md"), "utf8");
  const conocimiento = readFileSync(join(ROOT, "src/knowledge/ordenes-compra.md"), "utf8");
  escribir("modulo/agent.md", agentMd(prompt));
  escribir("modulo/skill/ordenes-compra/SKILL.md", skillMd(conocimiento));
  console.log("modulo/ actualizado desde agent/prompt.md y src/knowledge/ordenes-compra.md");
}
