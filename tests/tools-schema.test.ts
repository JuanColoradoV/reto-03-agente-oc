// Forma de los input_schema de las herramientas que se envian a Anthropic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ocTools } from "../src/tools/oc";
import { toAnthropicTools } from "../src/tools/registry";

const walk = (n: unknown, f: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(n)) n.forEach((x) => walk(x, f));
  else if (n && typeof n === "object") {
    f(n as Record<string, unknown>);
    Object.values(n).forEach((x) => walk(x, f));
  }
};

test("tool input_schema de todas las herramientas: raiz object, sin $schema y objetos cerrados", () => {
  const defs = toAnthropicTools(ocTools);
  assert.equal(defs.length, ocTools.length);
  for (const d of defs) {
    assert.equal(d.input_schema.type, "object", d.name);
    assert.equal("$schema" in d.input_schema, false, d.name);
    walk(d.input_schema, (o) => {
      if (o.type === "object") assert.equal(o.additionalProperties, false, `${d.name}: additionalProperties`);
    });
  }
});
