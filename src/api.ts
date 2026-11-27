// API del Worker: valida y enruta. Todo el estado de la conversacion vive en el Durable Object de la sesion
// (src/session/). El cliente solo envia {sessionId, mensaje} / {sessionId, pendingId, decision}.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { CAPS } from "./agent/estado";
import { fixturesEmpaquetados } from "./domain/fixtures";
import { claveUsable, MODELO_POR_DEFECTO } from "./llm/anthropic";
import { mockEnabled } from "./llm/mock";
import { MOCK_HEADER } from "./session/routes";
import { MSG_PRESUPUESTO, parseBudget, type BudgetNamespace } from "./budget/ledger";
import { chatHabilitado, consumirTopes, guardConfig, ipBloqueada, MSG_PAUSADA, origenPermitido, preChat, strike, type GuardEnv } from "./guard";

export type Env = {
  ANTHROPIC_API_KEY?: string;
  LLM_MODEL?: string;
  /** Solo desarrollo: MOCK_LLM=1 en .dev.vars. Se ignora fuera de localhost (o ENV=dev). */
  MOCK_LLM?: string;
  ENV?: string;
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  /** Contador global del gasto diario (opcional; ver src/budget). */
  BUDGET?: BudgetNamespace;
  /** Tope diario en USD (por defecto 5). */
  DAILY_BUDGET_USD?: string;
  /** Workers Rate Limiting binding (opcional; ver wrangler.jsonc). */
  CHAT_LIMITER?: RateLimit;
  /** Idem para las lecturas GET de sesion (tope mas alto: la UI sondea mientras hay un turno en curso). */
  READ_LIMITER?: RateLimit;
} & GuardEnv; // guardas de costo/abuso: ver src/guard
export const app = new Hono<{ Bindings: Env }>();

// ---- Cabeceras de seguridad (API y respaldo de assets; las estaticas las pone public/_headers) ----
// CSP: solo recursos propios (la UI no usa scripts ni estilos en linea). frame-ancestors 'self': solo se puede embeber desde el mismo origen.
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};
app.use("*", async (c, next) => {
  await next();
  // Se reconstruye la respuesta: las de assets/DO pueden tener cabeceras inmutables (el cuerpo, incluido el SSE, se conserva).
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  c.res = res;
});

function err(code: string, message: string) {
  return { error: { code, message } };
}

const RATE_MESSAGE = "Demasiadas solicitudes. Espera 1 minuto y vuelve a intentarlo.";
const rateLimited = (c: Context) => {
  c.header("Retry-After", String(RATE.WINDOW_MS / 1000));
  return c.json(err("rate_limit", RATE_MESSAGE), 429);
};

// ---- Rate limit por IP: POST y lecturas GET de sesion ----
// Preferido: binding de Workers Rate Limiting. Segun la documentacion de Cloudflare es APROXIMADO: los contadores son por
// ubicacion (cada centro de datos cuenta aparte) y eventualmente consistentes, asi que es un freno de abuso, no una cuota exacta.
// Respaldo: en memoria por isolate (mejor esfuerzo; sirve en `wrangler dev` y como freno basico si el binding no esta configurado).
const RATE = { WINDOW_MS: 60_000, MAX: 20, MAX_READ: 120 };
const hits = new Map<string, number[]>();
function rateLimitedLocal(key: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE.WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE.WINDOW_MS)) hits.delete(k);
  return recent.length > max;
}

