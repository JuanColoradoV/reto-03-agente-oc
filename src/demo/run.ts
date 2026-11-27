// Corre TODOS los casos por las tools (sin LLM, sin red, determinista) y compara con
// fixtures/reto-03/esperados.json. Lo usan demo.ts (CLI) y tests/.
import { getJson } from "../data/repo";
import { cargarCaso, cargarMaestros, listCases } from "../domain/casos";
import { CONTROLES, V0_DATOS, matrizMarkdown } from "../domain/controles";
import { fmt } from "../domain/dinero";
import { FECHA_REFERENCIA } from "../domain/constants";
import type { ResumenControles, Veredicto } from "../domain/types";
import { InMemorySap } from "../sap";
import { ocTools, crearOrdenCompra } from "../tools/oc";
import { executeTool, preflightTool, type ToolContext } from "../tools/registry";

export interface Esperado {
  bloqueante: boolean;
  oc: boolean;
  total: number | null;
  controles: Record<string, Veredicto>;
}
export interface Esperados {
  casos: Record<string, Esperado>;
}

/**
 * Casos que DEBEN existir (fixtures y esperados). null = no se exige un conjunto fijo (placeholders sol-000 / sol-00X).
 * Cuando llegue el PRD: cambiar a ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"] y la demo fallara si falta alguno.
 */
export const CASOS_REQUERIDOS: readonly string[] | null = null;
// export const CASOS_REQUERIDOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"] as const;

export const cargarEsperados = (): Esperados => getJson<Esperados>("esperados.json");

export interface DemoResult {
  lines: string[];
  fallos: number;
}

const pad = (s: string, n: number) => s.padEnd(n);

