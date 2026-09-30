# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-30
**Fase actual:** F1 · Carga (`docs/specs/fase-1-carga.md`, **aprobado**)
**Última tarea terminada:** F1-T03 · Lector de Excel
**Siguiente paso:** `/tarea F1-T04`: caso de uso `importListings` (ver la deuda de T04 más abajo)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F1-T01 Migración 0001, definiciones de campos y errores de base de datos | ✅ terminada | #13 |
| F1-T02 Validador dinámico | ✅ terminada | #14 |
| F1-T03 Lector de Excel | ✅ terminada | |
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
- [ ] Preparar las 3 propiedades de muestra ("Antes de F1" en `docs/07-checklist-cuentas.md`). Hacen falta para las demos de F1-T12 y T14 (avisado antes de T03, que no las usa)
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
- **F1-T04:**
  - Hoja Corredor: comparar las etiquetas (`Campo`) sin mayúsculas ni tildes, y avisar si una se repite (hoy vale la primera, sin aviso).
  - `listings.category` es `NOT NULL` y `REAL_ESTATE_CATEGORY` vive en `db`: core necesita su propia constante o tupla de categorías.
  - Fijar en el spec qué entra en `source_hash`: solo `core` y `attributes`, o también `control`.
- **T11 / F7:** exceljs carga el xlsx completo en memoria, y el tope de filas se revisa después. Un zip de 10 MB podría descomprimirse en mucho más (zip bomb). Es tolerable en local; con subidas públicas (`POST /imports` multipart), limitar el tamaño descomprimido.
- **exceljs 4.4.0** (T03) no tiene versiones estables desde 2023. `pnpm audit --prod` da una vulnerabilidad moderada en `uuid` 8, que no nos afecta: exceljs solo usa `v4`, y el aviso es de v3/v5/v6. Revisar en cada fase si hay una versión nueva o una alternativa mantenida.
- **F7:** `tsc -b` compila `packages/*/test` a `dist` (por ejemplo `test/pglite.ts`, que importa una `devDependency`). Excluirlo del build de producción al armar el despliegue.

## Notas de la última sesión
- 2026-09-30: **F0 cerrada.** Monorepo con `core`, `config`, `db` (Neon, migración `0000_init`), `storage` (R2), API (`/health`), worker (pg-boss), CLI (`doctor`/`status`) y panel. CI en GitHub Actions. 321 tests. Detalle en `CHANGELOG.md` `[0.0.1]` y en el spec F0.
- 2026-09-30: demo de F0 confirmada por el operador. Arreglo derivado: el worker resume los errores repetidos de pg-boss sin conexión.
- 2026-09-30: **F1-T03.** Nuevo `packages/importers`, con `readListingsWorkbook` sobre exceljs 4.4.0.
  - Lee las hojas Propiedades y Corredor, sin validar ni filtrar, y entrega `ListingSheetInput` (core).
  - Aplana las celdas de exceljs cuando puede. Lo demás, incluidos los errores de Excel, lo rechaza el validador.
  - Correcciones de `/revisar`:
    - los encabezados como `constructor` ya no se pierden;
    - las celdas combinadas no copian el dato;
    - los mensajes llevan el nombre del archivo, no la ruta;
    - Biome prohíbe `@agentsales/db` en `importers/src`.
  - Las fixtures se arman en memoria.
  - La plantilla marca `carpeta_medios` como opcional; la edité directo en el XML, conservando las listas desplegables. Un test compara el diccionario de la hoja Instrucciones con `required` del seed.
  - `RawListingRow` acepta `unknown` en los valores (el validador los revisa), y `foldText` vuelve a exportarse desde core.
- 2026-09-30: **F1-T02.** `buildListingValidator` en core.
  - La precedencia del corredor la resuelve `resolveEffectiveDefinitions`: gana la del corredor por su dueño, y después se filtran las inactivas.
  - Un normalizador por tipo:
    - `5.800` → 5800 (el punto seguido de 3 dígitos es de miles);
    - `72.5` y `72,5` → decimales;
    - `Sí/No` sin importar mayúsculas;
    - enums sin mayúsculas ni tildes;
    - listas validadas contra `options`.
  - `CORE_FIELD_TARGETS` asigna los destinos fijos. `tipo` se guarda como etiqueta (`Departamento`).
  - `publicar_en` gana sus opciones en el seed; re-sembrado en Neon.
  - La configuración inválida lanza `FIELD_CONFIG_INVALID` al construir el validador.
  - Correcciones de `/revisar`:
    - Una columna opcional ausente ya no hace fallar la fila.
    - Una `key` de destino fijo debe ser `is_core`, así `notas_internas` no llega a `attributes`.
    - Los encabezados vacíos se ignoran y los repetidos se informan.
    - `isIgnored` filtra `EJEMPLO` y `Borrador` con las columnas resueltas.
    - `fieldIssueSchema` en zod.
    - `precio` con tope por `numeric(14,2)`.
    - Las celdas que no son `RawCell` son `FIELD_VALUE_INVALID`.
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
