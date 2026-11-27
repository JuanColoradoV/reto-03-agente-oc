# Reto 03 — Agente conversacional "Órdenes de Compra SAP"

**Link para probar:** **<https://reto-03-agente-oc.juancolorado87.workers.dev>** (público, sin clave de acceso; modelo real Claude Sonnet 5.5)

El agente lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura opcional). Lo valida contra los maestros con las reglas RC1–RC10, construye el payload de la OC, genera la evidencia de aprobación (TXT y PDF con sha256) y crea la OC en un SAP simulado.
- Sin excepciones, la OC se crea sola.
- Con confirmaciones, el agente pregunta y espera tu "confirmo".
- Con bloqueos, no la crea y dice por qué y qué hacer.

Planteamiento completo: **[SOLUCION.md](./SOLUCION.md)** · Especificación: [PRD.md](./PRD.md)

**Prueba sugerida:** abre el link y pulsa **Probar sol-004**, o pega el prompt del PRD §11:
```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```
Luego responde `confirmo` o pulsa el botón.

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada sin intervención humana |
| sol-002 | Bloqueada (RC1: proveedor inexistente) |
| sol-003 | Bloqueada (RC2/RC3: aprobador sin autoridad en ese centro de costo) |
| sol-004 | Confirmación (RC5: cotización 26,5 M frente a solicitud 25 M) y luego OC |
| sol-005 | Confirmación (RC8: factura anterior a la solicitud), `retroactiva = true` y luego OC |
| sol-006 | Confirmación (RC6: IVA derivado del proveedor), derivado RC7 y luego OC |

## Levantar en local (un comando)

Requisitos: **Node.js 22.12 o superior** (`.nvmrc`) y npm.

```bash
npm ci
cp .env.example .dev.vars   # pon ANTHROPIC_API_KEY=..., o MOCK_LLM=1 para probar sin clave
npm run dev                 # front + backend en http://localhost:8787
```

- **Sin clave:** `MOCK_LLM=1` en `.dev.vars` activa un modelo simulado con guion, solo en localhost, que recorre el flujo completo.
- **Variables de entorno:** todas están en [`.env.example`](./.env.example), sin valores. Wrangler lee `.dev.vars` en local, y `.dev.vars` está en `.gitignore`.
- **Otro puerto:** `npm run dev -- --port 8799`.

## demo.ts (sin modelo, sin clave)

```bash
npm run demo        # equivale a: npx tsx demo.ts
```

Procesa los 6 casos llamando directamente a las herramientas. Por cada caso imprime `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo. Corre `sol-001` dos veces para mostrar la idempotencia y hace la confirmación explícita de `sol-004`. Limpia `out/` al inicio, es determinista y compara contra `esperados.json` (sale con código 1 si algo no coincide).

```bash
npm test            # pruebas: parsers, reglas RC1–RC10, herramientas, ciclo del agente, guardrails, API, módulo
npm run check       # typecheck + test + demo
```

## Archivos generados (`out/`)

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas por el SAP simulado (secuencial desde 4500000001, idempotente por `solicitud_id`) |
| `out/control.csv` | Una fila por intento: `solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts` |
| `out/log.jsonl` | Cada llamada a herramienta (CA4) |
| `out/<caso>/trazabilidad.json` | Fuente de cada valor del payload |
| `out/<caso>/aprobacion.txt` / `.pdf` | Evidencia de aprobación con sha256 |

En local son archivos reales. En el link público, cada sesión guarda los suyos y se descargan desde el panel **Archivos generados (out/)** del chat.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }`. Responde con un stream SSE: texto del agente, cada llamada a herramienta con su resultado y el evento de confirmación pendiente |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/sessions/:id/out` y `/api/sessions/:id/out/<ruta>` | Lista y descarga de los archivos de `out/` de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }`, sin exponer claves |

Los `POST` exigen la cabecera `Origin` del propio sitio. Ejemplo con curl:
```bash
U=https://reto-03-agente-oc.juancolorado87.workers.dev
curl -N -X POST $U/api/chat -H 'content-type: application/json' -H "Origin: $U" \
  -d '{"sessionId":"'$(uuidgen | tr A-Z a-z)'","message":"Procesa la solicitud sol-001"}'
```

## Seguridad y límites de costo

La clave del modelo vive solo como secreto del backend (`wrangler secret put ANTHROPIC_API_KEY`). Nunca aparece en el repo, el front, los logs ni las respuestas de la API. Para que el link público no se pueda usar como un LLM gratuito ni gastar la clave sin límite, hay estos guardrails:

| Guardrail | Valor | Variable |
|---|---|---|
| Filtro de tema: lo que no trata de órdenes de compra recibe una negativa **sin llamar al modelo** (costo 0) | — | — |
| Tamaño máximo de mensaje | 600 caracteres | `GUARD_MAX_CHARS` |
| Tope de iteraciones herramienta → modelo por turno | 25 | `ITER_MAX` |
| Tope de tokens por sesión | 120.000 | `TOKENS_SESION_MAX` |
| Mensajes por sesión | 30 | `GUARD_MAX_MSGS_SESSION` |
| Mensajes al modelo por IP y día | 60 | `GUARD_MAX_MSGS_IP_DAY` |
| Bloqueo automático de IP tras 8 intentos inválidos o fuera de tema en 1 h | 1 hora | `GUARD_STRIKES`, `GUARD_BLOCK_MIN` |
| Rate limit | 20 mensajes/min por IP | binding `CHAT_LIMITER` |
| Tope de gasto diario global (si el contador falla, **bloquea**) | 2 USD | `DAILY_BUDGET_USD` |
| Interruptor para pausar la demo | `true` | `CHAT_ENABLED` |

## Estructura

| Ruta | Qué es |
|---|---|
| `agent/prompt.md` | **Comportamiento**: system prompt del agente |
| `src/knowledge/ordenes-compra.md` | **Conocimiento** del proceso (reglas explicadas, glosario, qué hacer ante cada excepción) |
| `src/tools/oc.ts` | **Ejecución**: herramientas `oc_*` con el contrato del PRD (zod, `{ok,data}`/`{ok,error}`, nunca lanzan) |
| `src/domain/` | Dominio puro: paquete normalizado, parsers, reglas RC1–RC10 (`reglas.ts`), payload, evidencia |
| `src/sap/` | `adapter.ts` (interfaz `SapAdapter` del PRD) y `mock.ts` (SAP simulado sobre `out/sap/`) |
| `src/llm/` | `adapter.ts` (interfaz `enviar(mensajes, herramientas)`), `anthropic.ts` y `mock.ts` |
| `src/agent/` | Ciclo del agente: tope de iteraciones, confirmación humana, costos |
| `src/out/` | Almacenamiento de `out/`: archivos (Node) o Durable Object (Worker) |
| `src/session/`, `src/guard/`, `src/budget/` | Sesión por conversación, guardrails y tope de gasto global |
| `src/api.ts` | API HTTP (Hono sobre Cloudflare Workers) |
| `public/` | Front de chat (HTML, CSS y JS, sin build) |
| `modulo/` | **Bonus §9.4**: el agente empaquetado (`agent.md`, `tools/oc.ts`, `skill/ordenes-compra/SKILL.md`), generado de las mismas fuentes; ver [modulo/README.md](./modulo/README.md) |
| `demo.ts` | Verificación de herramientas sin modelo |
| `fixtures/reto-03/` | Fixtures entregados, sin modificar |
| `esperados.json` | Resultado esperado por caso, contra el que compara `demo.ts` |

## Desplegar

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```
