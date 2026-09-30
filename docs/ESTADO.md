# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-30
**Fase actual:** F1 · Carga (`docs/specs/fase-1-carga.md`, **aprobado**)
**Última tarea terminada:** F1-T01 · Migración 0001, definiciones de campos y errores de base de datos
**Siguiente paso:** `/tarea F1-T02`: validador dinámico (luego T03, el lector de Excel)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F1-T01 Migración 0001, definiciones de campos y errores de base de datos | ✅ terminada | |
| F1-T02 Validador dinámico | ⏳ pendiente | |
| F1-T03 Lector de Excel | ⏳ pendiente | |
| F1-T04 Caso de uso importListings | ⏳ pendiente | |
| F1-T05 Almacenamiento con streams | ⏳ pendiente | |
| F1-T06 Lectores de medios | ⏳ pendiente | |
| F1-T07 Caso de uso ingestMedia | ⏳ pendiente | |
| F1-T08 Paquete de cola | ⏳ pendiente | |
| F1-T09 Job import.run | ⏳ pendiente | |
| F1-T10 Contratos HTTP y API de lectura | ⏳ pendiente | |
| F1-T11 API de importación | ⏳ pendiente | |
| F1-T12 CLI de importación y consulta | ⏳ pendiente | |
| F1-T13 Panel: patrón, Propiedades y Detalle | ⏳ pendiente | |
| F1-T14 Panel: Importar | ⏳ pendiente | |
| F1-T15 Cierre de fase | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [ ] Preparar las 3 propiedades de muestra ("Antes de F1" en `docs/07-checklist-cuentas.md`). Hacen falta para las demos de F1-T12 y T14; Claude avisa antes de F1-T03
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo; se usa en F3)

## Deuda técnica
- Panel: bundle de 660 kB (201 kB gzip). Queda hasta F7 (D5 del spec F1); F1-T13 solo agrega `React.lazy`.
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
- F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al cifrar tokens.
- F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
- El redactor oculta cualquier clave con `key` (por ejemplo `objectKey`): en logs usar nombres como `objectPath`.
- **Antes de F1-T04:** el `cause` de `DB_UNAVAILABLE` (un `DrizzleQueryError`) lleva los `params` de la consulta en su mensaje. Con listings pueden ser datos de clientes (notas internas, dirección): decidir cómo se redactan en los logs.
- **F1-T02:**
  - Decidir si `options` también valida cada elemento de un `list` (por ejemplo `publicar_en`, con las plataformas).
  - Test que cruce `CORE_FIELD_TARGETS` de core con `TEMPLATE_COLUMNS` e `is_core` del seed, para que no se desincronicen.
- **F1-T03:**
  - La hoja Instrucciones de la plantilla todavía marca `carpeta_medios` como obligatoria; el seed la deja opcional (spec §4.3). Actualizar el xlsx.
  - `@agentsales/db` va solo como `devDependency` de `packages/importers`, por `TEMPLATE_COLUMNS` en los tests.
- **F7:** `tsc -b` compila `packages/*/test` a `dist` (por ejemplo `test/pglite.ts`, que importa una `devDependency`). Excluirlo del build de producción al armar el despliegue.

## Notas de la última sesión
- 2026-09-30: **F0 cerrada.** Monorepo con `core`, `config`, `db` (Neon, migración `0000_init`), `storage` (R2), API (`/health`), worker (pg-boss), CLI (`doctor`/`status`) y panel. CI en GitHub Actions. 321 tests. Detalle en `CHANGELOG.md` `[0.0.1]` y en el spec F0.
- 2026-09-30: demo de F0 confirmada por el operador. Arreglo derivado: el worker resume los errores repetidos de pg-boss sin conexión.
- 2026-09-30: **F1-T01.**
  - Migración `0001`, aplicada en Neon.
  - 36 definiciones globales sembradas desde la plantilla, con tipos y obligatorios del diccionario de la hoja Instrucciones. `carpeta_medios` es opcional, según §4.3 del spec.
  - `FieldDefinitionRepository`, con implementación Drizzle y otra en memoria (`@agentsales/core/testing`).
  - `DB_UNAVAILABLE` para los fallos de conexión.
  - Tests de repositorios con PGlite, dependencia nueva de desarrollo en `packages/db`.
  - drizzle 0.45 envuelve los errores del driver en `DrizzleQueryError`: para ver el SQLSTATE se usa `sqlStateOf`, que recorre `cause`.
  - Correcciones de `/revisar`:
    - `isDbUnavailable` ya no da falsos positivos con los parámetros de la consulta.
    - `list` devuelve también las definiciones inactivas: T02 aplica la precedencia y después filtra.
    - Un fixture de orden compartido entre el repositorio en memoria y el de Drizzle.
    - `FIELD_DEFINITION_INVALID` para un jsonb corrupto.
    - "Contrato de repositorios" en `01-arquitectura.md`.
- 2026-09-30: **spec F1 aprobado** con 15 tareas. Decisiones D1–D6: ADR-0011 (contratos HTTP en `@agentsales/api/contracts`); job `import.run` (enmienda de ADR-0005); `putStream` sin `lib-storage`; PGlite en `packages/db`; bundle del panel como deuda hasta F7; metadatos de medios en F2.
- 2026-09-30: `/tarea` incorpora la retro de F0: plan sin red, revisión de `minimumReleaseAgeExclude` tras `pnpm add`, simulación de la CI en un clon limpio y push, PR y merge solo con autorización y `CI / check` en verde.
- 2026-09-30: el operador decide dejar el repo **sin licencia** (todos los derechos reservados).
- 2026-09-30: el repo `vicentewolde/AgentSales` es **público**, y `main` tiene protección de rama: check `check` obligatorio, rama al día, aplica también a administradores, sin force push. El historial se revisó antes de publicarlo y no tiene secretos.
- **Recordatorios de operación:**
  - `pnpm dev` levanta API, worker y panel; hay que apagarlo al terminar, porque mantiene Neon despierto.
  - `pnpm -s cli doctor` necesita `pnpm dev` corriendo.
