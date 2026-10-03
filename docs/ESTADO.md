# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-03
**Fase actual:** F2 · Contenido (spec aprobado: `docs/specs/fase-2-contenido.md`)
**Última tarea terminada:** F2-T03 · Medios derivados en la base y `getStream`
**Siguiente paso:** `/tarea F2-T04` (proveedor de IA, `packages/llm`; necesita la CLI de Claude con sesión para la prueba de humo). Después, T05 → T06, y T07 cuando se quiera empezar con los medios.

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| Spec F2 (`/fase-plan 2`) | ✅ | #31 |
| F2-T01 · Mínimos y máximos en campos numéricos | ✅ | #33 |
| F2-T02 · Datos de contenido: corridas y contenidos | ✅ | #34 |
| F2-T03 · Medios derivados en la base y `getStream` | ✅ | |
| F2-T04 · Proveedor de IA (`packages/llm`) | ⏳ pendiente | |
| F2-T05 · Contenido en core: brief, prompt, esquema y ensamblado | ⏳ pendiente | |
| F2-T06 · Revisión editorial (`checkContent`) | ⏳ pendiente | |
| F2-T07 · Procesamiento de imágenes (`packages/media`) | ⏳ pendiente | |
| F2-T08 · Procesamiento de video (`packages/media`) | ⏳ pendiente | |
| F2-T09 · Plantillas y render | ⏳ pendiente | |
| F2-T10 · Caso de uso `prepareContent` | ⏳ pendiente | |
| F2-T11 · Job `content.prepare` en el worker | ⏳ pendiente | |
| F2-T12 · API de contenido | ⏳ pendiente | |
| F2-T13 · CLI `prepare` y `content` | ⏳ pendiente | |
| F2-T14 · Panel: preparar y vista previa | ⏳ pendiente | |
| F2-T15 · Panel: edición de textos | ⏳ pendiente | |
| F2-T16 · `pnpm eval:content` | ⏳ pendiente | |
| F2-T17 · Cierre de fase | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [x] Trámite de la app de Meta (para F3): cuenta profesional, app `AgentSales-IG`, tester aceptado (2026-10-02) y `META_APP_ID` y `META_APP_SECRET` en `.env` (2026-10-03). En F3 se confirma que son el par de Instagram que usa el sistema. La verificación del negocio y el App Review quedan para F7
- [ ] Antes de F2-T04: la CLI de Claude con sesión iniciada (`claude auth status`). La demo de T04 hace unas pocas llamadas cortas con datos inventados, del plan del operador.
- [ ] Antes de F2-T09: Chromium de Playwright (`pnpm --filter @agentsales/media exec playwright install chromium`; lo indica la tarea)

## Decisiones de `/fase-plan 2` (2026-10-02)
Resueltas con la recomendación del spec (§4.10), por la aprobación permanente del operador:
- **D1 · Sin publicaciones en F2 (ADR-0012):** F2 crea solo `contents` y corridas (`content_runs`); las publicaciones nacen en F3 con la cuenta. El criterio de F2 pasa a "contenido listo para revisar".
- **D2 · Textos híbridos (ADR-0013):** los datos (precio, superficies, contacto, títulos) los pone el código; la IA redacta frases. Prompt, esquema, ensamblado y revisión editorial en core.
- **D3 · La IA no elige ni sugiere la portada, y no ve las fotos:** manda `foto_portada` (o la primera foto). La sugerencia con visión pasa al backlog.
- **D4 · Una corrida por aviso con etapas** (`content.prepare`): medios, renders, reel y textos; `media.process` no se crea.
- **D5 · Reel con fondo desenfocado** y el texto de los primeros 2 s como PNG renderizado.
- **D6 · CI con ffmpeg (8.1 o más nuevo, por HEIC) y Chromium.**
- **D7 · Mínimos y máximos** como columnas de `field_definitions`.
- **D8 · Google Sheets y Drive:** no antes de F3; backlog post-MVP.
- **D9 · Título de Portal sin abreviaturas y con la operación** (`Departamento en venta 3 dormitorios 2 baños en Ñuñoa`), de hasta 60 caracteres.
- **Revisión del arquitecto:** plantillas y render como puertos de core (`SlideTemplates`, `HtmlRenderer`); el procesador de medios maneja sus temporales; el reel se rehace si cambia el precio; la revisión editorial ve los datos privados para detectar fugas; una corrida en cola se reencola al pedirla y al arrancar el worker; regenerar textos no reemplaza una edición a mano sin `replaceEdits`; la CLI de Claude corre fuera del repo; procesos hijos cortados al apagar el worker.
- **Hallazgos de las notas de integración:** HEIC con ffmpeg (sharp no lo decodifica; verificado con ffmpeg 9.0.1); la CLI de Claude sin `--bare` (exige API key) y sin `ANTHROPIC_API_KEY` en su entorno (cobraría por API); carrusel de hasta 10; reel de Meta entre 3 s y 15 min (el tope de 90 s es nuestro); título de Portal de hasta 60 caracteres sin abreviaturas (por confirmar en F4).

