# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-28
**Fase actual:** F0 · Fundaciones (`docs/specs/fase-0-fundaciones.md`)
**Última tarea terminada:** — (documentación y planificación inicial)
**Siguiente paso:** F0-T01 · Esqueleto del monorepo y tooling

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F0-T01 Esqueleto y tooling | 🔨 en curso | |
| F0-T02 packages/config | ⏳ pendiente | |
| F0-T03 packages/core base | ⏳ pendiente | |
| F0-T04 packages/db y packages/storage | ⏳ pendiente | |
| F0-T05 apps/api | ⏳ pendiente | |
| F0-T06 apps/worker | ⏳ pendiente | |
| F0-T07 apps/cli | ⏳ pendiente | |
| F0-T08 apps/web | ⏳ pendiente | |
| F0-T09 CI | ⏳ pendiente | |
| F0-T10 Cierre | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [ ] Completar la sección "Antes de F0" de `docs/07-checklist-cuentas.md`
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo)
- [ ] Preparar las 3 propiedades de muestra (necesarias para F1)

## Notas de la última sesión
- 2026-09-29: el runtime pasa de Node 22 a **Node 26** (ADR-0008).
- 2026-09-29: el proyecto se llama **AgentSales** (antes "IA Corredor"); CLI `agentsales`, paquetes `@agentsales/*`.
- 2026-09-29: se reemplazó Supabase por Neon (Postgres) + Cloudflare R2 (archivos) por el límite de 2 proyectos gratis (ADR-0007). Alta paso a paso en `docs/09-alta-neon-r2.md`.
- Se creó la documentación base, 6 ADRs, los specs F0 (aprobado) y F1 (borrador), y la configuración de Claude Code.
