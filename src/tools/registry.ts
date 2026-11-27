import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SapAdapter } from "../sap";

/** Dependencias que reciben los handlers (inyectadas: facilita demo.ts y pruebas). */
export interface ToolContext {
  sap: SapAdapter;
  /** Fecha (YYYY-MM-DD) para documentos nuevos. */
  fecha: string;
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
  | { ok: true; /** se guarda en la accion pendiente y se pasa al handler */ data: unknown; /** vista para la tarjeta */ vista: unknown; resumen: string }
  | { ok: false; error: string };

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
  preflight?: (input: z.infer<S>, ctx: ToolContext) => PreflightResult | Promise<PreflightResult>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export type ToolResult = { ok: true; output: unknown } | { ok: false; error: string };

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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
