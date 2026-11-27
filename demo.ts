// demo.ts - procesa los 6 casos llamando DIRECTAMENTE a las herramientas (sin modelo, sin red, sin clave).
// Determinista: reloj fijo, out/ limpio al inicio. Compara contra fixtures/reto-03/esperados.json y sale con código 1 si algo falla.
// Uso: npm run demo   |   npx tsx demo.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeOutStore } from "./src/out/node";
import { ejecutarHerramienta } from "./src/tools/registry";
import type { ToolCtx } from "./src/tools/contexto";

export const CASOS_REQUERIDOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

const directory = dirname(fileURLToPath(import.meta.url));
const RELOJ_FIJO = new Date("2026-09-01T15:00:00.000Z");
const ctxBase: ToolCtx = { directory, sessionId: "demo", ahora: () => RELOJ_FIJO };
// Confirmación humana simulada: la pone el "analista" en el chat; el modelo nunca puede fijarla.
const ctxConfirmado = (caso: string): ToolCtx => ({ ...ctxBase, confirmadoPor: "analista (demo)", confirmadoCaso: caso });

interface Esperado {
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  retroactiva: boolean;
  numero_oc: string | null;
  derivados?: Record<string, string>;
}
type Salida = { ok: boolean; error?: string; data?: Record<string, unknown>; pendiente?: boolean; bloqueos?: { codigo: string }[] };

