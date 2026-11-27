// Guardas de costo y abuso de la URL publica. api.ts solo llama a estas funciones (ganchos minimos).
import { CAPS } from "../agent/estado";
import { clasificar, MSG_AYUDA, MSG_FUERA, pareceRespuesta } from "./topic";
import type { GuardNamespace } from "./ledger";

/** Variables (wrangler vars, o secretos con el mismo nombre: ambos llegan en `env`). Todas opcionales con defecto seguro. */
export interface GuardEnv {
  GUARD?: GuardNamespace;
  /** "false" apaga el chat (503) sin tocar el modelo. */
  CHAT_ENABLED?: string;
  /** Origenes extra permitidos para POST, separados por coma (ademas del propio host). */
  ALLOWED_ORIGINS?: string;
  GUARD_MAX_CHARS?: string;
  GUARD_MAX_MSGS_SESSION?: string;
  GUARD_MAX_MSGS_IP_DAY?: string;
  GUARD_STRIKES?: string;
  GUARD_STRIKE_WINDOW_MIN?: string;
  GUARD_BLOCK_MIN?: string;
}

const entero = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n > 0 ? n : def;
};

export function guardConfig(env: GuardEnv) {
  return {
    maxChars: Math.min(entero(env.GUARD_MAX_CHARS, 600), CAPS.MENSAJE_CHARS),
    maxMsgsSesion: entero(env.GUARD_MAX_MSGS_SESSION, 30),
    maxMsgsIpDia: entero(env.GUARD_MAX_MSGS_IP_DAY, 60),
    strikes: entero(env.GUARD_STRIKES, 8),
    ventanaMs: entero(env.GUARD_STRIKE_WINDOW_MIN, 60) * 60_000,
    bloqueoMs: entero(env.GUARD_BLOCK_MIN, 60) * 60_000,
  };
}

export const chatHabilitado = (env: GuardEnv) => (env.CHAT_ENABLED ?? "true").trim().toLowerCase() !== "false";

export const MSG_PAUSADA = "La demo está pausada.";
export const MSG_BLOQUEADO = "Demasiadas solicitudes inválidas o fuera de tema desde tu conexión. Vuelve a intentarlo más tarde.";
export const MSG_TOPE_SESION = "Esta conversación alcanzó su límite de mensajes. Inicia una nueva conversación para continuar.";
export const MSG_TOPE_IP = "Alcanzaste el límite diario de mensajes de la demo. Vuelve mañana.";
export const MSG_NO_DISPONIBLE = "El control de uso no está disponible en este momento. Intenta de nuevo más tarde.";
const msgLargo = (max: number) => `El mensaje supera el límite de ${max} caracteres. Escribe una petición más corta.`;

const json = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json", ...headers } });

const retryAfter = (hasta: number) => String(Math.max(1, Math.ceil((hasta - Date.now()) / 1000)));
const bloqueada = (hasta: number) => json(429, "ip_bloqueada", MSG_BLOQUEADO, { "Retry-After": retryAfter(hasta) });

const ipStub = (env: GuardEnv, ip: string) => env.GUARD?.get(env.GUARD.idFromName(`ip:${ip}`));

/** Origen permitido: el del propio host o uno de ALLOWED_ORIGINS. */
export function origenPermitido(env: GuardEnv, origin: string, own: string): boolean {
  if (origin === own) return true;
  return (env.ALLOWED_ORIGINS ?? "").split(",").some((o) => o.trim() !== "" && o.trim().replace(/\/$/, "") === origin);
}

/**
 * Registra un strike (peticion invalida/fuera de tema/origen ajeno/confirmacion invalida). Devuelve una respuesta 429 si con este
 * strike la IP quedo bloqueada, o null. Mejor esfuerzo: si el DO falla no se rompe la peticion (la guarda de costo ya fallo cerrado antes).
 */
export async function strike(env: GuardEnv, ip: string, mock: boolean): Promise<Response | null> {
  if (mock) return null;
  const s = ipStub(env, ip);
  if (!s) return null;
  const c = guardConfig(env);
  try {
    const r = await s.strike(c.strikes, c.ventanaMs, c.bloqueoMs);
    return r.bloqueado ? bloqueada(r.hasta) : null;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "guard_strike_failed", message: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/** 429 si la IP esta bloqueada. Falla CERRADO: si el DO no responde, 503. */
export async function ipBloqueada(env: GuardEnv, ip: string, mock: boolean): Promise<Response | null> {
  if (mock) return null;
  const s = ipStub(env, ip);
  if (!s) return null;
  try {
    const r = await s.bloqueo();
    return r.bloqueado ? bloqueada(r.hasta) : null;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "guard_check_failed", message: e instanceof Error ? e.message : String(e) }));
    return json(503, "guarda_no_disponible", MSG_NO_DISPONIBLE);
  }
}

/** Respuesta SSE con la misma forma que la del agente: eventos `ui` (assistant_text) y `done`. Sin modelo, costo cero. */
export function respuestaEnlatada(texto: string): Response {
  const usage = { traceId: "guard", calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  const body = ev("ui", { type: "assistant_text", text: texto, ts: Date.now() }) + ev("done", { status: "done", traceId: "guard", usage });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

export interface PreChat {
  env: GuardEnv;
  ip: string;
  mock: boolean;
  sessionId: string;
  mensaje: string;
  /** Consulta al servidor (DO de la sesion) si hay una confirmacion pendiente. Solo se llama si el mensaje parece una respuesta. */
  hayPendiente(): Promise<boolean>;
}

/**
 * Guardas previas al modelo, sin costo: tamano -> tema. Devuelve la Response que corta el flujo, o null para continuar hacia el agente. (El bloqueo de IP, el kill switch, el
 * presupuesto global y los topes con costo, `consumirTopes`, los aplica api.ts.)
 */
export async function preChat(p: PreChat): Promise<Response | null> {
  const c = guardConfig(p.env);
  if (p.mensaje.length > c.maxChars) return (await strike(p.env, p.ip, p.mock)) ?? json(400, "mensaje_largo", msgLargo(c.maxChars));

  const pendiente = pareceRespuesta(p.mensaje) ? await p.hayPendiente().catch(() => false) : false;
  const v = clasificar(p.mensaje, pendiente);
  if (v === "saludo") return respuestaEnlatada(MSG_AYUDA);
  if (v === "fuera") return (await strike(p.env, p.ip, p.mock)) ?? respuestaEnlatada(MSG_FUERA);

  return null;
}

/**
 * Topes que cuestan, para mensajes que YA van al modelo (tras tema y presupuesto): max de mensajes por sesion y por IP/dia.
 * Cuenta el mensaje. En modo simulado no aplican (no hay costo). Falla CERRADO.
 */
export async function consumirTopes(p: Pick<PreChat, "env" | "ip" | "mock" | "sessionId">): Promise<Response | null> {
  const c = guardConfig(p.env);
  if (p.mock || !p.env.GUARD) return null;
  const g = p.env.GUARD;
  try {
    const s = await g.get(g.idFromName(`ses:${p.sessionId}`)).consumirSesion(c.maxMsgsSesion);
    if (!s.permitido) return json(429, "tope_sesion", MSG_TOPE_SESION);
    const d = await g.get(g.idFromName(`ip:${p.ip}`)).consumirDia(c.maxMsgsIpDia);
    if (!d.permitido) return json(429, "tope_ip_dia", MSG_TOPE_IP, { "Retry-After": "3600" });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "guard_cap_failed", message: e instanceof Error ? e.message : String(e) }));
    return json(503, "guarda_no_disponible", MSG_NO_DISPONIBLE);
  }
  return null;
}
