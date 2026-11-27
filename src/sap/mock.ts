// SAP simulado sobre out/sap/ordenes.jsonl (una OC por línea). Números secuenciales desde 4500000001.
import type { Proveedor } from "../domain/tipos";
import type { OutStore } from "../out/store";
import type { OrdenCompra, SapAdapter } from "./adapter";

export const RUTA_ORDENES = "sap/ordenes.jsonl";
export const PRIMER_NUMERO = 4500000001;

interface Registro {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  orden: OrdenCompra;
}

export class SapMock implements SapAdapter {
  constructor(
    private store: OutStore,
    private proveedores: Proveedor[],
    private ahora: () => string = () => new Date().toISOString(),
  ) {}

  private async registros(): Promise<Registro[]> {
    const txt = (await this.store.leer(RUTA_ORDENES)) ?? "";
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro);
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const p = this.proveedores.find((x) => x.nit === nit);
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const regs = await this.registros();
    const numero_oc = String(PRIMER_NUMERO + regs.length);
    const fecha = this.ahora().slice(0, 10);
    const reg: Registro = { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden };
    await this.store.agregarLinea(RUTA_ORDENES, JSON.stringify(reg));
    return { numero_oc, fecha };
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha: string } | null> {
    const r = (await this.registros()).find((x) => x.solicitud_id === solicitud_id);
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null;
  }
}
