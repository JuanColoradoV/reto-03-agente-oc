// Worker: valida y enruta. Todo el estado de la conversacion vive en el Durable Object de la sesion
// (src/session/). El cliente solo envia {sessionId, mensaje} / {sessionId, pendingId, decision}.
import { Hono } from "hono";
import { z } from "zod";
import { executeTool } from "./tools/registry";
import { ocTools } from "./tools/oc";
import { InMemorySap } from "./sap";
import { mockEnabled } from "./llm/mock";
import { MOCK_HEADER, SessionDO } from "./session/do";

export { SessionDO };

type Env = {
  ANTHROPIC_API_KEY?: string;
  /** Solo desarrollo: MOCK_LLM=1 en .dev.vars. Se ignora fuera de localhost (o ENV=dev). */
  MOCK_LLM?: string;
  ENV?: string;
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  /** Workers Rate Limiting binding (opcional; ver wrangler.jsonc). */
  CHAT_LIMITER?: RateLimit;
  /** Idem para las lecturas GET de sesion (tope mas alto: la UI sondea mientras hay un turno en curso). */
  READ_LIMITER?: RateLimit;
};
const app = new Hono<{ Bindings: Env }>();

function err(code: string, message: string) {
  return { error: { code, message } };
}

// ---- Rate limit por IP: POST y lecturas GET de sesion ----
// Preferido: binding de Workers Rate Limiting (global y consistente). Respaldo: en memoria por isolate
// (mejor esfuerzo; sirve en `wrangler dev` y como freno basico si el binding no esta configurado).
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
  if (origin && origin !== new URL(c.req.url).origin) return c.json(err("origen_no_permitido", "Origen no permitido."), 403);
  // La IP solo se toma de CF-Connecting-IP (la pone Cloudflare y el cliente no puede falsificarla). Sin ella
  // (p. ej. `wrangler dev`) todos comparten un solo cubo: x-forwarded-for lo controla el cliente y permitiria evadir el limite.
  const ip = c.req.header("cf-connecting-ip") ?? "sin-ip";
  if (c.req.method === "POST") {
    const limited = c.env.CHAT_LIMITER ? !(await c.env.CHAT_LIMITER.limit({ key: ip })).success : rateLimitedLocal(`post:${ip}`, RATE.MAX);
    if (limited) return c.json(err("rate_limit", "Demasiadas solicitudes. Intenta de nuevo en unos minutos."), 429);
  } else if (c.req.method === "GET" && c.req.path.startsWith("/api/sesion/")) {
    // Lecturas de sesion (estado/traza): tope propio, mas holgado (la UI sondea mientras un turno sigue en curso).
    const limited = c.env.READ_LIMITER ? !(await c.env.READ_LIMITER.limit({ key: ip })).success : rateLimitedLocal(`get:${ip}`, RATE.MAX_READ);
    if (limited) return c.json(err("rate_limit", "Demasiadas solicitudes. Intenta de nuevo en unos minutos."), 429);
  }
  await next();
});

const sessionId = z.string().uuid();
const chatBody = z.object({ sessionId, mensaje: z.string().min(1).max(4000) });
const confirmBody = z.object({
  sessionId,
  pendingId: z.string().min(1).max(100),
  decision: z.enum(["aprobar", "rechazar"]),
  comentario: z.string().max(1000).optional(),
});

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

app.get("/api/health", (c) => c.json({ ok: true, hasApiKey: Boolean(c.env.ANTHROPIC_API_KEY), mock: isMock(c) }));

// Datos para los botones de accion rapida (sin LLM ni sesion).
app.get("/api/solicitudes", async (c) => {
  const r = await executeTool(ocTools, "listar_solicitudes", {}, { sap: new InMemorySap(), fecha: "" });
  return r.ok ? c.json({ solicitudes: r.output }) : c.json(err("error_interno", "No se pudieron listar las solicitudes."), 500);
});

app.post("/api/chat", async (c) => {
  const b = chatBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json(err("peticion_invalida", "Cuerpo de la petición inválido."), 400);
  if (!c.env.ANTHROPIC_API_KEY && !isMock(c)) {
    return c.json(err("missing_api_key", "Falta configurar ANTHROPIC_API_KEY. Defínela en .dev.vars (local) o con `wrangler secret put ANTHROPIC_API_KEY`."), 503);
  }
  return forward(c, b.data.sessionId, "/chat", jsonInit({ mensaje: b.data.mensaje }));
});

app.post("/api/confirm", async (c) => {
  const b = confirmBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json(err("peticion_invalida", "Cuerpo de la petición inválido."), 400);
  const { sessionId: id, ...rest } = b.data;
  return forward(c, id, "/confirm", jsonInit(rest));
});

// Estado renderizable (para restaurar el chat al recargar), traza y reinicio. El sessionId es un UUID
// aleatorio que funciona como secreto de la sesion.
app.get("/api/sesion/:id", async (c) => {
  const id = sessionId.safeParse(c.req.param("id"));
  return id.success ? forwardRead(c, id.data, "/state") : c.json(err("peticion_invalida", "Sesión inválida."), 400);
});
app.get("/api/sesion/:id/traza", async (c) => {
  const id = sessionId.safeParse(c.req.param("id"));
  return id.success ? forwardRead(c, id.data, "/trace") : c.json(err("peticion_invalida", "Sesión inválida."), 400);
});
app.post("/api/sesion/:id/reset", async (c) => {
  const id = sessionId.safeParse(c.req.param("id"));
  return id.success ? forward(c, id.data, "/reset", { method: "POST" }) : c.json(err("peticion_invalida", "Sesión inválida."), 400);
});

app.onError((e, c) => {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(JSON.stringify({ level: "error", ref, path: c.req.path, message: e instanceof Error ? e.message : String(e) }));
  return c.json(err("error_interno", `Ocurrió un error interno. (ref: ${ref})`), 500);
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json(err("no_encontrado", "Ruta no encontrada."), 404) : c.env.ASSETS.fetch(c.req.raw)));

export default app;
