/** Fecha de negocio (YYYY-MM-DD) en la zona horaria del negocio: Colombia (UTC-5, sin horario de verano). */
export const ZONA_NEGOCIO = "America/Bogota";

/** `now` es inyectable para que las pruebas sean deterministas. */
export function fechaNegocio(now: Date = new Date(), tz: string = ZONA_NEGOCIO): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
