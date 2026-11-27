# Reto 3 - Agente conversacional de órdenes de compra (SAP simulado)

TypeScript + Hono sobre Cloudflare Workers + un Durable Object por sesión de chat (frontend estático en `public/`). Agente con `@anthropic-ai/sdk` (Sonnet 5.5; helper opcional con Haiku 5.5) y confirmación humana obligatoria antes de crear una OC.

Documento de diseño y decisiones: [SOLUCION.md](./SOLUCION.md) (arquitectura, ciclo del agente, matriz de controles, diseño del adaptador SAP real, análisis de órdenes retroactivas).

## URL pública

(se publica al recibir el PRD)

## Requisitos

- **Node.js 20 o superior** (`engines` en `package.json`) y npm.
- Cuenta de Cloudflare solo para desplegar (`npx wrangler login`).

## Cómo correr

```bash
npm install
cp .dev.vars.example .dev.vars   # poner ANTHROPIC_API_KEY (sin clave la app arranca y la UI avisa en español)
npm run dev                      # wrangler dev -> http://localhost:8787
npm run demo                     # todos los casos SIN LLM, comparados con fixtures/reto-03/esperados.json (exit 1 si falla)
npm run demo -- --matriz         # matriz de controles en Markdown, derivada del código
npm test                         # node:test (tsx): HITL, preflight, bucle, dominio, demo, rutas
npm run check                    # typecheck + test + demo
```

## Desplegar

```bash
npx wrangler login                          # una sola vez: autentica wrangler con tu cuenta de Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # pega la clave cuando la pida (queda como secreto del Worker, nunca en el repo)
npm run deploy                              # bundle de fixtures + wrangler deploy
```

La clave local va en `.dev.vars` (ignorado por git). No se versionan secretos.

## Arquitectura

```
Navegador (public/app.js)                    Worker (src/index.ts)                 Durable Object SessionDO (1 por sesión)
 sessionId=UUID (sessionStorage)  --POST-->  valida zod, origen, rate limit  --->  src/session/routes.ts (Hono interno)
 {sessionId, mensaje}                        reenvía a idFromName(sessionId)        |
 {sessionId, pendingId, decision}                                                   v
 <==== SSE (eventos `ui` + `done`) =======================================   Session (src/session/session.ts)
 GET /api/sesion/:id        (restaura chat)                                         |  un turno a la vez; persiste tras cada paso
 GET /api/sesion/:id/traza | /auditoria (traza; informe JSON)                        v
 POST /api/sesion/:id/reset                                                  runAgentLoop / resolvePending (src/agent/loop.ts)
                                                                                    |-- Anthropic Messages (Sonnet 5.5, tool-use, caché de prompt)
                                                                                    |-- tools (src/tools/oc.ts) -> dominio puro (src/domain) -> SapAdapter
                                                                                    v
                                                      Estado en storage del DO: mensajes Anthropic, acción pendiente,
                                                      SAP simulado (OC + contador por sesión), audit log, eventos, traza
```

Decisiones clave:

