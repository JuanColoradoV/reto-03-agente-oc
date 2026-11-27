// Evaluacion del agente con el MODELO REAL. Uso: ANTHROPIC_API_KEY=sk-ant-... npm run eval
// Corre los escenarios de scripts/eval-scenarios.ts contra el mismo codigo del agente (Session + bucle + tools) en proceso, con SAP
// en memoria (sin wrangler) y aprobando/rechazando por la API de la sesion desde el codigo. Escribe docs/eval-results.md y la tabla en
// stdout; sale con codigo distinto de 0 si algun escenario falla. Consume API (costo estimado en la tabla): no corre en `npm run check`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { UiEvent } from "../src/agent/events";
import type { LlmClient } from "../src/agent/loop";
import { FILES } from "../src/data/fixtures.generated";
import { getPrompt } from "../src/data/repo";
import { fechaNegocio } from "../src/domain/fecha";
import { MODEL_AGENT, claveUsable, getClient } from "../src/llm/client";
import { Session, type SessionEnv } from "../src/session/session";
import { MemoryKV, SessionStore } from "../src/session/storage";
import { ocTools } from "../src/tools/oc";
import { ESCENARIOS, type Escenario, type Observado } from "./eval-scenarios";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "fixtures/reto-03/solicitudes/";

/** Devuelve el motivo por el que NO se puede correr (o null). La evaluacion exige el modelo real: nunca corre en modo simulado ni sin clave. */
export function motivoDeRechazo(env: Record<string, string | undefined>): string | null {
  if (env.MOCK_LLM === "1") return "MOCK_LLM=1 está definido: la evaluación mide el modelo real, no el guion simulado. Quítalo del entorno.";
  if (!claveUsable(env.ANTHROPIC_API_KEY)) return "Falta ANTHROPIC_API_KEY en el entorno (una clave real, no el placeholder). Uso: ANTHROPIC_API_KEY=sk-ant-... npm run eval";
  return null;
}

export interface Fila {
  escenario: Escenario;
  obs: Observado;
  problemas: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costoUsd: number;
  ms: number;
  status: string;
  error?: string;
}

/** Aplica reemplazos temporales de fixtures y los restaura siempre. */
async function conFixtures<T>(cambios: NonNullable<Escenario["fixtures"]>, fn: () => Promise<T>): Promise<T> {
  const previo = new Map<string, string | undefined>();
  for (const [k, f] of Object.entries(cambios)) {
    previo.set(DIR + k, FILES[DIR + k]);
    FILES[DIR + k] = f(FILES[DIR + k] ?? "");
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previo) if (v === undefined) delete FILES[k];
    else FILES[k] = v;
  }
}

export async function correrEscenario(esc: Escenario, client: LlmClient): Promise<Fila> {
  const eventos: UiEvent[] = [];
  const env: SessionEnv = {
    makeClient: () => client,
    systemPrompt: getPrompt(),
    tools: ocTools,
    fecha: () => fechaNegocio(new Date()),
    now: () => new Date().toISOString(),
    log: () => {},
  };
  const store = new SessionStore(new MemoryKV());
  const session = new Session(`eval-${esc.id}`, store, env);
  const on = (e: UiEvent) => void eventos.push(e);
  const problemas: string[] = [];
  const decisiones: ("aprobar" | "rechazar")[] = [];
  let status = "done";
  let error: string | undefined;
  const t0 = Date.now();

  const correr = async () => {
    for (const paso of esc.pasos) {
      if (paso.tipo === "mensaje") {
        status = (await session.chat(paso.texto, on)).status;
      } else {
        const tarjeta = [...eventos].reverse().find((e) => e.type === "pending_confirmation");
        if (!tarjeta || tarjeta.type !== "pending_confirmation") {
          problemas.push(`el paso "${paso.decision}" requería una tarjeta de aprobación y no hubo ninguna`);
          return;
        }
        decisiones.push(paso.decision);
        status = (await session.confirm(tarjeta.pending.pendingId, paso.decision, paso.comentario, on)).status;
      }
      if (status === "error") {
        problemas.push("el turno terminó en error");
        return;
      }
    }
  };
  try {
    await (esc.fixtures ? conFixtures(esc.fixtures, correr) : correr());
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    problemas.push(`excepción: ${error}`);
  }
  const ms = Date.now() - t0;

  const estado = await store.load();
  const obs: Observado = {
    eventos,
    herramientas: eventos.flatMap((e) => (e.type === "tool_call" ? [e.name] : [])),
    ocs: estado.sap.ordenes.map((o) => ({ numero: o.numero, solicitudId: o.solicitudId })),
    tarjetas: eventos.filter((e) => e.type === "pending_confirmation").length,
    decisiones,
    texto: eventos.flatMap((e) => (e.type === "assistant_text" ? [e.text] : [])).join("\n"),
  };
  if (!error) problemas.push(...esc.verificar(obs));
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costoUsd = 0;
  for (const e of eventos) {
    if (e.type !== "usage") continue;
    tokens.input += e.usage.input;
    tokens.output += e.usage.output;
    tokens.cacheRead += e.usage.cacheRead;
    tokens.cacheWrite += e.usage.cacheWrite;
    costoUsd += e.usage.costUsd;
  }
  return { escenario: esc, obs, problemas, tokens, costoUsd, ms, status, ...(error ? { error } : {}) };
}

