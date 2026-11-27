// Informe de auditoría de una sesión: función PURA sobre el estado guardado (sin I/O).
// Por solicitud: controles y resultado, quién/cuándo aprobó o rechazó (y su comentario o motivo), número de OC, llamadas a
// herramientas. El costo en tokens es por turno y total de la sesión (un turno puede tocar varias solicitudes).
import type { SessionState, TurnTrace } from "../agent/state";
import type { OrdenCompra, ResultadoControl } from "../domain/types";

export interface AuditoriaSolicitud {
  solicitudId: string;
  /**
   * BLOQUEADA: algún control bloqueante dio FALLA (en la validación o en el preflight de crear la OC) y no hubo OC.
   * SIN_PROCESAR: la solicitud solo se leyó o validó sin FALLA, y nadie pidió ni decidió una OC.
   */
  estado: "OC_CREADA" | "APROBADA_SIN_OC" | "RECHAZADA" | "PENDIENTE_APROBACION" | "BLOQUEADA" | "SIN_PROCESAR";
  controles: ResultadoControl[] | null;
  aprobacion: {
    pendingId: string;
    solicitadaEn: string;
    decision: "aprobar" | "rechazar" | null;
    /** Comentario (aprobar) o motivo (rechazar) escrito por la persona. */
    comentario: string | null;
    decididaEn: string | null;
    /** Sin autenticación en esta demo: la identidad no se conoce (ver SOLUCION.md y README). */
    aprobador: string | null;
    turnoId: string | null;
  }[];
  oc: { numero: string; total: number; moneda: string; fecha: string; comentarioAprobador: string | null } | null;
  llamadasHerramientas: { ts: string | null; herramienta: string; ok: boolean | null; entrada: unknown }[];
}

