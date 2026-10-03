# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-03
**Fase actual:** F2 · Contenido (spec aprobado: `docs/specs/fase-2-contenido.md`)
**Última tarea terminada:** F2-T10 · Caso de uso `prepareContent`
**Siguiente paso:** `/tarea F2-T11` (job `content.prepare` en el worker).

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| Spec F2 (`/fase-plan 2`) | ✅ | #31 |
| F2-T01 · Mínimos y máximos en campos numéricos | ✅ | #33 |
| F2-T02 · Datos de contenido: corridas y contenidos | ✅ | #34 |
| F2-T03 · Medios derivados en la base y `getStream` | ✅ | #35 |
| F2-T04 · Proveedor de IA (`packages/llm`) | ✅ | #36 |
| F2-T05 · Contenido en core: brief, prompt, esquema y ensamblado | ✅ | #37 |
| F2-T06 · Revisión editorial (`checkContent`) | ✅ | #39 |
| F2-T07 · Procesamiento de imágenes (`packages/media`) | ✅ | #40 |
| F2-T08 · Procesamiento de video (`packages/media`) | ✅ | #41 |
| F2-T09 · Plantillas y render | ✅ | #42 |
| F2-T10 · Caso de uso `prepareContent` | ✅ | |
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
- [x] La CLI de Claude con sesión de tu plan y `pnpm llm:smoke` en tu terminal (2026-10-03: salida estructurada correcta; cierra la demo de F2-T04)
- [x] Chromium de Playwright 1.63 (`chromium-1243`, instalado el 2026-10-03). Hay que repetir `pnpm --filter @agentsales/media exec playwright install chromium` cuando se actualice Playwright

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
- **Videos HDR o de 10 bits (iPhone):** el reel los pasa a yuv420p sin mapear tonos ni etiquetar BT.709 (F2-T08), así que pueden verse lavados. Revisarlo con un video real en la demo de F2; si pasa, sumar `zscale`/`tonemap` y subir `MEDIA_PIPELINE_VERSION`.
- **F7, campos propios y la IA:** el brief (F2-T05) manda a la IA todo campo configurable con valor, salvo los `url`. Si un corredor define un campo propio con datos privados (por ejemplo, "Teléfono del propietario"), la IA lo vería. Hoy las definiciones las crea solo el operador. Antes de que los corredores las editen, agregar un indicador en `field_definitions` (por ejemplo, `ai_visible`), con su ADR.
- **Errores HTTP de filas corruptas:** `FIELD_DEFINITION_INVALID` (repositorio de definiciones, F1) cae en la regla `*_INVALID*` y respondería 400 si una ruta lo expusiera; debería ser `FIELD_DEFINITION_ROW_INVALID` (500), como `CONTENT_RUN_ROW_INVALID` desde F2-T02. Hoy ninguna ruta lo expone.
- **F7, rangos:** la base no impide un `min_value` mayor que `max_value` ni un rango en un campo que no es `number`; hoy lo detecta el validador (`FIELD_CONFIG_INVALID`). Si el panel permite editar definiciones, sumar `CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)`.
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
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

- Menor: `apps/worker/src/worker.ts` repite la regla de estado terminal en vez de usar `isTerminalImportRun` (core). El comentario de `IMPORT_RUN_ABANDONED_AFTER_MS` (`apps/worker/src/jobs/import-run.ts`) dice "más el backoff", pero el cálculo no lo suma: la hora de margen lo cubre.