const llamar = async (nombre: string, args: unknown, ctx: ToolCtx): Promise<Salida> => JSON.parse(await ejecutarHerramienta(nombre, args, ctx)) as Salida;
const codigos = (xs: { codigo: string }[]) => xs.map((x) => x.codigo);
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<number> {
  const esperados = (JSON.parse(readFileSync(join(directory, "fixtures/reto-03/esperados.json"), "utf8")) as { casos: Record<string, Esperado> }).casos;
  await new NodeOutStore(directory).limpiar();
  const fallos: string[] = [];
  const verifica = (caso: string, campo: string, real: unknown, esperado: unknown) => {
    if (!igual(real, esperado)) fallos.push(`${caso}: ${campo} = ${JSON.stringify(real)} (esperado ${JSON.stringify(esperado)})`);
  };
  const out: string[] = ["=== demo reto-03: 6 casos, herramientas directas (sin modelo) ==="];

  for (const caso of CASOS_REQUERIDOS) {
    const esp = esperados[caso];
    out.push("", `--- ${caso} ---`);
    const v = await llamar("oc_validar", { caso }, ctxBase);
    if (!v.ok || !v.data) {
      fallos.push(`${caso}: oc_validar falló: ${v.error}`);
      continue;
    }
    const d = v.data as { apta: boolean; bloqueos: { codigo: string; detalle: string }[]; confirmaciones: { codigo: string; detalle: string }[]; derivados: Record<string, string>; retroactiva: boolean };
    out.push(`apta: ${d.apta} | retroactiva: ${d.retroactiva}`);
    out.push(`bloqueos: ${d.bloqueos.length ? d.bloqueos.map((b) => `${b.codigo} (${b.detalle})`).join(" / ") : "ninguno"}`);
    out.push(`confirmaciones: ${d.confirmaciones.length ? d.confirmaciones.map((c) => `${c.codigo} (${c.detalle})`).join(" / ") : "ninguna"}`);
    if (Object.keys(d.derivados).length) out.push(`derivados: ${JSON.stringify(d.derivados)}`);
    if (esp) {
      verifica(caso, "apta", d.apta, esp.apta);
      verifica(caso, "bloqueos", codigos(d.bloqueos), esp.bloqueos);
      verifica(caso, "confirmaciones", codigos(d.confirmaciones), esp.confirmaciones);
      verifica(caso, "retroactiva", d.retroactiva, esp.retroactiva);
      if (esp.derivados) verifica(caso, "derivados", d.derivados, esp.derivados);
    }

    let numero: string | null = null;
    if (d.apta) {
      const p = await llamar("oc_construir_payload", { caso }, ctxBase);
      out.push(p.ok ? `payload construido; trazabilidad en ${String(p.data?.trazabilidad)}` : `payload NO construido: ${p.error}`);
      await llamar("oc_generar_evidencia", { caso }, ctxBase);
    }

    // Primer intento SIN confirmación humana: crea solo si no hay confirmaciones; si no, queda pendiente o bloqueada.
    const intento = await llamar("oc_crear", { caso }, ctxBase);
    if (intento.ok) numero = String(intento.data?.numero_oc);
    if (intento.ok) out.push(`oc_crear (sin intervención humana): OC ${numero} creada`);
    else if (intento.pendiente) out.push("oc_crear: PENDIENTE de confirmación humana (no se creó nada)");
    else out.push(`oc_crear: NO creada. Motivo: ${intento.error}`);

    if (intento.pendiente) {
      // El modelo no puede auto-confirmar: confirmado=true sin confirmación humana registrada por el servidor no sirve.
      const autoconfirma = await llamar("oc_crear", { caso, confirmado: true }, ctxBase);
      out.push(`  intento de auto-confirmación del modelo: ${autoconfirma.ok ? "ERROR: creó" : "rechazado (pendiente)"}`);
      if (autoconfirma.ok) fallos.push(`${caso}: oc_crear aceptó confirmado=true sin confirmación humana`);
      out.push(`  >>> CONFIRMACIÓN EXPLÍCITA del analista para ${caso}: «${d.confirmaciones.map((c) => c.codigo).join(", ")} confirmado»`);
      const r = await llamar("oc_crear", { caso, confirmado: true }, ctxConfirmado(caso));
      if (r.ok) numero = String(r.data?.numero_oc);
      out.push(r.ok ? `  oc_crear (confirmado): OC ${numero} creada | evidencia ${String(r.data?.evidencia)}` : `  oc_crear (confirmado) falló: ${r.error}`);
    }
    if (esp) verifica(caso, "numero_oc", numero, esp.numero_oc);
    out.push(`RESULTADO ${caso}: ${numero ? `OC ${numero}` : `sin OC (${d.bloqueos.map((b) => b.codigo).join(", ") || "pendiente"})`}`);

    if (caso === "sol-001") {
      const otra = await llamar("oc_crear", { caso }, ctxBase);
      const mismo = otra.ok && otra.data?.idempotente === true && otra.data?.numero_oc === numero;
      out.push(`sol-001 por segunda vez: ${otra.ok ? `OC ${String(otra.data?.numero_oc)} (idempotente: ${String(otra.data?.idempotente)})` : otra.error}`);
      if (!mismo) fallos.push("sol-001: la segunda creación no fue idempotente");
    }
  }

  const store = new NodeOutStore(directory);
  const ordenes = ((await store.leer("sap/ordenes.jsonl")) ?? "").split("\n").filter(Boolean).length;
  verifica("sap", "órdenes creadas", ordenes, 4);
  const filas = ((await store.leer("control.csv")) ?? "").trim().split("\n");
  const fila005 = filas.find((f) => f.startsWith("SOL-2026-005,creada"));
  if (!fila005 || fila005.split(",")[3] !== "true") fallos.push("control.csv: sol-005 debe quedar creada con retroactiva=true");
  out.push("", "--- out/ ---", ...(await store.listar()).map((f) => `${f.ruta} (${f.bytes} bytes)`), "", `control.csv (${filas.length - 1} intentos):`, ...filas.map((f) => `  ${f}`));
  out.push("", fallos.length ? `FALLOS (${fallos.length}):\n${fallos.map((f) => `  - ${f}`).join("\n")}` : "OK: los 6 casos coinciden con fixtures/reto-03/esperados.json");
  console.log(out.join("\n"));
  return fallos.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => {
  console.error("ERROR inesperado:", e instanceof Error ? e.message : e);
  process.exit(1);
});
