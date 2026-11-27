# Diseño ejecutable del adaptador SAP real

Código y pruebas de la sección "Diseño del adaptador SAP real" de [SOLUCION.md](../../SOLUCION.md): adaptador S/4HANA
(OData V4 `API_PURCHASEORDER_2`), estado de idempotencia por solicitud (`EN_PROCESO` / `CREADA` / `INCIERTA`) y el Durable Object
`SolicitudDO` que lo serializa entre sesiones.

- **No está conectado al Worker**: nada de `src/` lo importa, ni `wrangler.jsonc` ni `src/index.ts` lo declaran. La demo usa `InMemorySap`.
- Se compila (`npm run typecheck`) y se prueba (`npm test`) contra un `fetch` falso que imita el comportamiento documentado de SAP.
- Los nombres de campos y rutas están por verificar contra el `$metadata` de un sistema real (lista en `CAMPOS_A_VERIFICAR`).
- Para conectarlo: declarar el binding y la migración del DO, exportarlo desde `src/index.ts` y construir `new S4HanaSap({ ..., store })`.
