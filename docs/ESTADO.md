# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-30
**Fase actual:** F1 · Carga (`docs/specs/fase-1-carga.md`, en **borrador**)
**Última tarea terminada:** F0-T10 · Cierre de F0 (tag `v0.0.1`)
**Siguiente paso:** `/fase-plan 1` para revisar y aprobar el spec de F1 (incluye decidir ADR-0011 y la enmienda de ADR-0005)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F1-T01 Definiciones de campos y validador dinámico | ⏳ pendiente | |
| F1-T02 Lector de Excel | ⏳ pendiente | |
| F1-T03 Caso de uso importListings | ⏳ pendiente | |
| F1-T04 Ingesta de medios | ⏳ pendiente | |
| F1-T05 API de importación y listings | ⏳ pendiente | |
| F1-T06 CLI de importación y consulta | ⏳ pendiente | |
| F1-T07 Panel: Propiedades, Detalle e Importar | ⏳ pendiente | |
| F1-T08 Cierre de fase | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [ ] Preparar las 3 propiedades de muestra (necesarias para F1; ver "Antes de F1" en `docs/07-checklist-cuentas.md`)
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo; se usa en F3)
- [ ] Decidir la licencia del repo ahora que es público (sin `LICENSE` quedan todos los derechos reservados)

## Decisiones pendientes para `/fase-plan 1`
- **ADR-0011:** dónde viven los contratos HTTP compartidos. Propuesta: entidades en `core`; salud, cuerpo de error, parámetros y formularios en `@agentsales/api/contracts`. Hoy `errorBodySchema` está duplicado en la web y la CLI.
- **Importación síncrona o job `import.run`:** choca con ADR-0005 ("la API solo encola"). Si se adopta el job, se extrae `packages/queue` (puerto `JobQueue`, `JOB_NAMES`/`JOB_PAYLOADS` en `core`) y se enmienda ADR-0005.
- **`MediaStorage` con streams** para videos de hasta `MAX_VIDEO_MB` (F1-T04); quizás `@aws-sdk/lib-storage`, que es una dependencia nueva.
- **Migración `0001`:** único `NULLS NOT DISTINCT (broker_id, category, key)` en `field_definitions`, y en `media` un único parcial por checksum más `UNIQUE (storage_path)`. `0000_init` no se edita.
- **Patrones de F1** (detallados en el registro de cambios del spec F1):
  - Panel: `createApiClient` con `unwrap`, un solo `ApiClientContext` y hooks por recurso.
  - CLI: un comando por archivo.
  - Tests sin red con `app.request`.

## Deuda técnica
- Panel: bundle de 660 kB (201 kB gzip). Revisar la división por rutas y `zod/mini`.
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
- F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al cifrar tokens.
- F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
- El redactor oculta cualquier clave con `key` (por ejemplo `objectKey`): en logs usar nombres como `objectPath`.

## Notas de la última sesión
- 2026-09-30: **F0 cerrada.** Monorepo con `core`, `config`, `db` (Neon, migración `0000_init`), `storage` (R2), API (`/health`), worker (pg-boss), CLI (`doctor`/`status`) y panel. CI en GitHub Actions. 321 tests. Detalle en `CHANGELOG.md` `[0.0.1]` y en el spec F0.
- 2026-09-30: el repo `vicentewolde/AgentSales` es **público**, y `main` tiene protección de rama: check `check` obligatorio, rama al día, aplica también a administradores, sin force push. El historial se revisó antes de publicarlo y no tiene secretos.
- **Recordatorios de operación:**
  - `pnpm dev` levanta API, worker y panel; hay que apagarlo al terminar, porque mantiene Neon despierto.
  - `pnpm -s cli doctor` necesita `pnpm dev` corriendo.
