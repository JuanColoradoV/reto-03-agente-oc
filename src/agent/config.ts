// Configuración del ciclo del agente (PRD 6.3 y 8-Costo): topes configurables por variables de entorno.
export interface ConfigCiclo {
  /** Iteraciones herramienta -> modelo por turno (CA1). */
  iterMax: number;
  /** Tokens (entrada + salida) acumulados por sesión. */
  tokensSesionMax: number;
  /** Timeout de cada llamada al modelo (ms). */
  llmTimeoutMs: number;
  /** max_tokens de cada respuesta. */
  maxTokensRespuesta: number;
}

export const CONFIG_POR_DEFECTO: ConfigCiclo = { iterMax: 25, tokensSesionMax: 400_000, llmTimeoutMs: 90_000, maxTokensRespuesta: 8192 };

export interface EnvConfig {
  ITER_MAX?: string;
  TOKENS_SESION_MAX?: string;
  LLM_TIMEOUT_MS?: string;
}

const entero = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n > 0 ? n : def;
};

export function configDesdeEnv(env: EnvConfig): ConfigCiclo {
  return {
    ...CONFIG_POR_DEFECTO,
    iterMax: entero(env.ITER_MAX, CONFIG_POR_DEFECTO.iterMax),
    tokensSesionMax: entero(env.TOKENS_SESION_MAX, CONFIG_POR_DEFECTO.tokensSesionMax),
    llmTimeoutMs: entero(env.LLM_TIMEOUT_MS, CONFIG_POR_DEFECTO.llmTimeoutMs),
  };
}