app.use("/api/*", async (c, next) => {
  // Same-origin: no se emiten cabeceras CORS y se rechazan origenes ajenos.
  const origin = c.req.header("origin");
  const mock = isMock(c);
  // POST: Origin OBLIGATORIO (los navegadores siempre lo envian en fetch POST; con curl hay que pasarlo). En modo simulado (solo localhost) se tolera su ausencia.
  if ((c.req.method === "POST" && !origin && !mock) || (origin && !origenPermitido(c.env, origin, new URL(c.req.url).origin))) {
    return (await strike(c.env, c.req.header("cf-connecting-ip") ?? "sin-ip", mock)) ?? c.json(err("origen_no_permitido", "Origen no permitido."), 403);
  }
  // La IP solo se toma de CF-Connecting-IP (la pone Cloudflare y el cliente no puede falsificarla). Sin ella
  // (p. ej. `wrangler dev`) todos comparten un solo cubo: x-forwarded-for lo controla el cliente y permitiria evadir el limite.
  const ip = c.req.header("cf-connecting-ip") ?? "sin-ip";
  if (c.req.method === "POST") {
    const bloqueo = await ipBloqueada(c.env, ip, mock);
    if (bloqueo) return bloqueo;
    const limited = c.env.CHAT_LIMITER ? !(await c.env.CHAT_LIMITER.limit({ key: ip })).success : rateLimitedLocal(`post:${ip}`, RATE.MAX);
    if (limited) return rateLimited(c);
  } else if (c.req.method === "GET" && /^\/api\/sesi(on|ons)\//.test(c.req.path)) {
    // Lecturas de sesion (estado/traza): tope propio, mas holgado (la UI sondea mientras un turno sigue en curso).
    const limited = c.env.READ_LIMITER ? !(await c.env.READ_LIMITER.limit({ key: ip })).success : rateLimitedLocal(`get:${ip}`, RATE.MAX_READ);
    if (limited) return rateLimited(c);
  }
  await next();
});

const sessionId = z.string().uuid();
// El tope de caracteres tiene una sola fuente (CAPS.MENSAJE_CHARS); se valida abajo para dar un error que lo indique.
// PRD 6.4: { sessionId, message }. Se acepta tambien `mensaje` (nombre usado por la UI).
const chatBody = z.object({ sessionId, message: z.string().min(1).optional(), mensaje: z.string().min(1).optional() }).refine((b) => b.message ?? b.mensaje, "Falta el mensaje.");

const stub = (env: Env, id: string) => env.SESSIONS.get(env.SESSIONS.idFromName(id));
const isMock = (c: { env: Env; req: { url: string } }) => mockEnabled(c.env, c.req.url);
// Las cabeceras hacia el DO se construyen aqui: nunca se copian las del cliente (la de mock no se puede falsificar).
const forward = (c: { env: Env; req: { url: string } }, id: string, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (isMock(c)) headers.set(MOCK_HEADER, "1");
  return stub(c.env, id).fetch(`https://session${path}`, { ...init, headers });
};
// Lecturas con tope de espera: nunca dejan al cliente colgado.
const forwardRead = async (c: { env: Env; req: { url: string } }, id: string, path: string) => {
  try {
    return await forward(c, id, path, { signal: AbortSignal.timeout(8000) });
  } catch {
    return new Response(JSON.stringify(err("timeout", "La sesión no respondió a tiempo.")), { status: 504, headers: { "content-type": "application/json" } });
  }
};
const jsonInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// PRD 6.4: { ok, provider, model } sin exponer claves. Los demas campos son informativos para la UI (nunca la clave).
app.get("/api/health", (c) => {
  const mock = isMock(c);
  return c.json({ ok: true, provider: mock ? "mock" : "anthropic", model: mock ? "mock-guion" : c.env.LLM_MODEL || MODELO_POR_DEFECTO, hasApiKey: claveUsable(c.env.ANTHROPIC_API_KEY), mock, limits: { mensajeChars: guardConfig(c.env).maxChars } });
});

// Datos para los botones de accion rapida (sin LLM ni sesion).
app.get("/api/solicitudes", async (c) => {
  const casos = await fixturesEmpaquetados.listarCasos();
  const solicitudes = await Promise.all(
    casos.map(async (id) => {
      const correo = JSON.parse((await fixturesEmpaquetados.leer(`solicitudes/${id}/correo.json`)) ?? "{}") as { asunto?: string };
      const sol = JSON.parse((await fixturesEmpaquetados.leer(`solicitudes/${id}/solicitud.json`)) ?? "{}") as { solicitante?: string; descripcion?: string };
      return { id, asunto: correo.asunto ?? null, solicitante: sol.solicitante ?? null, descripcion: sol.descripcion ?? null };
    }),
  );
  return c.json({ solicitudes });
});

/**
 * Cortacircuitos de costo: true si el gasto estimado de HOY (todas las sesiones) ya alcanzo el tope. Falla CERRADO: si el contador
 * no responde (o falta el binding fuera de desarrollo) se deniega, porque la URL publica no puede gastar sin control.
 */