const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const resumenObtenido = (o: Observado) =>
  `tarjetas: ${o.tarjetas}; decisión: ${o.decisiones.join(", ") || "-"}; OC: ${o.ocs.length ? o.ocs.map((x) => `${x.numero} (${x.solicitudId})`).join(", ") : "ninguna"}`;

export function tablaMarkdown(filas: Fila[], meta: { modelo: string; fecha: string }): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = filas.map((f) => {
    const herr = f.obs.herramientas.length ? f.obs.herramientas.join(" → ") : "(ninguna)";
    const tok = `${k(f.tokens.input + f.tokens.cacheRead + f.tokens.cacheWrite)} / ${k(f.tokens.output)}`;
    return `| ${cell(f.escenario.nombre)} | ${cell(f.escenario.esperado)} | ${cell(resumenObtenido(f.obs))} | ${cell(herr)} | ${tok} | ${f.costoUsd.toFixed(4)} | ${(f.ms / 1000).toFixed(1)} s | ${f.problemas.length ? "FALLA" : "OK"} |`;
  });
  const fallos = filas.filter((f) => f.problemas.length);
  const total = filas.reduce((s, f) => s + f.costoUsd, 0);
  return [
    "# Evaluación con el modelo real",
    "",
    `Modelo \`${meta.modelo}\` · ${meta.fecha} · SAP simulado en memoria · generado por \`npm run eval\` (scripts/eval.ts). Costo estimado con la tabla de \`src/agent/cost.ts\`; tokens de entrada incluyen caché. Cada ejecución es una muestra del modelo: no determinista.`,
    "",
    "| Escenario | Esperado | Obtenido | Herramientas | Tokens ent. / sal. | Costo (USD) | Latencia | Resultado |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `**${filas.length - fallos.length} de ${filas.length} escenarios OK** · costo total estimado US$ ${total.toFixed(4)}.`,
    ...fallos.flatMap((f) => ["", `Fallo en **${f.escenario.nombre}**:`, ...f.problemas.map((p) => `- ${p}`)]),
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  const motivo = motivoDeRechazo(process.env);
  if (motivo) {
    console.error(`eval: ${motivo}`);
    return 2;
  }
  const client = getClient(process.env.ANTHROPIC_API_KEY);
  const filas: Fila[] = [];
  for (const esc of ESCENARIOS) {
    process.stderr.write(`eval: ${esc.id}... `);
    const f = await correrEscenario(esc, client);
    process.stderr.write(f.problemas.length ? "FALLA\n" : "OK\n");
    filas.push(f);
  }
  const md = tablaMarkdown(filas, { modelo: MODEL_AGENT, fecha: new Date().toISOString().slice(0, 10) });
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "eval-results.md"), md);
  console.log(md);
  return filas.some((f) => f.problemas.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("eval: error inesperado:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
