// Lectura y normalización del paquete de un caso (PRD 7.2) y carga de maestros.
import { z } from "zod";
import { CASO_RE, type FuenteFixtures } from "./fixtures";
import { aprobacionDesdeJson, parseCotizacion, parseFactura } from "./parsers";
import { AprobacionJsonSchema, CorreoSchema, SolicitudSchema, type Maestros, type Paquete } from "./tipos";

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string };

async function json(fuente: FuenteFixtures, rel: string): Promise<Resultado<unknown | null>> {
  const txt = await fuente.leer(rel);
  if (txt === null) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(txt) };
  } catch {
    return { ok: false, error: `${rel.split("/").pop()}: JSON malformado.` };
  }
}

const detalleZod = (e: z.ZodError): string => e.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");

export async function leerPaquete(fuente: FuenteFixtures, caso: string): Promise<Resultado<Paquete>> {
  if (!CASO_RE.test(caso)) return { ok: false, error: `Identificador de caso inválido: «${caso}».` };
  const dir = `solicitudes/${caso}/`;
  const casos = await fuente.listarCasos();
  if (!casos.includes(caso)) return { ok: false, error: `No existe el caso «${caso}». Casos disponibles: ${casos.join(", ")}.` };

  const faltantes: string[] = [];
  const correoJ = await json(fuente, dir + "correo.json");
  if (!correoJ.ok) return correoJ;
  const solJ = await json(fuente, dir + "solicitud.json");
  if (!solJ.ok) return solJ;
  if (correoJ.data === null) return { ok: false, error: "Paquete incompleto: falta correo.json. Pide al solicitante que reenvíe el correo original." };
  if (solJ.data === null) return { ok: false, error: "Paquete incompleto: falta solicitud (solicitud.xlsx / solicitud.json). Pide al solicitante que adjunte la solicitud." };

  const correo = CorreoSchema.safeParse(correoJ.data);
  if (!correo.success) return { ok: false, error: `correo.json inválido: ${detalleZod(correo.error)}` };
  const solicitud = SolicitudSchema.safeParse(solJ.data);
  if (!solicitud.success) return { ok: false, error: `solicitud inválida (¿monto no numérico o campo faltante?): ${detalleZod(solicitud.error)}. Pide al solicitante que corrija el Excel.` };

  const cotTxt = await fuente.leer(dir + "cotizacion.txt");
  let cotizacion: Paquete["cotizacion"] = null;
  if (cotTxt === null) faltantes.push("cotizacion.txt");
  else {
    const c = parseCotizacion(cotTxt);
    if (!c.ok) return { ok: false, error: c.error };
    cotizacion = c.valor;
  }

  const aprJ = await json(fuente, dir + "aprobacion.json");
  if (!aprJ.ok) return aprJ;
  let aprobacion: Paquete["aprobacion"] = null;
  if (aprJ.data === null) faltantes.push("aprobacion.json");
  else {
    const a = AprobacionJsonSchema.safeParse(aprJ.data);
    if (!a.success) return { ok: false, error: `aprobacion.json inválido: ${detalleZod(a.error)}` };
    aprobacion = aprobacionDesdeJson(a.data);
  }

  const facTxt = await fuente.leer(dir + "factura.txt");
  let factura: Paquete["factura"] = null;
  if (facTxt !== null) {
    const f = parseFactura(facTxt);
    if (!f.ok) return { ok: false, error: f.error };
    factura = f.valor;
  } // la factura es opcional: su ausencia no es un faltante

  const { id, de, asunto, fecha } = correo.data;
  return { ok: true, data: { correo: { id, de, asunto, fecha }, solicitud: solicitud.data, cotizacion, aprobacion, factura, faltantes } };
}

export async function cargarMaestros(fuente: FuenteFixtures): Promise<Resultado<Maestros>> {
  const nombres = ["proveedores", "centros-costo", "indicadores-iva", "condiciones-pago"] as const;
  const out: unknown[] = [];
  for (const n of nombres) {
    const r = await json(fuente, `maestros/${n}.json`);
    if (!r.ok) return r;
    if (!Array.isArray(r.data)) return { ok: false, error: `Maestro ${n}.json no disponible.` };
    out.push(r.data);
  }
  const [proveedores, centros_costo, indicadores_iva, condiciones_pago] = out as [Maestros["proveedores"], Maestros["centros_costo"], Maestros["indicadores_iva"], Maestros["condiciones_pago"]];
  return { ok: true, data: { proveedores, centros_costo, indicadores_iva, condiciones_pago } };
}