## Deuda técnica
- **Errores HTTP de filas corruptas:** `FIELD_DEFINITION_INVALID` (repositorio de definiciones, F1) cae en la regla `*_INVALID*` y respondería 400 si una ruta lo expusiera; debería ser `FIELD_DEFINITION_ROW_INVALID` (500), como `CONTENT_RUN_ROW_INVALID` desde F2-T02. Hoy ninguna ruta lo expone.
- **F7, rangos:** la base no impide un `min_value` mayor que `max_value` ni un rango en un campo que no es `number`; hoy lo detecta el validador (`FIELD_CONFIG_INVALID`). Si el panel permite editar definiciones, sumar `CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)`.
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F2 (T04): exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
- F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al cifrar tokens.
- F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
- El redactor oculta cualquier clave con `key` (por ejemplo `objectKey`): en logs usar nombres como `objectPath`.
- **F7:** exceljs carga el xlsx completo en memoria, y el tope de filas se revisa después. Un xlsx de 10 MB (que es un zip) podría descomprimirse en mucho más dentro de exceljs. El cuerpo de la subida ya tiene tope (T11: `MAX_IMPORT_UPLOAD_MB` y 413), y el zip de medios también (T06: 4 GB y `validateEntrySizes`). Falta limitar el tamaño descomprimido del xlsx con subidas públicas.
- **F7, subidas del panel:**
  - Hono lee el multipart completo en memoria; con los archivos escritos en streaming, el pico es de unas 2 veces el cuerpo (de ahí el default de 512 MB).
  - F7 cambia esto por la subida directa a R2 con URL prefirmada: `import_runs.input` pasa a claves de R2, y se quitan `POST /imports/local` y el staging compartido.
  - El despliegue fija `NODE_ENV=production` (`/imports/local` depende de eso). Ver `docs/06-roadmap.md` → F7.
- **exceljs 4.4.0** (T03) no tiene versiones estables desde 2023. `pnpm audit --prod` da una vulnerabilidad moderada en `uuid` 8, que no nos afecta: exceljs solo usa `v4`, y el aviso es de v3/v5/v6. Revisar en cada fase si hay una versión nueva o una alternativa mantenida.
- **F7:** `tsc -b` compila `packages/*/test` a `dist` (por ejemplo `test/pglite.ts`, que importa una `devDependency`), y también `apps/api/src/testing` (importa `@agentsales/core/testing`) y `apps/cli/test`. Excluirlos del build de producción al armar el despliegue.
- **F7:** `agentsales listing --broker` resuelve el corredor en la CLI con `/brokers`. Con autenticación y varios clientes, el alcance por corredor lo tiene que hacer el servidor (junto con la proyección acotada de `GET /listings`).
- `--broker` se normaliza con `slugify` solo en la CLI: `POST /imports/local` con `"Mi Corredor"` da `BROKER_NOT_FOUND`. Hoy no importa (el panel usa un selector); si aparece otro cliente, normalizar en core (`requestImport`).

