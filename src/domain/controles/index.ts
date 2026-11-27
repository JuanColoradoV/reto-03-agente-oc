// Registro de controles. Agregar un control = agregarlo a CONTROLES (el orden es el orden de salida).
import type { CasoSolicitud, Maestros, ResultadoControl, ResumenControles } from "../types";
import { C0_OC_EXISTENTE, C1_PROVEEDOR, C2_COTIZACION, C3_APROBACION, C4_RETROACTIVA, type ControlCtx, type ControlDef } from "./definiciones";

export type { ControlCtx, ControlDef } from "./definiciones";

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
  return { id: def.id, nombre: def.nombre, descripcion: def.descripcion, accion: def.accion, severidad: def.severidad, resultado, detalle };
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
  const cell = (t: string) => t.replace(/\|/g, "\\|");
  const rows = CONTROLES.map((c) => `| ${c.id} | ${cell(c.nombre)} | ${cell(c.regla)} | ${c.severidad} | ${cell(c.fuente)} | ${cell(c.accion)} |`);
  return ["| ID | Control | Regla | Severidad | Fuente | Acción si no se cumple |", "|---|---|---|---|---|---|", ...rows].join("\n");
}
