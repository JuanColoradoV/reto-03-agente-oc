// Errores de NEGOCIO: su mensaje es seguro y util para la persona y para el modelo (se muestra tal cual).
// Cualquier otro error lanzado por una herramienta es TECNICO: se registra en el servidor y al cliente solo llega
// un mensaje generico con codigo y referencia (ver src/tools/registry.ts).
export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}

/** Codigos usados por la logica del agente (el resto son libres). */
export const CODIGO = {
  CONTROLES_FALLA: "CONTROLES_FALLA",
  SOLICITUD_NO_ENCONTRADA: "SOLICITUD_NO_ENCONTRADA",
  APROBACION_OBSOLETA: "APROBACION_OBSOLETA",
  ERROR_TECNICO: "ERROR_TECNICO",
} as const;

/** Mensaje al invalidarse una aprobacion porque cambiaron los datos o controles que la persona vio. */
export const MSG_APROBACION_OBSOLETA = "Los datos o controles cambiaron desde que los viste; revisa de nuevo. La aprobación anterior ya no vale: se requiere una nueva.";
