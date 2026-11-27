// Reglas de control RC1-RC10 (PRD 7.3) como REGISTRO de datos+funciones: agregar o cambiar una regla no toca el servidor
// ni el prompt. Cada regla devuelve cero o más resultados; el motor los clasifica en bloqueos, confirmaciones y derivados.
import { emailDe, normalizarNit } from "./parsers";
import type { Derivados, Hallazgo, Maestros, Paquete, Proveedor, Validacion } from "./tipos";
import { formatoMonto, soloFecha, toMinor } from "./util";

export interface ContextoRegla {
  paquete: Paquete;
  maestros: Maestros;
  proveedor: Proveedor | null;
}

export type Resultado =
  | { tipo: "bloqueo" | "confirmacion"; hallazgo: Hallazgo }
  | { tipo: "derivado"; campo: keyof Derivados; valor: string }
  | { tipo: "retroactiva" };

export interface Regla {
  codigo: string;
  tipo: "bloqueo" | "confirmacion" | "derivado";
  titulo: string;
  evaluar(ctx: ContextoRegla): Resultado[];
}

/** Tolerancia de RC5 en porcentaje entero (la comparación se hace con enteros, sin floats). */
export const TOLERANCIA_COTIZACION_PCT = 2;

const normNombre = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Proveedor del maestro: por NIT; si la solicitud no trae NIT, por nombre normalizado (RC1). */
export function resolverProveedor(p: Paquete, m: Maestros): Proveedor | null {
  const nit = p.solicitud.proveedor_nit ? normalizarNit(p.solicitud.proveedor_nit) : "";
  if (nit) return m.proveedores.find((x) => x.nit === nit) ?? null;
  const nombre = normNombre(p.solicitud.proveedor_nombre);
  return m.proveedores.find((x) => normNombre(x.nombre) === nombre) ?? null;
}

const bloqueo = (codigo: string, detalle: string, accion_sugerida: string): Resultado => ({ tipo: "bloqueo", hallazgo: { codigo, detalle, accion_sugerida } });
const confirmacion = (codigo: string, detalle: string, valores?: Hallazgo["valores"]): Resultado => ({ tipo: "confirmacion", hallazgo: { codigo, detalle, ...(valores ? { valores } : {}) } });

function aprobadorDelCentro(c: ContextoRegla) {
  const a = c.paquete.aprobacion;
  const centro = c.maestros.centros_costo.find((x) => x.centro_costo === c.paquete.solicitud.centro_costo);
  const email = a ? emailDe(a.de) : null;
  const entrada = centro?.aprobadores.find((x) => x.email.toLowerCase() === email) ?? null;
  return { centro, email, entrada };
}