## Notas de la última sesión
- 2026-10-03: **F2-T10.** `requestContentRun` y `prepareContent` en core, con las etapas `media`, `renders`, `reel` y `texts`, idempotentes por claves de R2 determinísticas; la composición del carrusel y de las fotos de Portal; los datos de las plantillas desde una lista fija; `BrokerRepository.findById`. Probado con dobles de todos los puertos: una segunda corrida sin cambios solo llama a la IA, y un cambio de precio rehace portada, ficha y reel.
- 2026-10-03: **F2-T09.** Puertos `SlideTemplates` y `HtmlRenderer` con sus datos en core; `packages/templates` con la portada, la ficha y el texto del reel (Inter incrustada, íconos SVG propios, datos escapados y colores del corredor); `createHtmlRenderer` con Playwright 1.63 (sin red ni JavaScript de la página, tope de 30 s y un Chromium compartido). `doctor` exige el Chromium que pide Playwright y la CI lo instala con caché. Muestras en `docs/assets/plantillas/`. Desde la revisión (#42): `slideKeyInput` para saber si un render cambió sin descargar las fotos, dobles de plantillas y render para T10, un solo plazo de 30 s y corte que responde siempre, un Chromium caído se reabre, errores sin rutas y mejor contraste.
- 2026-10-03: **F2-T08.** `processVideo` en `packages/media`: medidas con ffprobe (con el giro del celular), `thumb` del segundo 1 y reel de 1080×1920 con fondo desenfocado, el texto los primeros 2 s, H.264 4:2:0 con GOP cerrado, AAC (silencioso si no hay audio), `moov` al inicio y sin edit lists, cortado a 90 s y sin reel bajo 3 s. Un reel de 90 s tarda ~26 s en local. Opción `threads` para que los tests no atrasen a los demás. Desde la revisión (#41): los avisos del reel los calcula core (`reelWarnings`), la copia del video no puede botar el worker si el disco se llena, y el GOP de 2 s se verifica con ffprobe.
- 2026-10-03: **F2-T07.** Puerto `MediaProcessor` en core (con su doble en memoria) y `packages/media` con sharp 0.35.5: fotos rotadas según el EXIF, en sRGB y sin metadatos (GPS incluido), con las variantes `thumb`, `ig_4x5` y `pi_4x3` y su sha256, y advertencias de foto chica. HEIC con ffmpeg (8.1 o más nuevo, revisado una vez); un HEIC sintético de 5,6 KB en mosaicos y girado sale completo y derecho. `FFPROBE_PATH`, y `doctor` exige ffmpeg y ffprobe 8.1 o más nuevos. La CI instala ffmpeg 9.0.1 estático (BtbN, fijado por sha256 y con caché) y pasó en el PR. Desde la revisión (#40): la advertencia de foto chica la calcula core en cada corrida (`photoSizeWarnings`); PNG con transparencia sobre blanco; cortar una foto no corta otra.
- 2026-10-03: **F2-T06.** `checkContent` en core con los 10 códigos de §4.6 (6 errores y 4 advertencias), su contexto privado (`buildContentCheckContext`: brief, contacto y dirección, unidad y notas internas) y las listas de términos discriminatorios, superlativos y amenities en `check-terms.ts`. Números comparados por valor (`5.800` = `5800`). El borrador de ejemplo, ensamblado en varios avisos inventados, sale sin ningún aviso. Desde la revisión del PR (#39): más frases discriminatorias y menos falsos positivos (edad de un edificio, "metros cuadrados"), calles por cualquier palabra distintiva y en los hashtags, notas cortas, números con palabras, y `CONTENT_CHECK_CODES` para la API.
- 2026-10-03: **Prueba de humo de F2-T04 completa.** El operador renovó la sesión (`claude auth login`) y corrió `pnpm llm:smoke`: salida estructurada correcta (`claude-sonnet-5`, 2 turnos, un modelo auxiliar en `modelUsage`). El sobre real quedó como caso `exito-real` del ejecutable falso, y la nota de integración y ADR-0003 lo registran.
- 2026-10-03: **F2-T05.** Módulo `packages/core/src/content/`: el brief (lo único que ve la IA: sin notas internas, `_extra`, links ni contacto, y sin dirección si no se puede mostrar), el prompt `listing-content-v1` con los datos como JSON escapado en `<datos_del_aviso>` (probado con textos hostiles), el esquema estricto y su JSON Schema sin topes, `generateContentDraft` (un reintento con el error de validación; dos fallas → `LLM_OUTPUT_INVALID`), `assembleContents` para los tres canales y `SAMPLE_CONTENT_DRAFT`. El filtro de campos del detalle pasó a core (`listingFields`; cierra la deuda de capas de F1). Decisiones de detalle en el registro del spec y en `04-formato-publicaciones.md` (hashtags aparte del cuerpo, relleno hasta 5, requisitos solo en arriendo).
- 2026-10-03: **F2-T04.** `packages/llm` con `claude-cli`, `fake` y el stub `anthropic-api`; puerto `LLMProvider` y `AbortSignalLike` en core; `CLAUDE_CLI_PATH`, `LLM_TIMEOUT_SECONDS` y `ANTHROPIC_API_KEY` exigida con `anthropic-api`; `doctor` revisa la sesión de la CLI; guardia de Vitest. La prueba de humo desde la sesión de desarrollo mostró la sesión OAuth vencida (sin costo): ese sobre real ahora se lee como `LLM_AUTH_REQUIRED` (antes caía en `LLM_UNAVAILABLE`), y `--max-turns` no existe en la 2.1.243. La llamada exitosa la corrió el operador el mismo día (nota anterior).
- 2026-10-03: **F2-T03.** Únicos de derivados en `media` (migración `0005`, aplicada en Neon): una variante vigente por original y variante, y un render por aviso y variante. `mediaSchema` y `MEDIA_VARIANTS` en core; `MediaRepository` suma `listByListing`, `updateMeasurements`, `upsertDerivative` (reemplaza en su lugar y devuelve la clave anterior) y `deleteDerivative`, con la misma suite de contrato en memoria y en PGlite. `MediaStorage.getStream` en R2: `storage:check` leyó 1 MB en 66 trozos con el mismo sha256.
- 2026-10-03: **F2-T02.** Tabla `content_runs` y `contents.content_run_id` (migración `0004`, aplicada en Neon), con una sola corrida activa por aviso y un texto por canal y corrida. Entidades `contentRun` y `content`, puertos `ContentRunRepository` y `ContentRepository` (Drizzle y un doble en memoria con la misma suite de contrato) y el job `content.prepare` en el contrato de core. Desde la revisión: errores `*_ROW_INVALID` (500) para filas corruptas, `CONTENT_PLATFORM_DUPLICATED` para un canal repetido, y en el spec `CONTENT_RUN_ACTIVE` (409) para no editar mientras una corrida de textos espera. El criterio de T02 decía que `failAbandoned` cerraba las `queued` viejas: quedó como §4.4 (solo `running`; las `queued` se reencolan con `listQueued`).
- 2026-10-03: **F2-T01.** `field_definitions.min_value` y `max_value` (migración `0003`, aplicada en Neon) y rangos en el seed (`dormitorios` y `banos` de 0 a 50, superficies de 1 a 1.000.000, `piso` de -10 a 200, año de 1800 a 2100, gastos y contribuciones desde 0). Fuera de rango es `FIELD_NUMBER_INVALID` con el rango en el motivo ("debe estar entre 0 y 50"); un rango en un campo que no es `number`, o con el mínimo mayor que el máximo, es `FIELD_CONFIG_INVALID`. Demo en `--dry-run` con una copia de Sheets (P001 con `dormitorios = -2`): falla esa fila y las demás quedan sin cambios; la planilla quedó como estaba.
- 2026-10-02: **`/fase-plan 2`.** Spec de F2 aprobado (17 tareas), ADR-0012 y ADR-0013 aceptados, y seguimientos en ADR-0003 y ADR-0005. Notas de integración nuevas en `docs/integraciones/` (CLI de Claude, API de Anthropic, HEIC, Instagram y Mercado Libre), con verificaciones locales: la CLI 2.1.243 tiene `--safe-mode`, `--tools` y `claude auth`, y ffmpeg 9.0.1 convierte un HEIC en mosaicos completo. Revisado por el subagente `arquitecto` (6 bloqueantes corregidos en el spec).
- **Pendientes de verificar en sus tareas:** el sobre real de `claude -p` con `--json-schema` y `--tools ""`, y si existe `--max-turns` (no sale en la ayuda de la 2.1.243) (prueba de humo en T04), la orientación y el color de un HEIC de iPhone (T07), y el largo del título y las reglas de contacto de Mercado Libre (F4: la doc dio 403).
- **Para la próxima demo:** las variantes del Excel se arman en Google Sheets y se exportan como xlsx; la planilla queda como estaba. Neon tiene las 3 propiedades de muestra tal como están en `data/muestras/propiedades.xlsx` (cierre de F1, `v0.1.0`; detalle en `CHANGELOG.md`).