- **El servidor guarda la conversación.** El cliente nunca envía historial: solo `{sessionId, mensaje}` o `{sessionId, pendingId, decision, comentario?}`. No hay forma de fabricar tool_use, ids duplicados ni historiales enormes.
- **HITL sin firma.** Al llamar `crear_orden_compra` el bucle valida la entrada con zod y ejecuta el `preflight` determinista (`prepararOrden`). Si falla o hay un control bloqueante, el error vuelve al modelo y la persona no se entera. Si pasa, se guarda la acción pendiente (con los datos del preflight) y se emite `pending_confirmation` con proveedor, centro de costo, líneas, total y la tabla de controles. La decisión solo vale si `pendingId` coincide con el pendiente guardado y se **consume** atómicamente (aprobar o rechazar, una vez): no hay repetición posible.
- **El servidor arma la OC** (`prepararOrden` en `src/domain/ordenes.ts`): el modelo solo indica `solicitudId`. Al aprobar, el handler revalida y compara con lo que la persona vio.
- **SAP simulado por sesión** (`InMemorySap` sobre el estado del DO): numeración 4500000001+ por sesión, `consultar_orden` siempre encuentra lo creado en esa sesión y los visitantes no se bloquean con DUPLICADA. La interfaz `SapAdapter` no cambia para el SAP real.
- **Robustez del bucle:** nunca queda un `tool_use` sin `tool_result` (reintento único con más `max_tokens`, luego se descarta el turno; saneo del historial; si falla el modelo tras ejecutar una tool, el resultado queda persistido y el siguiente turno continúa). `switch` exhaustivo sobre `stop_reason`. Al agotar iteraciones, llamada final sin herramientas (`tool_choice: none`).
- **Caché de prompt** en system + tools + último bloque del último mensaje. **Costo estimado** por turno (`src/agent/cost.ts`).
- **Observabilidad:** un log JSON por turno (traceId, sessionId, modelo, iteraciones, tools con latencia/ok, tokens, costo) y traza compacta en el DO (`/api/sesion/:id/traza`). Al cliente solo van errores genéricos con un id de correlación; el detalle va a `console.error`.
- **Auditoría descargable.** `GET /api/sesion/:id/auditoria` devuelve un JSON por solicitud: controles con su resultado, decisión (aprobar/rechazar) con comentario o motivo y marcas de tiempo, número de OC, herramientas llamadas, y el costo en tokens por turno y total. Usa la misma validación de `sessionId` y el mismo limitador de lecturas (`READ_LIMITER`) que estado y traza; el panel lateral tiene el botón «Descargar auditoría (JSON)». La identidad de quien aprueba no se registra (no hay autenticación en la demo).
- **Rate limit:** binding `CHAT_LIMITER` (Workers Rate Limiting, 20 POST/60 s por IP, ver `wrangler.jsonc`) y, en memoria, 120 GET de sesión/60 s por IP; si el binding no existe, POST también cae al limitador en memoria. Además hay topes por turno (iteraciones, tokens) y por sesión (turnos, mensajes). Las sesiones se borran tras 24 h sin actividad (alarma del DO).
- **Idempotencia (control C0 "OC existente").** Una solicitud genera a lo sumo una OC. C0 es un control bloqueante que se evalúa en el preflight contra el SAP de la sesión: si ya hay OC es FALLA **antes** de molestar a la persona (nunca aparece una tarjeta de aprobación). El handler lo revalida y el SAP lo vuelve a verificar de forma atómica (`DUPLICADA`). La UI deshabilita "Procesar" en solicitudes con OC.
- **Un turno a la vez por sesión.** El candado se toma de forma síncrona antes de cualquier `await` (doble clic o confirmaciones concurrentes: una sola corre, la otra recibe 409 `sesion_ocupada`). Los botones de la tarjeta de aprobación solo se habilitan cuando el servidor terminó el turno y guardó el estado.
- **Límites por llamada y SSE.** Cada llamada al modelo tiene tope de tiempo (`AbortSignal`, 120 s); el stream emite comentarios `: ping` cada 15 s. Si el cliente se desconecta el turno **no se aborta** (podría haber una escritura en SAP en vuelo): queda acotado por iteraciones, tokens y tiempo, y su resultado queda guardado.
- **Fecha de negocio** en `America/Bogota` (no UTC); la fecha de emisión no entra en la comparación de integridad preflight/ejecución y se asigna al crear la OC.

## Seguridad y límites conocidos