export const REGLAS: Regla[] = [
  {
    codigo: "RC1",
    tipo: "bloqueo",
    titulo: "Proveedor existe en el maestro y está activo",
    evaluar({ paquete: { solicitud: s }, proveedor }) {
      const ref = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre «${s.proveedor_nombre}»`;
      if (!proveedor) return [bloqueo("RC1", `El proveedor ${s.proveedor_nombre} (${ref}) no existe en el maestro de proveedores.`, "Solicitar el alta del proveedor en SAP (maestro de proveedores) y reintentar; o verificar el NIT con el solicitante.")];
      if (!proveedor.activo) return [bloqueo("RC1", `El proveedor ${proveedor.nombre} (${ref}) está inactivo en el maestro.`, "Pedir a compras la reactivación del proveedor o elegir otro proveedor.")];
      return [];
    },
  },
  {
    codigo: "RC2",
    tipo: "bloqueo",
    titulo: "Aprobación existe, dice «Aprobado» y viene de un aprobador del centro de costo",
    evaluar(c) {
      const a = c.paquete.aprobacion;
      const cc = c.paquete.solicitud.centro_costo;
      if (!a) return [bloqueo("RC2", "No hay correo de aprobación en el paquete.", "Pedir al solicitante el correo de aprobación del líder.")];
      if (!a.aprobado) return [bloqueo("RC2", `El correo de ${a.de} no contiene «Aprobado».`, "Pedir al líder una aprobación explícita.")];
      const { centro, entrada } = aprobadorDelCentro(c);
      if (!centro) return [bloqueo("RC2", `El centro de costo ${cc} no existe en el maestro.`, "Corregir el centro de costo en la solicitud.")];
      if (!entrada) return [bloqueo("RC2", `${a.de} no figura como aprobador del centro de costo ${cc} (aprobadores: ${centro.aprobadores.map((x) => x.email).join(", ")}).`, `Obtener la aprobación de un aprobador autorizado de ${cc}.`)];
      return [];
    },
  },
  {
    codigo: "RC3",
    tipo: "bloqueo",
    titulo: "El valor total no supera el tope del aprobador",
    evaluar(c) {
      const a = c.paquete.aprobacion;
      if (!a || !a.aprobado) return []; // lo cubre RC2
      const s = c.paquete.solicitud;
      const { centro, entrada } = aprobadorDelCentro(c);
      if (!centro) return [];
      if (!entrada) {
        const max = Math.max(...centro.aprobadores.map((x) => x.tope));
        return [bloqueo("RC3", `${a.de} no tiene tope autorizado en ${s.centro_costo}; el valor ${formatoMonto(s.valor_total, s.moneda)} requiere un aprobador del centro (tope máximo ${formatoMonto(max, s.moneda)}).`, "Escalar a un aprobador del centro con tope suficiente.")];
      }
      if (toMinor(s.valor_total) > toMinor(entrada.tope)) {
        return [bloqueo("RC3", `El valor ${formatoMonto(s.valor_total, s.moneda)} supera el tope de ${a.de} (${formatoMonto(entrada.tope, s.moneda)}).`, "Escalar la aprobación a un aprobador con tope suficiente.")];
      }
      return [];
    },
  },
  {
    codigo: "RC4",
    tipo: "bloqueo",
    titulo: "La subárea pertenece al centro de costo",
    evaluar(c) {
      const s = c.paquete.solicitud;
      const centro = c.maestros.centros_costo.find((x) => x.centro_costo === s.centro_costo);
      if (!centro) return [bloqueo("RC4", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Corregir el centro de costo en la solicitud.")];
      if (!centro.subareas.includes(s.subarea)) return [bloqueo("RC4", `La subárea «${s.subarea}» no pertenece a ${s.centro_costo} (subáreas: ${centro.subareas.join(", ")}).`, "Corregir la subárea o el centro de costo en la solicitud.")];
      return [];
    },
  },
  {
    codigo: "RC5",
    tipo: "confirmacion",
    titulo: "La cotización coincide con la solicitud (±2 %)",
    evaluar({ paquete: { solicitud: s, cotizacion: c } }) {
      if (!c) return [confirmacion("RC5", "No hay cotización en el paquete; el valor de la solicitud no se pudo contrastar.", { solicitud: s.valor_total })];
      const sol = toMinor(s.valor_total);
      const cot = toMinor(c.total);
      const dif = Math.abs(cot - sol);
      const monedaDistinta = c.moneda !== s.moneda;
      // dif/sol > 2 %  <=>  dif*100 > 2*sol (aritmética entera)
      const excede = sol === 0 ? dif > 0 : dif * 100 > TOLERANCIA_COTIZACION_PCT * sol;
      if (!excede && !monedaDistinta) return [];
      const pct = sol === 0 ? 100 : Math.round((dif / sol) * 10000) / 100;
      return [confirmacion("RC5", `La cotización (${formatoMonto(c.total, c.moneda)}) difiere de la solicitud (${formatoMonto(s.valor_total, s.moneda)}) en ${pct} %, por encima del 2 % tolerado${monedaDistinta ? " (y con moneda distinta)" : ""}.`, { solicitud: s.valor_total, cotizacion: c.total, diferencia_pct: pct, moneda_solicitud: s.moneda, moneda_cotizacion: c.moneda })];
    },
  },
  {
    codigo: "RC6",
    tipo: "confirmacion",
    titulo: "Indicador de IVA informado (si no, se deriva del proveedor y se confirma)",
    evaluar({ paquete: { solicitud: s }, proveedor }) {
      if (s.indicador_iva || !proveedor) return [];
      return [
        { tipo: "derivado", campo: "indicador_iva", valor: proveedor.indicador_iva_default },
        confirmacion("RC6", `La solicitud no informa el indicador de IVA; se derivó ${proveedor.indicador_iva_default} del maestro del proveedor ${proveedor.nombre}.`, { indicador_iva_derivado: proveedor.indicador_iva_default }),
      ];
    },
  },
  {
    codigo: "RC7",
    tipo: "derivado",
    titulo: "Condiciones de pago (si faltan, se derivan del proveedor)",
    evaluar({ paquete: { solicitud: s }, proveedor }) {
      if (s.condiciones_pago || !proveedor) return [];
      return [{ tipo: "derivado", campo: "condiciones_pago", valor: proveedor.condiciones_pago_default }];
    },
  },
  {
    codigo: "RC8",
    tipo: "confirmacion",
    titulo: "Factura anterior a la solicitud (OC retroactiva)",
    evaluar({ paquete: { solicitud: s, factura: f } }) {
      if (!f || soloFecha(f.fecha) >= soloFecha(s.fecha_solicitud)) return [];
      return [
        { tipo: "retroactiva" },
        confirmacion("RC8", `OC retroactiva: la factura ${f.numero} (${soloFecha(f.fecha)}) es anterior a la solicitud (${soloFecha(s.fecha_solicitud)}).`, { factura: f.numero, fecha_factura: soloFecha(f.fecha), fecha_solicitud: soloFecha(s.fecha_solicitud) }),
      ];
    },
  },
  {
    codigo: "RC9",
    tipo: "confirmacion",
    titulo: "La aprobación es de fecha igual o posterior a la solicitud",
    evaluar({ paquete: { solicitud: s, aprobacion: a } }) {
      if (!a || soloFecha(a.fecha) >= soloFecha(s.fecha_solicitud)) return [];
      return [confirmacion("RC9", `La aprobación (${soloFecha(a.fecha)}) es anterior a la solicitud (${soloFecha(s.fecha_solicitud)}).`, { fecha_aprobacion: soloFecha(a.fecha), fecha_solicitud: soloFecha(s.fecha_solicitud) })];
    },
  },
  {
    codigo: "RC10",
    tipo: "bloqueo",
    titulo: "cantidad × valor unitario = valor total (±1 unidad monetaria)",
    evaluar({ paquete: { solicitud: s } }) {
      const calculado = Math.round(s.cantidad * s.valor_unitario * 100);
      if (Math.abs(calculado - toMinor(s.valor_total)) <= 100) return [];
      return [bloqueo("RC10", `${s.cantidad} × ${formatoMonto(s.valor_unitario, s.moneda)} = ${formatoMonto(calculado / 100, s.moneda)}, pero el valor total de la solicitud es ${formatoMonto(s.valor_total, s.moneda)}.`, "Pedir al solicitante que corrija cantidad, valor unitario o valor total.")];
    },
  },
];

export function validar(paquete: Paquete, maestros: Maestros): Validacion {
  const ctx: ContextoRegla = { paquete, maestros, proveedor: resolverProveedor(paquete, maestros) };
  const v: Validacion = { apta: true, bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false };
  for (const regla of REGLAS) {
    for (const r of regla.evaluar(ctx)) {
      if (r.tipo === "bloqueo") v.bloqueos.push(r.hallazgo);
      else if (r.tipo === "confirmacion") v.confirmaciones.push(r.hallazgo);
      else if (r.tipo === "derivado") v.derivados[r.campo] = r.valor;
      else v.retroactiva = true;
    }
  }
  v.apta = v.bloqueos.length === 0;
  return v;
}
