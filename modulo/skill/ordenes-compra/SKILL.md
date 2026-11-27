---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — reglas de control RC1–RC10, glosario de campos SAP y qué hacer ante cada excepción. Úsalo al procesar o explicar una solicitud de compra.
---

# Conocimiento del proceso: órdenes de compra (OC) en SAP

Material de referencia del agente (no contiene instrucciones de comportamiento; esas están en `agent/prompt.md`).

## Qué es el proceso

Cada compra llega a administración por correo con tres piezas: la **solicitud** (Excel, aquí `solicitud.json`), la **cotización** del proveedor (`cotizacion.txt`) y el **correo de aprobación** del líder (`aprobacion.json`). Si la factura ya llegó, también hay `factura.txt`. La analista debe crear en SAP la OC con proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjuntar el correo de aprobación como evidencia.

## Glosario

- **OC / orden de compra**: documento SAP que formaliza la compra. Número secuencial desde 4500000001 en el SAP simulado.
- **Centro de costo (CC-xxxx) y subárea**: a quién se carga el gasto. Cada centro tiene subáreas válidas y aprobadores con un **tope** de valor.
- **Aprobador / tope**: persona del centro de costo autorizada a aprobar hasta cierto valor.
- **Indicador de IVA** (C0 excluido, C1 19 %, C2 5 %) y **condiciones de pago** (Z000 inmediato, Z015, Z030, Z060 días): códigos SAP; si faltan en la solicitud se toman por defecto del maestro del proveedor.
- **OC retroactiva**: la factura es anterior a la solicitud, es decir, la compra se hizo antes de pedirla. La dirección quiere medir cuántas hay; se crean solo con confirmación y quedan marcadas `retroactiva = true` en `out/control.csv`.
- **Evidencia**: `out/<caso>/aprobacion.txt` (y `.pdf`) con encabezados del correo de aprobación, cuerpo y su `sha256`.
- **Trazabilidad**: `out/<caso>/trazabilidad.json` indica de dónde sale cada valor del payload: `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`.

## Reglas de control

| Regla | Qué verifica | Tipo | Qué hacer |
|---|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo | Pedir el alta o reactivación del proveedor, o verificar el NIT |
| RC2 | Hay aprobación, dice «Aprobado» y viene de un aprobador del centro de costo | Bloqueo | Obtener la aprobación de un aprobador del centro |
| RC3 | El valor total no supera el tope del aprobador | Bloqueo | Escalar a un aprobador con tope suficiente |
| RC4 | La subárea pertenece al centro de costo | Bloqueo | Corregir subárea o centro de costo |
| RC5 | Cotización y solicitud difieren como máximo 2 % (sin cotización: confirmación) | Confirmación | Mostrar ambos valores y pedir confirmación |
| RC6 | Falta el indicador de IVA: se deriva del proveedor | Confirmación + derivado | Informar el código derivado y pedir confirmación |
| RC7 | Faltan condiciones de pago: se derivan del proveedor | Derivado | Solo informar |
| RC8 | La factura es anterior a la solicitud: OC retroactiva | Confirmación | Pedir confirmación; queda registrada como retroactiva |
| RC9 | La aprobación es anterior a la solicitud | Confirmación | Pedir confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1 unidad monetaria) | Bloqueo | Pedir al solicitante que corrija la solicitud |

Un caso puede tener varios bloqueos a la vez (por ejemplo RC2 y RC3 cuando quien aprueba no pertenece al centro de costo: además no tiene tope allí).

## Qué hacer en cada situación

- **Sin bloqueos ni confirmaciones**: se crea la OC sin intervención humana y se informa número y evidencia.
- **Con bloqueos**: no se crea. Se explica el motivo y la acción sugerida; el humano corrige el origen (maestro, aprobación, solicitud) y vuelve a pedir el proceso.
- **Con confirmaciones**: se muestra la OC como quedaría en SAP y cada excepción con sus valores. Se pregunta y se espera el «confirmo» del usuario. Al crear, cada excepción queda en el payload con `confirmado_por`.
- **Paquete incompleto** (adjunto ausente, JSON malformado, monto no numérico): informar qué falta y sugerir qué pedir al solicitante.
- **Misma solicitud otra vez**: SAP devuelve la OC existente; no se duplica.
- **Montos**: nunca se ajustan para que cuadren con la cotización; cuando difieren, se confirma con ambos valores.

## Registro de control

Cada intento (creada, idempotente, bloqueada o pendiente) agrega una fila a `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. Contabilidad y auditoría consumen ese archivo. Cada llamada a herramienta queda además en `out/log.jsonl`.
