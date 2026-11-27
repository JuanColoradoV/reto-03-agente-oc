// Compuerta de tema: clasificador DETERMINISTA del mensaje del usuario, antes de cualquier llamada al modelo.
// Lo que no trata de solicitudes de orden de compra / este agente se responde con texto fijo (costo cero) y cuenta como "strike".
// No es una defensa total (alguien puede colar una palabra del dominio): es la primera capa; despues vienen el prompt del sistema,
// las herramientas acotadas, los topes de tokens por sesion, el tope por IP y el presupuesto global.

export type Veredicto = "ok" | "saludo" | "fuera";

export const MSG_FUERA = "Solo puedo ayudarte con solicitudes de órdenes de compra: prueba 'Procesa la solicitud sol-001'.";
export const MSG_AYUDA =
  "Hola, soy el agente de órdenes de compra. Puedo procesar las solicitudes sol-001 a sol-006: leo la solicitud y sus documentos, valido los controles (RC1–RC10), " +
  "te muestro la OC tal como quedaría en SAP y, solo si tú lo confirmas, la creo. Prueba: 'Procesa la solicitud sol-001' o 'Procesa sol-004 y no la crees hasta que yo confirme'.";

/** Minusculas y sin tildes (la ñ se conserva como n: irrelevante para este uso). */
export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Intentos obvios de cambiar el rol / extraer el prompt: se rechazan aunque el mensaje mencione una OC.
const INYECCION =
  /\b(ignor\w*|olvida\w*|omite|desconsidera|disregard|forget)\b.{0,40}\b(instruccion\w*|reglas|prompt|instructions|rules)\b|\bsystem ?prompt\b|\bprompt (del )?sistema\b|\bjailbreak\b|\bmodo (dios|desarrollador)\b|\bdeveloper mode\b|\b(actua|actuar|compor\w+|finge|pretend|act) (como|as)\b|\beres ahora\b|\byou are now\b|\brevela\w* (tu|el) (prompt|instruccion\w*)\b/;

// Palabras del dominio que bastan por si solas (sobre texto normalizado).
const FUERTES = new RegExp(
  [
    String.raw`\bsol(icitud\w*)?[- ]?(\d{1,3}|2026[- ]?\d{1,3})\b`,
    String.raw`\bsol-2026-\d+\b`,
    String.raw`\bsolicitud\w*`,
    String.raw`\bordenes? de compras?\b`,
    String.raw`\borden(es)?\b`,
    String.raw`\bocs?\b`,
    String.raw`\bcompras?\b`,
    String.raw`\bproveedor\w*`,
    String.raw`\bcotizacion\w*`,
    String.raw`\baprobacion\w*`,
    String.raw`\baprobador\w*`,
    String.raw`\bapru?eba\w*`,
    String.raw`\bfacturas?\b`,
    String.raw`\bretroactiv\w*`,
    String.raw`\biva\b`,
    String.raw`\bcentros? de costos?\b`,
    String.raw`\bsub-?areas?\b`,
    String.raw`\bpayload\b`,
    String.raw`\bsap\b`,
    String.raw`\bcontroles?\b`,
    String.raw`\breglas?\b`,
    String.raw`\brc ?(10|[1-9])\b`,
    String.raw`\bbloqueo\w*`,
    String.raw`\bbloquead\w*`,
    String.raw`\btrazabilidad\b`,
    String.raw`\bevidencias?\b`,
    String.raw`\bpedidos?\b`,
    String.raw`\bpresupuesto\b`,
    String.raw`\bauditoria\b`,
    String.raw`\b(purchase orders?|purchase requests?|supplier|vendor|invoice|quotation|quote|approval|approver|cost cent(er|re)|retroactive|traceability|evidence)\b`,
  ].join("|"),
);

// Palabras genericas: solas no bastan (evita "procesa un poema"); dos o mas distintas si.
const DEBILES = ["procesa", "procesar", "valida", "validar", "crea", "crear", "muestra", "muestrame", "caso", "casos", "confirm", "confirmo", "confirmacion", "process", "validate", "create", "show", "request", "case"];

// Peticiones tipicas de uso como LLM general: si no hay palabra fuerte del dominio, se rechazan de plano.
const AJENO = /\b(poema|poesia|cancion|chiste|cuento|historia de|receta|traduce|traducir|translate|codigo|programa|script|python|javascript|html|resume el|ensayo|tarea de|horoscopo|clima|noticias|futbol|pelicula|capital de|quien (fue|gano)|dibuja|imagen)\b/;

const SALUDO = /^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches|hello|hi|hey|ayuda|help|que puedes hacer|que haces|que sabes hacer|como funciona|como te uso|como usarte|quien eres|que eres|gracias|thanks|menu|opciones|instrucciones|ejemplos?)\b[\s\S]{0,40}$/;

// Respuesta a una confirmacion pendiente (solo valida si la sesion tiene una).
const RESPUESTA = /^(si|sii+|sí|confirmo|confirmar|no|rechazo|rechazar|rechazado|cancela|cancelar|cancelo|ok|dale|adelante|apruebo|de acuerdo|yes|no confirmo|no la crees|no lo crees|no gracias)\b/;
export const pareceRespuesta = (mensaje: string): boolean => {
  const t = normalizar(mensaje);
  return t.length <= 140 && RESPUESTA.test(t);
};

/** `pendiente`: la sesion espera una confirmacion humana (lo decide el servidor, no el cliente). */
export function clasificar(mensaje: string, pendiente: boolean): Veredicto {
  const t = normalizar(mensaje);
  if (!t) return "fuera";
  if (INYECCION.test(t)) return "fuera";
  if (FUERTES.test(t)) return "ok";
  if (pendiente && t.length <= 140 && RESPUESTA.test(t)) return "ok";
  if (t.length <= 60 && SALUDO.test(t)) return "saludo";
  if (AJENO.test(t)) return "fuera";
  const hits = new Set(DEBILES.filter((w) => new RegExp(`\\b${w}`).test(t)));
  return hits.size >= 2 ? "ok" : "fuera";
}
