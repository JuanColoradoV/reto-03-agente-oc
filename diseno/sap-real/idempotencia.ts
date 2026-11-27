// DISENO (NO CONECTADO): estado persistido por solicitud para crear la OC en un SAP real SIN duplicar.
//
// Por que hace falta: en un SAP real un POST puede haberse ejecutado aunque el cliente no lo sepa (corte de red, timeout, 5xx).
// Un GET inmediato puede no verlo todavia (SAP sigue procesando) y dos sesiones/instancias pueden pasar a la vez la consulta
// previa. Por eso cada solicitud tiene UN registro con una maquina de estados, y quien "gana" el registro es el unico que puede
// enviar el POST:
//
//   (sin registro) --iniciar--> EN_PROCESO --POST ok--> CREADA            (terminal)
//                                   |--SAP rechazo definitivo / no se envio--> (sin registro: se puede corregir y reintentar)
//                                   |--resultado ambiguo (red, timeout, 5xx)--> INCIERTA --reconciliar: la OC aparece por
//                                                                                          referencia externa--> CREADA
//
// Reglas: (1) nunca se reenvia un POST desde INCIERTA; solo se consulta por referencia externa (GET es seguro de repetir);
// (2) EN_PROCESO caducado (el proceso murio) se trata como INCIERTA; (3) la coordinacion global es un Durable Object con clave
// `solicitudId` (ver solicitud-do.ts): su almacenamiento serializa las transiciones entre sesiones e instancias.
//
// LIMITE HONESTO: esto evita duplicados originados por ESTE agente. La garantia fuerte de unicidad debe estar tambien en SAP
// (p. ej. verificacion de la referencia externa dentro de la misma transaccion de creacion mediante una mejora/tabla Z).
// Eso es trabajo de Basis/ABAP y esta pendiente (ver SOLUCION.md > "garantias pendientes").

export type EstadoSolicitud = "EN_PROCESO" | "CREADA" | "INCIERTA";

export interface RegistroSolicitud {
  solicitudId: string;
  estado: EstadoSolicitud;
  /** Identifica al intento que posee el registro EN_PROCESO. */
  intentoId: string;
  /** Hash del payload enviado: permite distinguir "mismo pedido reintentado" de "otra OC para la misma solicitud". */
  payloadHash: string;
  /** Numero de OC (solo CREADA). */
  numero?: string;
  motivo?: string;
  /** epoch ms de la ultima transicion. */
  actualizadoEn: number;
}

/** Contrato de persistencia. Cada operacion debe ser ATOMICA y estar serializada por solicitud (un DO por solicitudId). */
export interface SolicitudStateStore {
  /** Si no hay registro, crea EN_PROCESO para `intentoId` y devuelve propietario=true; si lo hay, lo devuelve sin tocarlo. */
  iniciar(solicitudId: string, intentoId: string, payloadHash: string, ahora: number): Promise<{ propietario: boolean; registro: RegistroSolicitud }>;
  /** Transicion a CREADA o INCIERTA. Idempotente; CREADA nunca retrocede. */
  marcar(solicitudId: string, estado: "CREADA" | "INCIERTA", datos: { numero?: string; motivo?: string }, ahora: number): Promise<RegistroSolicitud | null>;
  /** Borra el registro SOLO si sigue EN_PROCESO y es de este intento (se sabe que no se grabo nada en SAP). */
  liberar(solicitudId: string, intentoId: string): Promise<void>;
  obtener(solicitudId: string): Promise<RegistroSolicitud | null>;
}

/** Implementacion en memoria (pruebas). La real es el DO por solicitudId. */
export class MemorySolicitudStore implements SolicitudStateStore {
  private m = new Map<string, RegistroSolicitud>();
  async iniciar(solicitudId: string, intentoId: string, payloadHash: string, ahora: number) {
    const ex = this.m.get(solicitudId);
    if (ex) return { propietario: false, registro: { ...ex } };
    const registro: RegistroSolicitud = { solicitudId, estado: "EN_PROCESO", intentoId, payloadHash, actualizadoEn: ahora };
    this.m.set(solicitudId, registro);
    return { propietario: true, registro: { ...registro } };
  }
  async marcar(solicitudId: string, estado: "CREADA" | "INCIERTA", datos: { numero?: string; motivo?: string }, ahora: number) {
    const ex = this.m.get(solicitudId);
    if (!ex || ex.estado === "CREADA") return ex ? { ...ex } : null;
    const nuevo: RegistroSolicitud = { ...ex, estado, ...(datos.numero ? { numero: datos.numero } : {}), ...(datos.motivo ? { motivo: datos.motivo } : {}), actualizadoEn: ahora };
    this.m.set(solicitudId, nuevo);
    return { ...nuevo };
  }
  async liberar(solicitudId: string, intentoId: string) {
    const ex = this.m.get(solicitudId);
    if (ex && ex.estado === "EN_PROCESO" && ex.intentoId === intentoId) this.m.delete(solicitudId);
  }
  async obtener(solicitudId: string) {
    const ex = this.m.get(solicitudId);
    return ex ? { ...ex } : null;
  }
}
