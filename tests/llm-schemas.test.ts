// Forma de los esquemas JSON que se envian a Anthropic (structured outputs y tool input_schema) y manejo de respuestas de extract.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { estimateCostUsd } from "../src/agent/cost";
import { cotizacionLlmSchema, extractStructured, schemaEstructurado } from "../src/llm/extract";
import { ocTools } from "../src/tools/oc";
import { toAnthropicTools } from "../src/tools/registry";
import { fakeMessage, text } from "./helpers";

const walk = (n: unknown, f: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(n)) n.forEach((x) => walk(x, f));
  else if (n && typeof n === "object") {
    f(n as Record<string, unknown>);
    Object.values(n).forEach((x) => walk(x, f));
  }
};

test("structured outputs: el esquema de cotizacion no lleva $schema, minimum/maximum ni objetos abiertos", () => {
  const s = schemaEstructurado(cotizacionLlmSchema);
  assert.equal(s.type, "object");
  assert.equal("$schema" in s, false);
  walk(s, (o) => {
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "$schema"]) assert.equal(k in o, false, `clave no soportada: ${k}`);
    if (o.type === "object") assert.equal(o.additionalProperties, false, "todo objeto cierra additionalProperties");
  });
  // El limite no se pierde: pasa a la descripcion y se vuelve a validar con zod al recibir la respuesta.
  const confianza = (s.properties as Record<string, { description?: string }>).confianza!;
  assert.match(confianza.description ?? "", /minimum|maximum/);
  assert.deepEqual([...(s.required as string[])].sort(), ["confianza", "items", "moneda", "numero", "proveedor", "total"]);
});

test("la raiz debe ser un objeto", () => {
  assert.throws(() => schemaEstructurado(z.array(z.string())), /objeto en la raíz/);
});

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

const clienteQue = (resp: ReturnType<typeof fakeMessage>) => {
  const calls: unknown[] = [];
  return { calls, client: { messages: { create: async (p: unknown, o: unknown) => (calls.push({ p, o }), resp) } } as never };
};
const valido = { numero: "1", proveedor: null, moneda: "COP", items: [], total: 10, confianza: 0.9 };

test("extractStructured: envia el esquema normalizado con timeout, devuelve el JSON validado y reporta uso", async () => {
  const { client, calls } = clienteQue(fakeMessage([text(JSON.stringify(valido))], "end_turn"));
  let uso: unknown;
  const r = await extractStructured(client, cotizacionLlmSchema, "texto", "Extrae.", { onUsage: (u) => (uso = u) });
  assert.equal(r.total, 10);
  const { p, o } = calls[0] as { p: { output_config: { format: { type: string; schema: Record<string, unknown> } }; model: string }; o: { signal: AbortSignal } };
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal("$schema" in p.output_config.format.schema, false);
  assert.ok(o.signal instanceof AbortSignal);
  assert.deepEqual(uso, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
});

test("extractStructured: max_tokens, refusal, JSON invalido y confianza fuera de rango dan errores claros", async () => {
  const mk = (content: string, stop: "end_turn" | "max_tokens" | "refusal") => clienteQue(fakeMessage([text(content)], stop)).client;
  await assert.rejects(() => extractStructured(mk('{"a":', "max_tokens"), cotizacionLlmSchema, "t", "i"), /límite de tokens/);
  await assert.rejects(() => extractStructured(mk("", "refusal"), cotizacionLlmSchema, "t", "i"), /declinó/);
  await assert.rejects(() => extractStructured(mk("no es json", "end_turn"), cotizacionLlmSchema, "t", "i"), /JSON válido/);
  await assert.rejects(() => extractStructured(mk(JSON.stringify({ ...valido, confianza: 7 }), "end_turn"), cotizacionLlmSchema, "t", "i"), /too_big|<=1|Too big/i);
});

test("costo: Haiku 5.5 (extraccion) tiene tarifa propia; un modelo desconocido no suma costo inventado", () => {
  assert.ok(estimateCostUsd("claude-haiku-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }) > 0);
  assert.equal(estimateCostUsd("modelo-x", { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }), 0);
});
