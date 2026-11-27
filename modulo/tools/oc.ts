// Herramientas del agente empaquetadas para otras plataformas de agentes.
// Re-exporta las MISMAS herramientas que usa la aplicacion (no es una copia): cada export `x` se expone como `oc_x`.
// Contrato: { description, args (zod), execute(args, ctx: { directory, sessionId }) -> Promise<string JSON {ok,data}|{ok:false,error}> }.
// No depende del servidor HTTP: solo de src/tools, src/domain, src/sap y src/knowledge.
export * from "../../src/tools/oc";