- **F2 (T05), capas:** el filtro de `fields` del detalle (definiciones efectivas, sin `isCore` y con valor) vive en `apps/api/src/routes/listings.ts`. Cuando las plantillas de F2 lo necesiten, moverlo a core junto a `describeAttributes`.
- Menor: `apps/worker/src/worker.ts` repite la regla de estado terminal en vez de usar `isTerminalImportRun` (core). El comentario de `IMPORT_RUN_ABANDONED_AFTER_MS` (`apps/worker/src/jobs/import-run.ts`) dice "más el backoff", pero el cálculo no lo suma: la hora de margen lo cubre.

## Notas de la última sesión
- 2026-10-03: **F2-T03.** Únicos de derivados en `media` (migración `0005`, aplicada en Neon): una variante vigente por original y variante, y un render por aviso y variante. `mediaSchema` y `MEDIA_VARIANTS` en core; `MediaRepository` suma `listByListing`, `updateMeasurements`, `upsertDerivative` (reemplaza en su lugar y devuelve la clave anterior) y `deleteDerivative`, con la misma suite de contrato en memoria y en PGlite. `MediaStorage.getStream` en R2: `storage:check` leyó 1 MB en 66 trozos con el mismo sha256.
- 2026-10-03: **F2-T02.** Tabla `content_runs` y `contents.content_run_id` (migración `0004`, aplicada en Neon), con una sola corrida activa por aviso y un texto por canal y corrida. Entidades `contentRun` y `content`, puertos `ContentRunRepository` y `ContentRepository` (Drizzle y un doble en memoria con la misma suite de contrato) y el job `content.prepare` en el contrato de core. Desde la revisión: errores `*_ROW_INVALID` (500) para filas corruptas, `CONTENT_PLATFORM_DUPLICATED` para un canal repetido, y en el spec `CONTENT_RUN_ACTIVE` (409) para no editar mientras una corrida de textos espera. El criterio de T02 decía que `failAbandoned` cerraba las `queued` viejas: quedó como §4.4 (solo `running`; las `queued` se reencolan con `listQueued`).
- 2026-10-03: **F2-T01.** `field_definitions.min_value` y `max_value` (migración `0003`, aplicada en Neon) y rangos en el seed (`dormitorios` y `banos` de 0 a 50, superficies de 1 a 1.000.000, `piso` de -10 a 200, año de 1800 a 2100, gastos y contribuciones desde 0). Fuera de rango es `FIELD_NUMBER_INVALID` con el rango en el motivo ("debe estar entre 0 y 50"); un rango en un campo que no es `number`, o con el mínimo mayor que el máximo, es `FIELD_CONFIG_INVALID`. Demo en `--dry-run` con una copia de Sheets (P001 con `dormitorios = -2`): falla esa fila y las demás quedan sin cambios; la planilla quedó como estaba.
- 2026-10-02: **`/fase-plan 2`.** Spec de F2 aprobado (17 tareas), ADR-0012 y ADR-0013 aceptados, y seguimientos en ADR-0003 y ADR-0005. Notas de integración nuevas en `docs/integraciones/` (CLI de Claude, API de Anthropic, HEIC, Instagram y Mercado Libre), con verificaciones locales: la CLI 2.1.243 tiene `--safe-mode`, `--tools` y `claude auth`, y ffmpeg 9.0.1 convierte un HEIC en mosaicos completo. Revisado por el subagente `arquitecto` (6 bloqueantes corregidos en el spec).
- **Pendientes de verificar en sus tareas:** el sobre real de `claude -p` con `--json-schema` y `--tools ""`, y si existe `--max-turns` (no sale en la ayuda de la 2.1.243) (prueba de humo en T04), la orientación y el color de un HEIC de iPhone (T07), y el largo del título y las reglas de contacto de Mercado Libre (F4: la doc dio 403).
- **Para la próxima demo:** las variantes del Excel se arman en Google Sheets y se exportan como xlsx; la planilla queda como estaba. Neon tiene las 3 propiedades de muestra tal como están en `data/muestras/propiedades.xlsx` (cierre de F1, `v0.1.0`; detalle en `CHANGELOG.md`).
