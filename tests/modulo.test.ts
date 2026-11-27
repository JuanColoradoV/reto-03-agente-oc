// El bonus modulo/ debe ser el MISMO agente que usa la aplicacion, no una copia divergente (PRD §9.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentMd, skillMd } from "../scripts/build-modulo";
import * as appTools from "../src/tools/oc";
import * as moduloTools from "../modulo/tools/oc";

const ROOT = join(import.meta.dirname, "..");
const leer = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("modulo/agent.md = frontmatter + agent/prompt.md (sin divergencias)", () => {
  const md = leer("modulo/agent.md");
  assert.equal(md, agentMd(leer("agent/prompt.md")), "Regenera con: npm run modulo");
  assert.match(md, /^---\ndescription: .+\nmode: primary\npermission:\n  edit: deny\n  bash: deny\n---\n/);
});

test("modulo/skill/ordenes-compra/SKILL.md = frontmatter + src/knowledge/ordenes-compra.md", () => {
  const md = leer("modulo/skill/ordenes-compra/SKILL.md");
  assert.equal(md, skillMd(leer("src/knowledge/ordenes-compra.md")), "Regenera con: npm run modulo");
  assert.match(md, /^---\nname: ordenes-compra\ndescription: .+\n---\n/);
});

test("modulo/tools/oc.ts expone exactamente las mismas herramientas (mismos objetos) que la aplicacion", () => {
  const nombresApp = Object.keys(appTools).sort();
  assert.deepEqual(Object.keys(moduloTools).sort(), nombresApp);
  for (const k of nombresApp) assert.equal((moduloTools as Record<string, unknown>)[k], (appTools as Record<string, unknown>)[k]);
  for (const k of ["leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear"]) {
    const t = (moduloTools as Record<string, { description?: unknown; args?: unknown; execute?: unknown }>)[k];
    assert.ok(t, `falta la herramienta ${k}`);
    assert.equal(typeof t.description, "string");
    assert.equal(typeof t.execute, "function");
    assert.ok(t.args && typeof t.args === "object");
  }
});
