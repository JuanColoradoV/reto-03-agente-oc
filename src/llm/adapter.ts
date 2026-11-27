// Adaptador LLM (PRD 6.1): tipos neutrales + interfaz `enviar(mensajes, herramientas) -> respuesta`.
// El ciclo del agente solo depende de este archivo: cambiar de proveedor = otra implementación de LlmAdapter.

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  args: unknown;
}

export interface ResultadoHerramienta {
  id: string;
  nombre: string;
  /** JSON devuelto por la herramienta. */
  contenido: string;
  error: boolean;
}

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  /** `opaco`: bloques originales del proveedor (p. ej. razonamiento) que solo su adaptador interpreta, para reenviarlos intactos. */
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; opaco?: unknown }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] };

export interface DefinicionHerramienta {
  nombre: string;
  descripcion: string;
  /** JSON Schema del objeto de argumentos. */
  esquema: Record<string, unknown>;
}

export interface Uso {
  entrada: number;
  salida: number;
  cacheLeida: number;
  cacheEscrita: number;
}

export type MotivoFin = "fin" | "herramientas" | "limite_tokens" | "rechazo" | "otro";

export interface Respuesta {
  texto: string;
  llamadas: LlamadaHerramienta[];
  fin: MotivoFin;
  uso: Uso;
  opaco?: unknown;
}

export interface OpcionesEnvio {
  maxTokens?: number;
  /** true: el modelo no puede llamar herramientas en esta respuesta (resumen final). */
  sinHerramientas?: boolean;
  signal?: AbortSignal;
}

export interface LlmAdapter {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones?: OpcionesEnvio): Promise<Respuesta>;
}

export type CodigoErrorLlm = "timeout" | "clave" | "limite" | "contexto" | "proveedor";

/** Error del proveedor ya clasificado: el ciclo lo traduce a un mensaje claro para el chat. */
export class ErrorLlm extends Error {
  constructor(
    public codigo: CodigoErrorLlm,
    message: string,
  ) {
    super(message);
  }
}

export const usoVacio = (): Uso => ({ entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 });
