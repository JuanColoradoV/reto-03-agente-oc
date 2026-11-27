// DISENO (NO CONECTADO: no esta en wrangler.jsonc ni lo exporta `src/index.ts`): Durable Object con clave `solicitudId` que actua
// como candado global y almacen del estado de idempotencia de UNA solicitud (ver idempotencia.ts).
// Para conectarlo: declarar el binding + migracion en wrangler.jsonc, exportarlo desde src/index.ts y construir
// `new S4HanaSap({ ..., store: new DoSolicitudStore(env.SOLICITUDES) })`.
import { DurableObject } from "cloudflare:workers";
import type { RegistroSolicitud, SolicitudStateStore } from "./idempotencia";

const KEY = "registro";

export class SolicitudDO extends DurableObject {
  // Cada metodo es una transaccion sobre el almacenamiento de ESTE objeto: las llamadas de distintas sesiones se serializan.
  iniciar(solicitudId: string, intentoId: string, payloadHash: string, ahora: number): Promise<{ propietario: boolean; registro: RegistroSolicitud }> {
    return this.ctx.storage.transaction(async (tx) => {
      const ex = await tx.get<RegistroSolicitud>(KEY);
      if (ex) return { propietario: false, registro: ex };
      const registro: RegistroSolicitud = { solicitudId, estado: "EN_PROCESO", intentoId, payloadHash, actualizadoEn: ahora };
      await tx.put(KEY, registro);
      return { propietario: true, registro };
    });
  }
  marcar(_solicitudId: string, estado: "CREADA" | "INCIERTA", datos: { numero?: string; motivo?: string }, ahora: number): Promise<RegistroSolicitud | null> {
    return this.ctx.storage.transaction(async (tx) => {
      const ex = await tx.get<RegistroSolicitud>(KEY);
      if (!ex || ex.estado === "CREADA") return ex ?? null;
      const nuevo: RegistroSolicitud = { ...ex, estado, ...(datos.numero ? { numero: datos.numero } : {}), ...(datos.motivo ? { motivo: datos.motivo } : {}), actualizadoEn: ahora };
      await tx.put(KEY, nuevo);
      return nuevo;
    });
  }
  liberar(_solicitudId: string, intentoId: string): Promise<void> {
    return this.ctx.storage.transaction(async (tx) => {
      const ex = await tx.get<RegistroSolicitud>(KEY);
      if (ex && ex.estado === "EN_PROCESO" && ex.intentoId === intentoId) await tx.delete(KEY);
    });
  }
  async obtener(_solicitudId: string): Promise<RegistroSolicitud | null> {
    return (await this.ctx.storage.get<RegistroSolicitud>(KEY)) ?? null;
  }
}

/** Cliente: enruta cada operacion al DO de su solicitud (idFromName(solicitudId)). */
export class DoSolicitudStore implements SolicitudStateStore {
  constructor(private ns: DurableObjectNamespace<SolicitudDO>) {}
  private stub(solicitudId: string) {
    return this.ns.get(this.ns.idFromName(solicitudId));
  }
  iniciar(solicitudId: string, intentoId: string, payloadHash: string, ahora: number) {
    return this.stub(solicitudId).iniciar(solicitudId, intentoId, payloadHash, ahora);
  }
  marcar(solicitudId: string, estado: "CREADA" | "INCIERTA", datos: { numero?: string; motivo?: string }, ahora: number) {
    return this.stub(solicitudId).marcar(solicitudId, estado, datos, ahora);
  }
  liberar(solicitudId: string, intentoId: string) {
    return this.stub(solicitudId).liberar(solicitudId, intentoId);
  }
  obtener(solicitudId: string) {
    return this.stub(solicitudId).obtener(solicitudId);
  }
}