- **Identidad y separación de funciones (SoD) requieren autenticación.** Hoy la "aprobación humana" es un paso HTTP sin identidad: quien tenga el `sessionId` puede aprobar, incluido el propio solicitante. Está fuera de alcance de esta demo. En producción: Cloudflare Access (JWT) delante del Worker, exigir que el aprobador sea distinto del solicitante y registrar su identidad en el audit log.
- **El `sessionId` es una capacidad al portador (bearer).** Es un UUID aleatorio que va en la ruta de `GET /api/sesion/:id`; quien lo vea (logs, proxies, historial) puede leer la sesión y aprobar. Mitigaciones actuales: UUID no adivinable, mismo origen, rate limit también en las lecturas GET de sesión y en POST, y la IP solo se toma de `CF-Connecting-IP` (se ignora `X-Forwarded-For`, que controla el cliente). Con autenticación el `sessionId` dejaría de ser un secreto.
- **SAP simulado por sesión = decisión de demo.** Cada sesión (pestaña / "Nueva conversación") tiene su propio SAP en memoria, así que la idempotencia de C0 vale dentro de la sesión. En producción hay **un solo SAP** y la idempotencia se garantiza con una **clave por solicitud** (p. ej. `solicitudId` como referencia externa única de la OC), validada en el preflight y de forma atómica en la creación.
- **Contenido no confiable.** Correos y cotizaciones son datos, no instrucciones. El modelo no escribe notas en SAP (`crear_orden_compra` solo recibe `solicitudId`); el único texto libre guardado en la OC es el comentario de la persona que aprueba (`comentarioAprobador`).

## Estructura

| Ruta | Qué es |
|---|---|
| `agent/prompt.md` | System prompt (español) |
| `src/tools/oc.ts` | Tools con schema zod (`crear_orden_compra` = adaptador fino sobre `prepararOrden`); `registry.ts`: tipos, `preflight`, ejecución |
| `src/domain/controles/` | **Registro de controles** (`definiciones.ts`, `index.ts`): `{id, nombre, regla, severidad, fuente, evaluar}` |
| `src/domain/ordenes.ts` | `prepararOrden(caso, maestros, fecha)` -> `{orden, controles, bloqueante}` y la vista de aprobación |
| `src/domain/parsers/cotizacion.ts` | Parser determinista (STUB) de `cotizacion.txt` + lista de campos no parseados |
| `src/domain/dinero.ts` | Dinero en centavos enteros |
| `src/sap/` | Interfaz `SapAdapter` + `InMemorySap` (demo/tests y estado por sesión); `s4hana.ts` = **esqueleto no conectado** del adaptador real (OData), ver SOLUCION.md |
| `src/agent/` | `loop.ts` (bucle + HITL), `state.ts` (estado de sesión), `events.ts`, `cost.ts` |
| `src/session/` | `session.ts` (lógica), `storage.ts` (interfaz KV + `MemoryKV`), `routes.ts` (SSE), `auditoria.ts` (informe de auditoría), `do.ts` (Durable Object) |
| `src/llm/` | Cliente Anthropic y fallback opcional con Haiku (`extract.ts`, nunca usado por la demo) |
| `src/data/repo.ts` | Fixtures sin `fs` (`fixtures.generated.ts` se genera con `npm run bundle`) |
| `public/` | Chat (HTML/CSS/JS sin build; SSE con fetch + ReadableStream) |
| `demo.ts`, `src/demo/run.ts` | Casos vía tools, sin LLM, con aserciones contra `esperados.json` |
| `tests/` | `node:test` con cliente Anthropic falso inyectado |

## Dónde conectar los datos reales (PRD)

1. Copiar los fixtures a `fixtures/reto-03/` (borrar `sol-000`, `sol-00X`, el maestro de ejemplo y los `_placeholder`).
2. Tipos: `src/domain/types.ts`. Controles (matriz del PRD): `src/domain/controles/definiciones.ts` + registrarlos en `index.ts`. Mapeo de la OC: `src/domain/ordenes.ts`. Formato de `cotizacion.txt`: `src/domain/parsers/cotizacion.ts` (hoy es un stub).
3. Resultados esperados de los 6 casos: `fixtures/reto-03/esperados.json` (`npm run demo` debe dar PASS en todos).
4. Prompt (`agent/prompt.md`) y descripciones de tools (`src/tools/oc.ts`).
5. `npm run demo -- --matriz` genera la tabla para la sección "Matriz de controles" de `SOLUCION.md`; luego completar el resto de `SOLUCION.md`.
