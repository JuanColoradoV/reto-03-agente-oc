// API interna del Durable Object (la expone el Worker via stub.fetch). Sin dependencias de Workers:
// se prueba con app.request(). El stream es SSE: eventos `ui` (UiEvent) y un `done` final.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { auditoriaCsv } from "./auditoria";
import { SessionError, type PreparedTurn, type Session, type TurnOpts } from "./session";

/** Cabecera interna que SOLO pone el Worker tras verificar mockEnabled (el Worker nunca copia cabeceras del cliente). */
export const MOCK_HEADER = "x-mock-llm";

/** Comentario SSE periodico: evita que proxies/CDN cierren el stream por inactividad durante una llamada larga al modelo. */
export const KEEPALIVE_MS = 15_000;

const err = (code: string, message: string) => ({ error: { code, message } });

const chatBody = z.object({ mensaje: z.string() });
const confirmBody = z.object({
  pendingId: z.string().min(1).max(100),
  decision: z.enum(["aprobar", "rechazar"]),
  comentario: z.string().max(1000).optional(),
});

export function buildSessionApp(getSession: () => Session, opts: { keepAliveMs?: number } = {}) {
  const app = new Hono();
  const keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  // Parametros del turno: inmutables, derivados de ESTA peticion (nada se guarda en la instancia del DO).
  const turnOpts = (c: { req: { header(n: string): string | undefined } }): TurnOpts => ({ mock: c.req.header(MOCK_HEADER) === "1" });

  async function stream(c: Parameters<typeof streamSSE>[0], prepare: () => Promise<PreparedTurn>) {
    let turn: PreparedTurn;
    try {
      turn = await prepare();
    } catch (e) {
      if (e instanceof SessionError) return c.json(err(e.code, e.message), e.status);
      throw e;
    }
    try {
      return streamSSE(c, async (s) => {
        const write = async (event: string, data: unknown) => {
          try {
            await s.writeSSE({ event, data: JSON.stringify(data) });
          } catch {
            /* cliente desconectado: el turno continua y se guarda */
          }
        };
        const ping = setInterval(() => void s.write(": ping\n\n").catch(() => {}), keepAliveMs);
        try {
          const result = await turn.run((e) => write("ui", e));
          await write("done", result);
        } finally {
          clearInterval(ping);
        }
      });
    } catch (e) {
      turn.cancel(); // no se llego a ejecutar: libera el candado de la sesion
      throw e;
    }
  }

  app.post("/chat", async (c) => {
    const b = chatBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json(err("peticion_invalida", "Cuerpo de la petición inválido."), 400);
    return stream(c, () => getSession().startChat(b.data.mensaje, turnOpts(c)));
  });

  app.post("/confirm", async (c) => {
    const b = confirmBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json(err("peticion_invalida", "Cuerpo de la petición inválido."), 400);
    return stream(c, () => getSession().startConfirm(b.data.pendingId, b.data.decision, b.data.comentario, turnOpts(c)));
  });

  app.get("/state", async (c) => c.json(await getSession().snapshot()));
  app.get("/trace", async (c) => c.json({ trace: await getSession().trace(), costo: await getSession().costo() }));
  app.get("/auditoria", async (c) => c.json(await getSession().auditoria()));
  app.get("/auditoria.csv", async (c) => c.body(auditoriaCsv(await getSession().auditoria()), 200, { "content-type": "text/csv; charset=utf-8" }));
  app.post("/reset", async (c) => {
    try {
      await getSession().reset();
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof SessionError) return c.json(err(e.code, e.message), e.status);
      throw e;
    }
  });

  app.onError((e, c) => {
    console.error(JSON.stringify({ level: "error", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
    return c.json(err("error_interno", "Ocurrió un error interno. Intenta de nuevo."), 500);
  });
  return app;
}
