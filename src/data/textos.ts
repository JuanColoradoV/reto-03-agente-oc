// Textos del agente. Comportamiento = agent/prompt.md; conocimiento del proceso = src/knowledge/ordenes-compra.md (PRD 6.5).
// Decisión: el conocimiento se incorpora AL system prompt (cabe en ~2 k tokens y se cachea con él), así el modelo no gasta
// una iteración consultándolo. Ambos archivos viajan en el bundle generado (Workers no tiene fs).
import { FILES } from "./fixtures.generated";

const leer = (ruta: string): string => {
  const t = FILES[ruta];
  if (!t) throw new Error(`${ruta} no está en el bundle`);
  return t;
};

export const getPrompt = (): string => leer("agent/prompt.md");
export const getConocimiento = (): string => leer("src/knowledge/ordenes-compra.md");

export const getSystemPrompt = (): string => `${getPrompt().trim()}\n\n---\n\n# Conocimiento del proceso (referencia)\n\n${getConocimiento().trim()}\n`;
