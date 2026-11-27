// Costo ESTIMADO por turno. Precios USD por millon de tokens (tabla de precios de la API, 2026-11).
// Si cambia el modelo o la tarifa, actualizar aqui. El escritura-cache se asume TTL 5 min (1,25x entrada).
export const PRICING_USD_PER_MTOK = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Haiku 5.5 (extraccion, MODEL_HELPER): $0.10 / $0.50 hasta 100K tokens de prompt. Cache: 0,1x lectura y 1,25x escritura (misma razon que Sonnet).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
} as const;

export interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCostUsd(model: string, u: RawUsage): number {
  const p = (PRICING_USD_PER_MTOK as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>)[model];
  if (!p) return 0;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}