export async function ejecutarDemo(esperados: Esperados = cargarEsperados(), requeridos: readonly string[] | null = CASOS_REQUERIDOS): Promise<DemoResult> {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  const ctx: ToolContext = { sap: new InMemorySap(), fecha: FECHA_REFERENCIA };
  const maestros = cargarMaestros();
  let fallos = 0;
  const filas: { caso: string; obtenido: string; oc: string; veredicto: string }[] = [];

  line(`DEMO determinista - fecha de referencia ${FECHA_REFERENCIA} - sin LLM`);
  line();
  line("Matriz de controles (derivada del registro en src/domain/controles):");
  for (const c of [...CONTROLES, V0_DATOS]) line(`  ${c.id} [${c.severidad}] ${c.nombre} <- ${c.fuente}`);

  const ids = listCases();
  if (ids.length === 0) throw new Error("No hay casos en fixtures/reto-03/solicitudes");
  // Cobertura en ambas direcciones: cada esperado debe tener fixture y cada fixture debe tener esperado.
  const esperadosIds = Object.keys(esperados.casos);
  for (const id of esperadosIds) {
    if (!ids.includes(id)) {
      fallos++;
      line(`FALLA: el caso esperado ${id} no tiene fixture en fixtures/reto-03/solicitudes/.`);
    }
  }
  for (const id of ids) {
    if (!esperadosIds.includes(id)) {
      fallos++;
      line(`FALLA: el fixture ${id} no tiene resultado esperado en esperados.json.`);
    }
  }
  for (const id of requeridos ?? []) {
    if (!ids.includes(id) || !esperadosIds.includes(id)) {
      fallos++;
      line(`FALLA: el caso requerido ${id} falta (fixture: ${ids.includes(id) ? "si" : "NO"}, esperado: ${esperadosIds.includes(id) ? "si" : "NO"}).`);
    }
  }

  for (const id of ids) {
    line();
    line(`=== ${id} ${"=".repeat(60 - id.length)}`);
    const leer = await executeTool(ocTools, "leer_solicitud", { id }, ctx);
    if (!leer.ok) throw new Error(leer.error);
    const caso = cargarCaso(id);
    line(`Asunto: ${caso.correo.asunto ?? "(sin asunto)"}`);
    const val = await executeTool(ocTools, "validar_controles", { id }, ctx);
    if (!val.ok) throw new Error(val.error);
    const res = val.output as ResumenControles;
    line(`${pad("Control", 28)}${pad("Resultado", 11)}Detalle`);
    for (const c of res.controles) line(`${pad(`${c.id} ${c.nombre}`, 28)}${pad(c.resultado, 11)}${c.detalle}`);

    // Mismo camino que el agente: preflight determinista y, si pasa, ejecucion con confirmacion.
    let oc: string | null = null;
    let total: number | null = null;
    const pf = await preflightTool(crearOrdenCompra, { solicitudId: id }, ctx);
    const bloqueante = !pf.ok;
    if (pf.ok) {
      // autoConfirm: SOLO en la demo se omite la aprobacion humana; queda registrado.
      line("[autoConfirm=true] omitiendo confirmación humana (solo demo.ts)");
      const r = await executeTool(ocTools, "crear_orden_compra", { solicitudId: id }, ctx, { confirmation: "autoConfirm", preflight: pf.data });
      if (!r.ok) throw new Error(r.error);
      const o = r.output as { numero: string; total: number; moneda: string };
      oc = o.numero;
      total = o.total;
      line(`-> OC ${o.numero} creada, total ${fmt(o.total, o.moneda)}`);
    } else {
      line(`-> No se crea OC: ${pf.error}`);
    }

    const obtenido = { bloqueante, oc: oc !== null, total, controles: Object.fromEntries(res.controles.map((c) => [c.id, c.resultado])) };
    const esp = esperados.casos[id];
    const diffs: string[] = [];
    if (!esp) diffs.push("sin resultado esperado en esperados.json");
    else {
      if (esp.bloqueante !== obtenido.bloqueante) diffs.push(`bloqueante: esperado ${esp.bloqueante}, obtenido ${obtenido.bloqueante}`);
      if (esp.oc !== obtenido.oc) diffs.push(`oc creada: esperado ${esp.oc}, obtenido ${obtenido.oc}`);
      if (esp.total !== obtenido.total) diffs.push(`total: esperado ${esp.total}, obtenido ${obtenido.total}`);
      // Los controles contextuales (p. ej. C0, estado de SAP) no figuran en la matriz esperada del PRD.
      const contextuales = new Set(CONTROLES.filter((c) => c.contextual).map((c) => c.id));
      for (const k of new Set([...Object.keys(esp.controles), ...Object.keys(obtenido.controles)])) {
        if (contextuales.has(k)) continue;
        if (esp.controles[k] !== obtenido.controles[k]) diffs.push(`control ${k}: esperado ${esp.controles[k] ?? "-"}, obtenido ${obtenido.controles[k] ?? "-"}`);
      }
    }
    if (diffs.length) fallos++;
    line(diffs.length ? `FAIL ${id}: ${diffs.join("; ")}` : `PASS ${id}`);
    filas.push({
      caso: id,
      obtenido: `${res.controles.length - res.fallas - res.alertas} OK / ${res.alertas} ALERTA / ${res.fallas} FALLA`,
      oc: oc ?? "-",
      veredicto: diffs.length ? "FAIL" : "PASS",
    });
  }

  line();
  line("=== RESUMEN FINAL " + "=".repeat(45));
  line(`${pad("Caso", 10)}${pad("Controles", 30)}${pad("OC", 14)}Resultado`);
  for (const f of filas) line(`${pad(f.caso, 10)}${pad(f.obtenido, 30)}${pad(f.oc, 14)}${f.veredicto}`);
  const creadas = filas.filter((f) => f.oc !== "-").length;
  const sapCount = (await ctx.sap.listarOrdenes()).length;
  if (sapCount !== creadas) {
    fallos++;
    line(`FAIL: SAP tiene ${sapCount} OC y se esperaban ${creadas}`);
  }
  line();
  line(`Casos: ${filas.length} | OC creadas: ${creadas} | Rechazados: ${filas.length - creadas} | Fallos: ${fallos}`);
  line(fallos === 0 ? "RESULTADO GLOBAL: PASS" : "RESULTADO GLOBAL: FAIL");
  return { lines, fallos };
}

export { matrizMarkdown };
