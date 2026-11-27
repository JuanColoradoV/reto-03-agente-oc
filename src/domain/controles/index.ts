// Registro de controles. Agregar un control = agregarlo a CONTROLES (el orden es el orden de salida).
import type { CasoSolicitud, Maestros, ResultadoControl, ResumenControles } from "../types";
import { C0_OC_EXISTENTE, C1_PROVEEDOR, C2_COTIZACION, C3_APROBACION, C4_RETROACTIVA, type ControlCtx, type ControlDef } from "./definiciones";

export type { ControlCtx, ControlDef } from "./definiciones";

export const CONTROLES: readonly ControlDef[] = [C0_OC_EXISTENTE, C1_PROVEEDOR, C2_COTIZACION, C3_APROBACION, C4_RETROACTIVA];

export function evaluarControl(def: ControlDef, caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResultadoControl {
  const ev = def.evaluar(caso, maestros, ctx);
  const resultado =
    ev.estado === "CUMPLE" ? "OK" : ev.estado === "NO_EVALUABLE" ? "ALERTA" : def.severidad === "bloqueante" ? "FALLA" : "ALERTA";
  return { id: def.id, nombre: def.nombre, descripcion: def.descripcion, accion: def.accion, severidad: def.severidad, resultado, detalle: ev.detalle };
}

export function evaluarControles(caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResultadoControl[] {
  return CONTROLES.map((c) => evaluarControl(c, caso, maestros, ctx));
}

export function resumirControles(controles: ResultadoControl[]): ResumenControles {
  const fallas = controles.filter((c) => c.resultado === "FALLA").length;
  const alertas = controles.filter((c) => c.resultado === "ALERTA").length;
  return { controles, fallas, alertas, aprobable: fallas === 0 };
}

export function validarControles(caso: CasoSolicitud, maestros: Maestros, ctx?: ControlCtx): ResumenControles {
  return resumirControles(evaluarControles(caso, maestros, ctx));
}

/** Matriz de controles en Markdown, derivada del registro (para SOLUCION.md y demo.ts). */
export function matrizMarkdown(): string {
  const rows = CONTROLES.map((c) => `| ${c.id} | ${c.nombre} | ${c.regla} | ${c.severidad} | ${c.fuente} |`);
  return ["| ID | Control | Regla | Severidad | Fuente |", "|---|---|---|---|---|", ...rows].join("\n");
}
