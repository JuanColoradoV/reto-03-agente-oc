// Construcción del payload OrdenCompra (PRD 7.4) con trazabilidad campo a campo (HU-3).
import { hashEvidencia } from "./evidencia";
import { emailDe } from "./parsers";
import { resolverProveedor } from "./reglas";
import { OrdenCompraSchema, type CampoTraza, type Maestros, type OrdenCompra, type Paquete, type Validacion } from "./tipos";

export type UnidadSap = "UN" | "H" | "MES";

/** Unidad de medida derivada del texto del ítem de la cotización (o de la descripción): horas -> H, mensual -> MES, resto -> UN. */
export function derivarUnidad(p: Paquete): UnidadSap {
  const item = p.cotizacion?.texto.match(/^1\.\s*([^|\n]+)/m)?.[1] ?? p.solicitud.descripcion;
  if (/\bhoras?\b/i.test(item)) return "H";
  if (/\b(mensual|mes)\b/i.test(item)) return "MES";
  return "UN";
}

export const textoBreve = (d: string): string => d.trim().slice(0, 40).trimEnd();

export type ResultadoPayload = { ok: true; payload: OrdenCompra; trazabilidad: CampoTraza[] } | { ok: false; error: string };

export async function construirOrden(args: { paquete: Paquete; maestros: Maestros; validacion: Validacion; confirmadoPor: string | null }): Promise<ResultadoPayload> {
  const { paquete: p, maestros: m, validacion: v, confirmadoPor } = args;
  if (!v.apta) return { ok: false, error: `El caso no es apto para crear OC: ${v.bloqueos.map((b) => b.codigo).join(", ")}.` };
  const prov = resolverProveedor(p, m);
  const apr = p.aprobacion;
  if (!prov || !apr) return { ok: false, error: "Faltan proveedor o aprobación para construir el payload." };
  const s = p.solicitud;
  const sha = await hashEvidencia(apr);

  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago ?? prov.condiciones_pago_default;
  const iva = s.indicador_iva ?? v.derivados.indicador_iva ?? prov.indicador_iva_default;
  const unidad = derivarUnidad(p);
  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: emailDe(apr.de), fecha_aprobacion: apr.fecha, evidencia_sha256: sha },
    posiciones: [
      { numero: 10, descripcion: textoBreve(s.descripcion), cantidad: s.cantidad, unidad, precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: iva },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: confirmadoPor })),
  };
  const valido = OrdenCompraSchema.safeParse(orden);
  if (!valido.success) return { ok: false, error: `Payload inválido: ${valido.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };

  const t = (campo: string, valor: unknown, fuente: CampoTraza["fuente"], detalle?: string): CampoTraza => ({ campo, valor, fuente, ...(detalle ? { detalle } : {}) });
  const trazabilidad: CampoTraza[] = [
    t("referencia.solicitud_id", orden.referencia.solicitud_id, "solicitud"),
    t("referencia.correo_id", orden.referencia.correo_id, "solicitud", "id del correo que trae la solicitud (correo.json)"),
    t("referencia.cotizacion_ref", orden.referencia.cotizacion_ref, "cotizacion"),
    t("sociedad", "1000", "derivado", "constante del proceso (PRD 7.4)"),
    t("organizacion_compras", "1000", "derivado", "constante del proceso (PRD 7.4)"),
    t("proveedor.codigo_sap", prov.codigo_sap, "maestro.proveedores"),
    t("proveedor.nit", prov.nit, "maestro.proveedores"),
    t("proveedor.nombre", prov.nombre, "maestro.proveedores"),
    t("moneda", s.moneda, "solicitud"),
    s.condiciones_pago ? t("condiciones_pago", pago, "solicitud") : t("condiciones_pago", pago, "derivado", "maestro.proveedores.condiciones_pago_default (RC7)"),
    t("aprobador.email", orden.aprobador.email, "solicitud", "remitente del correo de aprobación (aprobacion.json)"),
    t("aprobador.fecha_aprobacion", apr.fecha, "solicitud", "aprobacion.json"),
    t("aprobador.evidencia_sha256", sha, "derivado", "sha256 de out/<caso>/aprobacion.txt (encabezados + cuerpo)"),
    t("posiciones[0].numero", 10, "derivado", "consecutivo de posición"),
    t("posiciones[0].descripcion", orden.posiciones[0]!.descripcion, "solicitud", "descripcion recortada a 40 caracteres (texto breve SAP)"),
    t("posiciones[0].cantidad", s.cantidad, "solicitud"),
    t("posiciones[0].unidad", unidad, "derivado", "inferida del ítem de la cotización (hora -> H, mes -> MES, otro -> UN)"),
    t("posiciones[0].precio_unitario", s.valor_unitario, "solicitud"),
    t("posiciones[0].centro_costo", s.centro_costo, "solicitud"),
    t("posiciones[0].subarea", s.subarea, "solicitud"),
    s.indicador_iva ? t("posiciones[0].indicador_iva", iva, "solicitud") : t("posiciones[0].indicador_iva", iva, "derivado", "maestro.proveedores.indicador_iva_default (RC6)"),
    ...orden.excepciones.map((e, i) => t(`excepciones[${i}]`, e, "derivado", `confirmación ${e.codigo} de oc_validar`)),
  ];
  return { ok: true, payload: orden, trazabilidad };
}