export interface Auditoria {
  sessionId: string;
  generadoEn: string;
  nota: string;
  solicitudes: AuditoriaSolicitud[];
  /** Llamadas a herramientas que no son de una solicitud concreta (p. ej. listar_solicitudes). */
  otrasLlamadas: { ts: string | null; herramienta: string; ok: boolean | null }[];
  turnos: { traceId: string; ts: string; status: string; iteraciones: number; herramientas: TurnTrace["tools"]; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costoUsd: number; costoSimulado: boolean }[];
  /** Cuántos turnos hay en `turnos` (la traza conserva solo los últimos) frente a los de toda la sesión (`costoTotal.turnos`). */
  turnosMostrados: number;
  /** `costoSimulado`: algún turno fue en modo simulado (MOCK_LLM); sus tokens son inventados y no suman costo (costoUsd = 0 para ellos). */
  costoTotal: { turnos: number; llamadasModelo: number; input: number; output: number; cacheRead: number; cacheWrite: number; costoUsd: number; costoSimulado: boolean };
}

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function construirAuditoria(sessionId: string, state: SessionState, ahora: string): Auditoria {
  const porSol = new Map<string, AuditoriaSolicitud>();
  const sol = (id: string): AuditoriaSolicitud => {
    let s = porSol.get(id);
    if (!s) porSol.set(id, (s = { solicitudId: id, estado: "SIN_PROCESAR", controles: null, aprobacion: [], oc: null, llamadasHerramientas: [] }));
    return s;
  };
  const otras: Auditoria["otrasLlamadas"] = [];
  const resultados = new Map<string, boolean>(); // toolUseId -> ok

  for (const e of state.events) if (e.type === "tool_result") resultados.set(e.id, e.ok);

  // 1) Eventos: llamadas a herramientas y controles de validar_controles (los eventos tienen tope; si ya no están, queda null).
  for (const e of state.events) {
    if (e.type === "tool_call") {
      const inp = (e.input ?? {}) as { id?: unknown; solicitudId?: unknown };
      const id = str(inp.solicitudId) ?? str(inp.id);
      const ok = resultados.get(e.id) ?? null;
      if (id) sol(id).llamadasHerramientas.push({ ts: iso(e.ts), herramienta: e.name, ok, entrada: e.input });
      else otras.push({ ts: iso(e.ts), herramienta: e.name, ok });
    } else if (e.type === "tool_result" && e.name === "validar_controles" && e.ok) {
      const o = e.output as { controles?: ResultadoControl[] } | string;
      const call = state.events.find((x) => x.type === "tool_call" && x.id === e.id);
      const id = call && call.type === "tool_call" ? str((call.input as { id?: unknown })?.id) : null;
      if (id && typeof o === "object" && Array.isArray(o?.controles)) sol(id).controles = o.controles;
    }
  }

  // 2) Registro de auditoría persistente: aprobaciones/rechazos y OC creadas.
  const aprob = new Map<string, { sol: string; fila: AuditoriaSolicitud["aprobacion"][number] }>();
  for (const a of state.audit) {
    if (a.type === "pending_creado") {
      const id = str(a.solicitudId) ?? str((a.input as { solicitudId?: unknown } | undefined)?.solicitudId);
      if (!id) continue;
      const s = sol(id);
      if (Array.isArray(a.controles)) s.controles = a.controles as ResultadoControl[]; // lo que vio quien aprueba
      const fila = { pendingId: String(a.pendingId), solicitadaEn: a.ts, decision: null, comentario: null, decididaEn: null, aprobador: null, turnoId: str(a.traceId) };
      s.aprobacion.push(fila);
      aprob.set(String(a.pendingId), { sol: id, fila });
    } else if (a.type === "decision") {
      const x = aprob.get(String(a.pendingId));
      if (!x) continue;
      x.fila.decision = a.decision === "aprobar" ? "aprobar" : "rechazar";
      x.fila.comentario = str(a.comentario);
      x.fila.decididaEn = a.ts;
    } else if (a.type === "tool_ejecutada" && a.ok === true) {
      const x = aprob.get(String(a.pendingId));
      const oc = a.resultado as Partial<OrdenCompra> | undefined;
      if (x && oc?.numero) sol(x.sol).oc = { numero: oc.numero, total: Number(oc.total), moneda: String(oc.moneda), fecha: String(oc.fecha), comentarioAprobador: oc.comentarioAprobador ?? null };
    }
  }

  // 3) Estado final por solicitud (la fuente de verdad de las OC es el SAP simulado de la sesión).
  for (const o of state.sap.ordenes) {
    const s = sol(o.solicitudId);
    s.oc ??= { numero: o.numero, total: o.total, moneda: o.moneda, fecha: o.fecha, comentarioAprobador: o.comentarioAprobador ?? null };
  }
  for (const s of porSol.values()) {
    const ultima = s.aprobacion[s.aprobacion.length - 1];
    const bloqueada = (s.controles ?? []).some((c) => c.resultado === "FALLA") || s.llamadasHerramientas.some((l) => l.herramienta === "crear_orden_compra" && l.ok === false);
    s.estado = s.oc
      ? "OC_CREADA"
      : state.pending && ultima && ultima.pendingId === state.pending.pendingId
        ? "PENDIENTE_APROBACION"
        : ultima?.decision === "rechazar"
          ? "RECHAZADA"
          : ultima?.decision === "aprobar"
            ? "APROBADA_SIN_OC"
            : bloqueada
              ? "BLOQUEADA"
              : "SIN_PROCESAR";
  }

  const turnos = state.trace.map((t) => ({
    traceId: t.traceId,
    ts: t.ts,
    status: t.status,
    iteraciones: t.iterations,
    herramientas: t.tools,
    tokens: { input: t.usage.input, output: t.usage.output, cacheRead: t.usage.cacheRead, cacheWrite: t.usage.cacheWrite },
    costoUsd: t.usage.costUsd,
    costoSimulado: t.usage.simulado === true,
  }));
  // Total de TODA la sesion desde los acumuladores (la traza se recorta a los ultimos turnos).
  const { turnos: nTurnos, llamadasModelo, input, output, cacheRead, cacheWrite, costoUsd, simulado } = state.costo;
  const costoTotal = { turnos: nTurnos, llamadasModelo, input, output, cacheRead, cacheWrite, costoUsd, costoSimulado: simulado === true };

  return {
    sessionId,
    generadoEn: ahora,
    nota: "Demo sin autenticación: la identidad de quien aprueba/rechaza no se registra (aprobador = null). Los eventos de la sesión tienen tope; el detalle por turno muestra solo los últimos turnos (turnosMostrados); costoTotal suma TODA la sesión. Costo estimado (en modo simulado el costo es 0 y se marca costoSimulado).",
    solicitudes: [...porSol.values()].sort((a, b) => a.solicitudId.localeCompare(b.solicitudId)),
    otrasLlamadas: otras,
    turnos,
    turnosMostrados: turnos.length,
    costoTotal,
  };
}

const ETIQUETA_ESTADO: Record<AuditoriaSolicitud["estado"], string> = {
  OC_CREADA: "OC creada",
  APROBADA_SIN_OC: "Aprobada sin OC",
  RECHAZADA: "Rechazada por el aprobador",
  PENDIENTE_APROBACION: "Pendiente de aprobación",
  BLOQUEADA: "Bloqueada por controles",
  SIN_PROCESAR: "Sin procesar",
};

/** Celda CSV: comillas dobles escapadas y, contra inyección de fórmulas en hojas de cálculo, prefijo `'` si empieza por = + - @ o tabulador. */
function celdaCsv(v: unknown): string {
  let t = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Auditoría en CSV (una fila por solicitud) para quien no abre JSON: Excel / Hojas de cálculo. Función pura. */
export function auditoriaCsv(a: Auditoria): string {
  const cab = ["solicitud", "estado", "oc", "total", "moneda", "decision", "comentario_o_motivo", "controles", "fecha"];
  const filas = a.solicitudes.map((s) => {
    const d = s.aprobacion[s.aprobacion.length - 1];
    const controles = (s.controles ?? []).map((c) => `${c.id} ${c.resultado}`).join("; ");
    const fecha = d?.decididaEn ?? s.oc?.fecha ?? d?.solicitadaEn ?? "";
    return [s.solicitudId, ETIQUETA_ESTADO[s.estado], s.oc?.numero ?? "", s.oc?.total ?? "", s.oc?.moneda ?? "", d?.decision ?? "", d?.comentario ?? "", controles, fecha];
  });
  return "\uFEFF" + [cab, ...filas].map((f) => f.map(celdaCsv).join(",")).join("\r\n") + "\r\n";
}
