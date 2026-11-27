import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BusinessError, CODIGO } from "../domain/errores";
import { SapError, type SapAdapter } from "../sap";

/** Dependencias que reciben los handlers (inyectadas: facilita demo.ts y pruebas). */
export interface ToolContext {
  sap: SapAdapter;
  /** Fecha (YYYY-MM-DD) para documentos nuevos. */
  fecha: string;
  /** Registro del servidor para errores TECNICOS (detalle completo; nunca se envia al cliente ni al modelo). */
  log?(entry: Record<string, unknown>): void;
}

/** Datos de la ejecucion de una tool con confirmacion (los pone el bucle/endpoint, nunca el modelo). */
export interface ToolRun {
  /** `data` devuelto por preflight y guardado en la accion pendiente. */
  preflight?: unknown;
  /** Comentario de la persona que aprobo. */
  comentarioAprobador?: string;
}

/** Resultado de validar ANTES de molestar a la persona. */
export type PreflightResult =
  | {
      ok: true;
      /** se guarda en la accion pendiente y se pasa al handler */
      data: unknown;
      /** vista para la tarjeta */
      vista: unknown;
      resumen: string;
      /** Huella de lo que ve la persona (OC + controles + documentos). Al confirmar se re-ejecuta el preflight y debe coincidir. */
      huella?: string;
    }
  | { ok: false; error: string; code?: string; ref?: string };

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  handler: (input: z.infer<S>, ctx: ToolContext, run: ToolRun) => Promise<unknown> | unknown;
  /** Si es true, el bucle del agente NO ejecuta la tool sin aprobacion humana guardada en el servidor. */
  requiresConfirmation: boolean;
  /**
   * Solo para requiresConfirmation: validacion determinista previa. Si falla (o es bloqueante) el bucle
   * devuelve el error al modelo y NUNCA llega a la persona.
   */
  /** Resumen pequeno y estructurado del resultado (p. ej. recibo de la OC). Se guarda aparte del detalle tecnico truncado. */
  recibo?: (output: unknown) => unknown;
  preflight?: (input: z.infer<S>, ctx: ToolContext) => PreflightResult | Promise<PreflightResult>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export type ToolResult = { ok: true; output: unknown } | { ok: false; error: string; code?: string; ref?: string };

/**
 * Clasifica un error lanzado por una herramienta. NEGOCIO (BusinessError, SapError): el mensaje es seguro y se devuelve.
 * TECNICO (cualquier otro): detalle solo al log del servidor; al cliente y al modelo, mensaje seguro + codigo + referencia.
 */
export function toSafeError(e: unknown, tool: string, ctx: ToolContext): { error: string; code: string; ref?: string } {
  if (e instanceof BusinessError) return { error: e.message, code: e.code };
  if (e instanceof SapError) return { error: e.message, code: `SAP_${e.code}` };
  const ref = crypto.randomUUID().slice(0, 8);
  const entry = { level: "error", event: "tool_error", tool, ref, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
  try {
    (ctx.log ?? ((x) => console.error(JSON.stringify(x))))(entry);
  } catch {
    /* el log nunca debe romper la herramienta */
  }
  return { error: `Error interno al ejecutar ${tool}. No se pudo completar (código ${CODIGO.ERROR_TECNICO}, ref: ${ref}). Intenta de nuevo; si persiste, informa la referencia.`, code: CODIGO.ERROR_TECNICO, ref };
}

export type Confirmation = "humano" | "autoConfirm";

/**
 * Ejecuta una tool validando la entrada con zod. Las tools con requiresConfirmation
 * solo se ejecutan si se indica `confirmation` ("humano" desde el flujo de aprobacion,
 * "autoConfirm" desde demo.ts, que lo registra explicitamente).
 */
export async function executeTool(
  tools: ToolDef[],
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
  opts: { confirmation?: Confirmation } & ToolRun = {},
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };
  if (tool.requiresConfirmation && !opts.confirmation) {
    return { ok: false, error: `La herramienta ${name} requiere confirmación humana.` };
  }
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Entrada inválida: ${z.prettifyError(parsed.error)}` };
  }
  try {
    const { confirmation: _c, ...run } = opts;
    return { ok: true, output: await tool.handler(parsed.data, ctx, run) };
  } catch (e) {
    return { ok: false, ...toSafeError(e, name, ctx) };
  }
}

/** Valida la entrada con zod y corre el preflight de una tool con confirmacion. */
export async function preflightTool(tool: ToolDef, rawInput: unknown, ctx: ToolContext): Promise<PreflightResult & { input?: unknown }> {
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: `Entrada inválida: ${z.prettifyError(parsed.error)}` };
  if (!tool.preflight) return { ok: true, data: undefined, vista: parsed.data, resumen: `Ejecutar ${tool.name}`, input: parsed.data };
  try {
    const r = await tool.preflight(parsed.data, ctx);
    return r.ok ? { ...r, input: parsed.data } : r;
  } catch (e) {
    return { ok: false, ...toSafeError(e, tool.name, ctx) };
  }
}

/** Definiciones para la API de Anthropic (input_schema generado desde zod). Cache en la ultima. */
export function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t, i) => {
    const { $schema: _omit, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
      ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    };
  });
}