async function presupuestoAgotado(env: Env): Promise<boolean> {
  if (!env.BUDGET) return env.ENV !== "dev";
  try {
    const tope = parseBudget(env.DAILY_BUDGET_USD);
    const consulta = env.BUDGET.get(env.BUDGET.idFromName("global")).consultar(tope);
    let t: ReturnType<typeof setTimeout> | undefined;
    const espera = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error("timeout consultando el presupuesto")), 3000)));
    try {
      return !(await Promise.race([consulta, espera])).permitido;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "budget_check_failed", message: e instanceof Error ? e.message : String(e) }));
    return true;
  }
}

app.post("/api/chat", async (c) => {
  // Kill switch: CHAT_ENABLED=false (var o secreto) apaga el chat sin tocar el modelo.
  if (!chatHabilitado(c.env)) return c.json(err("demo_pausada", MSG_PAUSADA), 503);
  const ip = c.req.header("cf-connecting-ip") ?? "sin-ip";
  const b = chatBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return (await strike(c.env, ip, isMock(c))) ?? c.json(err("peticion_invalida", "Cuerpo de la petición inválido."), 400);
  const mensaje = (b.data.message ?? b.data.mensaje) as string;
  // Guardas previas al modelo, sin costo: tamano (GUARD_MAX_CHARS) y tema. Las respuestas enlatadas no llaman al modelo.
  const corte = await preChat({
    env: c.env, ip, mock: isMock(c), sessionId: b.data.sessionId, mensaje,
    hayPendiente: async () => {
      const r = await forwardRead(c, b.data.sessionId, "/state");
      return r.ok && !!((await r.json()) as { pending?: unknown }).pending;
    },
  });
  if (corte) return corte;
  if (!claveUsable(c.env.ANTHROPIC_API_KEY) && !isMock(c)) {
    return c.json(err("missing_api_key", "Falta configurar ANTHROPIC_API_KEY. Defínela en .dev.vars (local) o con `wrangler secret put ANTHROPIC_API_KEY`."), 503);
  }
  // En modo simulado no hay costo: no se consulta el presupuesto.
  if (!isMock(c) && (await presupuestoAgotado(c.env))) {
    c.header("Retry-After", "3600");
    return c.json(err("presupuesto_diario", MSG_PRESUPUESTO), 503);
  }
  // Topes con costo (mensajes por sesion y por IP/dia): se cuentan solo los mensajes que llegan al modelo.
  const tope = await consumirTopes({ env: c.env, ip, mock: isMock(c), sessionId: b.data.sessionId });
  if (tope) return tope;
  return forward(c, b.data.sessionId, "/chat", jsonInit({ mensaje }));
});

// Estado renderizable (para restaurar el chat al recargar), traza, archivos de out/ y reinicio. El sessionId es un UUID
// aleatorio que funciona como secreto de la sesion. /api/sessions/:id (PRD 6.4) y /api/sesion/:id (nombre original) son equivalentes.
const leer = (sub: string, destino: string) => async (c: Context<{ Bindings: Env }>) => {
  const id = sessionId.safeParse(c.req.param("id"));
  if (!id.success) return c.json(err("peticion_invalida", "Sesión inválida."), 400);
  const resto = sub === "/out/*" ? c.req.path.slice(c.req.path.indexOf("/out/")) : destino;
  return forwardRead(c, id.data, resto);
};
for (const base of ["/api/sessions/:id", "/api/sesion/:id"]) {
  app.get(base, leer("", "/state"));
  app.get(`${base}/trace`, leer("/trace", "/trace"));
  app.get(`${base}/traza`, leer("/trace", "/trace"));
  app.get(`${base}/out`, leer("/out", "/out"));
  app.get(`${base}/out/*`, leer("/out/*", ""));
  app.post(`${base}/reset`, async (c) => {
    const id = sessionId.safeParse(c.req.param("id"));
    return id.success ? forward(c, id.data, "/reset", { method: "POST" }) : c.json(err("peticion_invalida", "Sesión inválida."), 400);
  });
}

app.onError((e, c) => {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(JSON.stringify({ level: "error", ref, path: c.req.path, message: e instanceof Error ? e.message : String(e) }));
  return c.json(err("error_interno", `Ocurrió un error interno. (ref: ${ref})`), 500);
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json(err("no_encontrado", "Ruta no encontrada."), 404) : c.env.ASSETS.fetch(c.req.raw)));

export default app;
