// Registro de herramientas: nombre visible = oc_<export>. Valida los argumentos con zod y registra cada llamada en out/log.jsonl (CA4).
import { z } from "zod";
import * as oc from "./oc";
import { servicios, type ToolCtx } from "./contexto";

export interface Herramienta {
  nombre: string;
  description: string;
  args: z.ZodRawShape;
  execute(args: never, ctx: ToolCtx): Promise<string>;
}

type Exportada = { description: string; args: z.ZodRawShape; execute: Herramienta["execute"] };
const esHerramienta = (v: unknown): v is Exportada => typeof v === "object" && v !== null && "execute" in v && "args" in v;

export const herramientas: Herramienta[] = Object.entries(oc as Record<string, unknown>)
  .filter(([, t]) => esHerramienta(t))
  .map(([k, t]) => ({ nombre: `oc_${k}`, description: (t as Exportada).description, args: (t as Exportada).args, execute: (t as Exportada).execute }));

export const esquemaJson = (h: Herramienta): Record<string, unknown> => {
  const { $schema: _omit, ...s } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>;
  return s;
};

const LOG = "log.jsonl";

/** Ejecuta una herramienta por nombre: valida args, ejecuta, registra en out/log.jsonl. Nunca lanza. */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: ToolCtx): Promise<string> {
  const h = herramientas.find((x) => x.nombre === nombre);
  let resultado: string;
  if (!h) resultado = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}.` });
  else {
    const parsed = z.object(h.args).safeParse(args ?? {});
    resultado = parsed.success ? await h.execute(parsed.data as never, ctx) : JSON.stringify({ ok: false, error: `Argumentos inválidos: ${z.prettifyError(parsed.error)}` });
  }
  try {
    const sv = await servicios(ctx);
    const r = JSON.parse(resultado) as { ok?: boolean; error?: string };
    await sv.store.agregarLinea(LOG, JSON.stringify({ ts: sv.ahora().toISOString(), sessionId: ctx.sessionId, herramienta: nombre, args, ok: r.ok === true, ...(r.error ? { error: r.error } : {}) }));
  } catch {
    /* el registro nunca debe romper la herramienta */
  }
  return resultado;
}
