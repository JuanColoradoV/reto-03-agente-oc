# modulo/ — el agente empaquetado (bonus, PRD §9.4)

El mismo agente de la aplicación, listo para integrarse a otras plataformas de agentes sin depender del servidor:

| Pieza | Qué es | Fuente única |
|---|---|---|
| `agent.md` | Frontmatter (`description`, `mode: primary`, `permission {edit: deny, bash: deny}`) + el system prompt | generado desde `agent/prompt.md` |
| `tools/oc.ts` | Las herramientas `oc_*`, importables sin el servidor | re-exporta `src/tools/oc.ts` |
| `skill/ordenes-compra/SKILL.md` | Frontmatter (`name`, `description`) + el conocimiento del proceso | generado desde `src/knowledge/ordenes-compra.md` |

No hay copias divergentes: `npm run modulo` regenera los `.md` (también corre en `npm run bundle`), y `tests/modulo.test.ts` falla si `agent.md` o `SKILL.md` no coinciden con sus fuentes o si `tools/oc.ts` no expone exactamente las mismas herramientas que la aplicación.
