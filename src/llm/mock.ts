// MODO SIMULADO (solo desarrollo): LlmAdapter con guion para recorrer el flujo completo sin API key.
// Sin estado: cada respuesta se deduce del historial. `mockEnabled` solo es true en localhost (o ENV=dev).
import type { DefinicionHerramienta, LlamadaHerramienta, LlmAdapter, Mensaje, Respuesta } from "./adapter";
import { esConfirmacion } from "../agent/efectos";

export interface MockEnv {
  MOCK_LLM?: string;
  ENV?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** true solo si MOCK_LLM=1 Y (host local O ENV=dev). Nunca en un despliegue normal. */
export function mockEnabled(env: MockEnv, requestUrl: string): boolean {
  if (env.MOCK_LLM !== "1") return false;
  if (env.ENV === "dev") return true;
  try {
    return LOCAL_HOSTS.has(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let seq = 0;

const extraerCaso = (s: string): string | null => {
  const m = s.match(/sol-(?:2026-)?(\d{3})/i);
  return m ? `sol-${m[1]}` : null;
};

interface Salida {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: string;
  pendiente?: boolean;
}
const parse = (s: string): Salida => {
  try {
    return JSON.parse(s) as Salida;
  } catch {
    return { ok: false, error: s };
  }
};

function respuesta(texto: string, llamadas: LlamadaHerramienta[] = []): Respuesta {
  return { texto, llamadas, fin: llamadas.length ? "herramientas" : "fin", uso: { entrada: 1800, salida: 90, cacheLeida: 0, cacheEscrita: 0 } };
}
const llamar = (nombre: string, args: unknown): LlamadaHerramienta => ({ id: `toolu_mock_${++seq}`, nombre, args });

export class MockAdapter implements LlmAdapter {
  readonly proveedor = "mock";
  readonly modelo = "mock-guion";

  async enviar(mensajes: Mensaje[], _h: DefinicionHerramienta[]): Promise<Respuesta> {
    await sleep(250);
    const hist = mensajes.filter((m) => m.rol !== "sistema");
    let ultimoUsuario = -1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i]!.rol === "usuario") { ultimoUsuario = i; break; }
    const pedido = ultimoUsuario >= 0 ? (hist[ultimoUsuario] as { texto: string }).texto : "";
    const antes = hist.slice(0, Math.max(ultimoUsuario, 0));
    const despues = hist.slice(ultimoUsuario + 1);
    const usos = despues.flatMap((m) => (m.rol === "asistente" ? m.llamadas : []));
    const resultados = despues.flatMap((m) => (m.rol === "herramienta" ? m.resultados : []));
    const ultimo = resultados[resultados.length - 1];
    const n = usos.length;

    // Ultimo caso mencionado antes (para «confirmo» sin id).
    let casoPrevio: string | null = null;
    for (const m of antes) if (m.rol === "asistente") for (const l of m.llamadas) casoPrevio = (l.args as { caso?: string })?.caso ?? casoPrevio;
    const caso = extraerCaso(pedido) ?? casoPrevio;

    if (/^\s*(no\b|rechaz|cancel)/i.test(pedido) && /confirm|crea|rechaz|cancel/i.test(pedido)) return respuesta("Entendido: no creo la orden. Queda pendiente hasta que decidas.");
    if (!caso) return respuesta("Hola. Estás en modo simulado (sin modelo real). Prueba con «Procesa la solicitud sol-001» (también sol-002 a sol-006).");

    // Turno de confirmacion: el usuario escribio «confirmo» (o uso el boton).
    if (esConfirmacion(pedido)) {
      if (n === 0) return respuesta(`Creo la orden de ${caso} con tu confirmación.`, [llamar("oc_crear", { caso, confirmado: true })]);
      return this.final(caso, ultimo ? parse(ultimo.contenido) : {});
    }

    const sinCrear = /no la crees|no crees|sin crear/i.test(pedido);
    if (n === 0) return respuesta(`Voy a procesar ${caso}. Primero leo el paquete.`, [llamar("oc_leer_paquete", { caso })]);
    if (n === 1) return ultimo?.error ? respuesta(`No pude leer ${caso}: ${parse(ultimo.contenido).error}`) : respuesta("Paquete leído. Valido las reglas de control.", [llamar("oc_validar", { caso })]);
    const validacion = parse(resultados[1]?.contenido ?? "{}").data as { apta?: boolean; bloqueos?: { codigo: string; detalle: string; accion_sugerida?: string }[]; confirmaciones?: { codigo: string }[] } | undefined;
    if (!validacion) return respuesta("No pude validar el caso.");
    if (!validacion.apta) {
      const b = validacion.bloqueos ?? [];
      return respuesta(`No se crea la OC de ${caso}: ${b.map((x) => x.codigo).join(", ")}. ${b.map((x) => `${x.detalle} Acción sugerida: ${x.accion_sugerida}`).join(" ")}`);
    }
    const hayConf = (validacion.confirmaciones?.length ?? 0) > 0;
    if (n === 2) return respuesta("El caso es apto. Construyo el payload tal como quedaría en SAP.", [llamar("oc_construir_payload", { caso })]);
    if (hayConf || sinCrear) {
      const cods = (validacion.confirmaciones ?? []).map((c) => c.codigo).join(", ");
      return respuesta(hayConf ? `Hay confirmaciones pendientes (${cods}); el detalle con los valores está en la tarjeta de abajo. No creo la OC hasta que lo confirmes. ¿Confirmas la creación? Responde «confirmo» o usa el botón.` : "El caso es apto y no hay confirmaciones pendientes. No la creo porque me lo pediste; avísame cuando quieras crearla.");
    }
    if (n === 3) return respuesta("Sin confirmaciones pendientes: genero la evidencia de aprobación.", [llamar("oc_generar_evidencia", { caso })]);
    if (n === 4) return respuesta("Creo la orden de compra.", [llamar("oc_crear", { caso })]);
    return this.final(caso, ultimo ? parse(ultimo.contenido) : {});
  }

  private final(caso: string, r: Salida): Respuesta {
    if (r.ok) {
      const d = r.data ?? {};
      if (d.idempotente) return respuesta(`${caso} ya tenía la OC ${String(d.numero_oc)}; no se creó otra (idempotencia).`);
      return respuesta(`Listo: OC ${String(d.numero_oc)} creada en SAP (simulado) para ${caso}. Evidencia: ${String(d.evidencia)}.`);
    }
    return respuesta(`No se creó la OC de ${caso}: ${r.error ?? "error desconocido"}`);
  }
}
