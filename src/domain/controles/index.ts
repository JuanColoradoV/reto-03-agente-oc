// Registro de controles. Agregar un control = agregarlo a CONTROLES (el orden es el orden de salida).
import { problemasDeDatos } from "../datos";
import type { CasoSolicitud, Maestros, ResultadoControl, ResumenControles } from "../types";
import { C0_OC_EXISTENTE, C1_PROVEEDOR, C2_COTIZACION, C3_APROBACION, C4_RETROACTIVA, V0_DATOS, type ControlCtx, type ControlDef } from "./definiciones";

export type { ControlCtx, ControlDef, ControlMeta } from "./definiciones";
export { V0_DATOS } from "./definiciones";

export const CONTROLES: readonly ControlDef[] = [C0_OC_EXISTENTE, C1_PROVEEDOR, C2_COTIZACION, C3_APROBACION, C4_RETROACTIVA];

export function evaluarControl(def: ControlDef, caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResultadoControl {
  const ev = def.evaluar(caso, maestros, ctx);
  let resultado: ResultadoControl["resultado"];
  let detalle = ev.detalle;
  if (ev.estado === "CUMPLE") resultado = "OK";
  else if (ev.estado === "NO_EVALUABLE") {
    // Política: lo que no se puede verificar no se da por bueno. Si el control es bloqueante => FALLA (no se crea OC);
    // si es de alerta => ALERTA (decide el humano).
    resultado = def.severidad === "bloqueante" ? "FALLA" : "ALERTA";
    if (def.severidad === "bloqueante") detalle = `No se pudo verificar: ${ev.detalle}`;
  } else resultado = def.severidad === "bloqueante" ? "FALLA" : "ALERTA";
  return { id: def.id, nombre: def.nombre, descripcion: def.descripcion, accion: def.accion, severidad: def.severidad, resultado, detalle, ...(ev.yaProcesada ? { yaProcesada: ev.yaProcesada } : {}) };
}

/** V0: validación de datos. Solo devuelve un resultado si falla (no es una regla del PRD: no figura en `CONTROLES`). */
export function evaluarV0(caso: CasoSolicitud): ResultadoControl | null {
  const problemas = problemasDeDatos(caso);
  if (!problemas.length) return null;
  const { regla: _regla, fuente: _fuente, estado: _estado, ...meta } = V0_DATOS;
  return { ...meta, resultado: "FALLA", detalle: problemas.join(" ") };
}

export function evaluarControles(caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResultadoControl[] {
  const v0 = evaluarV0(caso);
  return [...CONTROLES.map((c) => evaluarControl(c, caso, maestros, ctx)), ...(v0 ? [v0] : [])];
}

export function resumirControles(controles: ResultadoControl[]): ResumenControles {
  const fallas = controles.filter((c) => c.resultado === "FALLA").length;
  const alertas = controles.filter((c) => c.resultado === "ALERTA").length;
  const falla = controles.find((c) => c.resultado === "FALLA");
  const ya = fallas === 1 && falla?.id === "C0" ? falla.yaProcesada : undefined;
  return { controles, fallas, alertas, aprobable: fallas === 0, ...(ya ? { yaProcesada: ya } : {}) };
}

export function validarControles(caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResumenControles {
  return resumirControles(evaluarControles(caso, maestros, ctx));
}

/** Matriz de controles en Markdown, derivada del registro (más V0, la validación de datos): es la tabla de SOLUCION.md. */
export function matrizMarkdown(): string {
  const cell = (t: string) => t.replace(/\|/g, "\\|");
  const rows = [...CONTROLES, V0_DATOS].map((c) => `| ${c.id} | ${cell(c.nombre)} | ${cell(c.regla)} | ${c.severidad} | ${cell(c.fuente)} | ${cell(c.accion)} | ${cell(c.estado)} |`);
  return ["| ID | Control | Regla | Severidad | Fuente | Acción si no se cumple | Estado |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}
