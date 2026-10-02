# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-02
**Fase actual:** F1 · Carga (`docs/specs/fase-1-carga.md`, **aprobado**)
**Última tarea terminada:** F1-T14 · Panel: Importar
**Siguiente paso:** las demos de T12 y T14 con las 3 propiedades de muestra, y después `/tarea F1-T15` (cierre de fase, que exige verlas en el panel)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F1-T01 Migración 0001, definiciones de campos y errores de base de datos | ✅ terminada | #13 |
| F1-T02 Validador dinámico | ✅ terminada | #14 |
| F1-T03 Lector de Excel | ✅ terminada | #15 |
| F1-T04 Caso de uso importListings | ✅ terminada | #16 |
| F1-T04b Repositorios Drizzle de brokers, listings e import_runs | ✅ terminada | #17 |
| F1-T05 Almacenamiento con streams | ✅ terminada | #18 |
| F1-T06 Lectores de medios | ✅ terminada | #19 |
| F1-T07 Caso de uso ingestMedia (core) | ✅ terminada | #20 |
| F1-T07b MediaRepository en Drizzle y checksum en R2 | ✅ terminada | #21 |
| F1-T08 Paquete de cola | ✅ terminada | #22 |
| F1-T09 Job import.run | ✅ terminada | #23 |
| F1-T10 Contratos HTTP y API de lectura | ✅ terminada | #24 |
| F1-T11 API de importación | ✅ terminada | #25 |
| F1-T12 CLI de importación y consulta | ✅ terminada (demo pendiente) | #26 |
| F1-T13 Panel: patrón, Propiedades y Detalle | ✅ terminada | #27 |
| F1-T14 Panel: Importar | ✅ terminada (demo pendiente) | |
| F1-T15 Cierre de fase | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [ ] Preparar las 3 propiedades de muestra ("Antes de F1" en `docs/07-checklist-cuentas.md`). Hacen falta para la demo pendiente de F1-T12 (`pnpm -s cli import data/muestras/propiedades.xlsx --media data/muestras/medios`) y la de T14
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo; se usa en F3)

## Deuda técnica
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
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

## Notas de la última sesión
- 2026-10-02: **F1-T14.** Panel: Importar.
  - **Páginas:** `/importar` (formulario y cargas anteriores) e `/importar/:id` (progreso, aviso de cola a los 20 s y reporte con filas, errores por fila y columna y advertencias). "Importar" en el menú.
  - **Sondeo:** cada 2 s solo mientras la carga corre. Al terminar se invalidan propiedades, corredores y cargas, así Propiedades muestra lo nuevo sin esperar la caché.
  - **Subidas:** timeout propio de 10 min; el formulario revisa la extensión y el tope del Excel antes de subir.
  - **Core:** `IMPORT_BROKER_OUTCOME_TEXT` e `IMPORT_ROW_OUTCOME_TEXT` (también en la CLI).
  - **Hallazgo:** los contratos tipaban el archivo subido con `z.instanceof(File)`, que le pasaba al panel el `File` de Node (desde T11). Ahora es `z.custom<File>`; anotado en arquitectura.
  - **Tests:** el arnés reenvía la subida a `/imports/local` (jsdom no puede mandar archivos a la API en proceso); reloj simulado que avanza solo para las páginas diferidas.
  - **Prueba en el navegador** con API, worker y panel contra Neon: la plantilla con `demo` y "Solo simular" se sube por el proxy (con `Origin`), la API responde `202`, el worker la procesa y la página deja de consultar al terminar. Apagados al terminar.
  - **Demo pendiente:** con las 3 propiedades de muestra.
- 2026-10-02: **F1-T13.** Panel: patrón, Propiedades y Detalle.
  - **API:** el detalle trae `fields` (etiquetas de los atributos, con las definiciones efectivas del corredor); `AppDeps.fieldDefinitions`. La CLI también las muestra.
  - **Core:** `describeAttributes`, `formatNumber`, `formatListingPrice` (`/mes` en arriendo) y `resolveEffectiveDefinitions` exportada.
  - **Panel:**
    - Patrón: `createApiClient` + `unwrap` + `ApiClientContext`, consultas por recurso en `src/queries/` y páginas en `React.lazy`. El `HealthFetcher` desaparece.
    - Propiedades: grilla con portada, operación, tipo, comuna, precio y estado; filtros en la URL.
    - Detalle: galería, datos, atributos con etiqueta y cambio de estado.
    - Los avisos se guardan en caché 5 min (15 sin uso), bien por debajo de la hora de vida de las URLs firmadas. Un 4xx no se reintenta.
  - **Tests:** contra la API real en proceso (`apps/web/test/harness.tsx`). Una guardia (test) revisa que el panel solo haga `import type` de la raíz de la API.
  - **Correcciones de `/revisar`:**
    - Bloqueante: un año salía "2.018". Ahora un entero de cuatro cifras va sin punto (RAE), y el precio sigue con punto.
    - Textos de estado, operación y carga en core; la CLI muestra los estados en español.
    - Panel: sin parpadeo al filtrar, comunas de respaldo, `aria-live`, detalle que no "rejuvenece" sus URLs al cambiar el estado, sin reintento de `TIMEOUT`, corte del cuerpo como `TIMEOUT` (también en la CLI), `errorElement`, y botones "Reanudar" y "Desarchivar".
    - Guardia de imports con `export … from`, `import "x"` e `import()`.
    - Tests nuevos de datos vacíos, estados sin botones y año.
    - Docs: arquitectura (rutas, `AppDeps`, clientes HTTP de la CLI y el panel, textos en core) y una nota para T14: invalidar `listingKeys.all` al terminar una carga.
  - **Prueba en el navegador** con la API contra Neon: Propiedades (vacía, con el aviso de cómo cargar) y el detalle de un id inexistente. Ahí apareció el arreglo de los reintentos: un 404 quedaba en "Cargando". La grilla con fotos reales espera las propiedades de muestra. Apagados al terminar.
- 2026-10-02: **F1-T12.** CLI de importación y consulta.
  - **Comandos:** `import` (con `--media`, `--broker`, `--dry-run` y `--no-wait`), `imports [<id>]`, `listings [--status] [--json]` y `listing <id_propiedad|id> [--broker] [--json]`. Un archivo por comando en `apps/cli/src/commands/`, con `run<Nombre>(deps)` y `register`; `doctor` y `status` se mudaron ahí.
  - **Cliente:** `createApiClient` (el `hc` completo, con timeout) y `unwrap`, que valida con los esquemas de `contracts`. Los errores se muestran como `CODE: mensaje` y una sugerencia (Neon, cola, R2, Host), sin stack trace.
  - **Decisiones del plan:**
    - Dobles compartidos en `@agentsales/api/testing`, en vez de copiarlos en la CLI. Los tests de la CLI corren contra `createApp` en proceso (`app.request` como `fetch`).
    - Filtro `externalRef` exacto en la API; `--broker` se resuelve en la CLI con `/brokers`.
    - `formatPrice` en core, para la CLI y el panel.
    - `--no-wait` imprime solo el id; hasta 3 consultas fallidas seguidas se reintentan; sale con 1 si hay filas con error.
  - **Arreglo de paso:** `updated_at` con `now()` de la base al actualizar. El test de orden de la lista de avisos fallaba de vez en cuando (milisegundos del proceso contra microsegundos de la base).
  - **Prueba de humo:** con la API y el worker contra Neon, `import` de la plantilla con `--broker Demo --dry-run` se encola, el worker la procesa y la CLI muestra el resumen; `imports`, `listings` y `listing` responden. Apagados al terminar.
  - **Correcciones de `/revisar`:**
    - §4.4 del spec con `externalRef` y `listing --broker`.
    - `TERMINAL_IMPORT_RUN_STATUSES` e `isTerminalImportRun` en core (la regla estaba repetida en la CLI).
    - Ayudas compartidas en `commands/shared.ts`.
    - `@agentsales/api/testing` también prohibida en los adaptadores, con test de Biome.
    - Reloj monótono para el tope de 2 h; un 4xx al consultar ya no dice que la carga "sigue en el worker"; el código de `listing` se recorta; timeout menor a 1 s en ms; signo de `formatPrice` unificado.
    - Test nuevo: el contador de fallas vuelve a cero al responder.
    - Docs: arquitectura (excepción de `src/testing/`), modelo de datos (`updated_at`) y deudas de F7.
  - **`CLAUDE.md`:** la sección Estructura suma `queue`, a pedido del operador.
  - **Demo pendiente:** faltan las 3 propiedades de muestra en `data/muestras/`.
- 2026-10-01: **F1-T11.** API de importación.
  - **Rutas:**
    - `POST /imports` (multipart): el id del run lo genera la API, guarda los archivos en `input/`, `requestImport` y `202`. Con `bodyLimit` (`MAX_IMPORT_UPLOAD_MB`, 413), un xlsx de hasta 10 MB y borrado de lo guardado si falla.
    - `POST /imports/local`: rutas absolutas, solo en desarrollo; si no, 404 antes de validar.
    - `GET /imports` y `/imports/:id`: con nombres de archivo, nunca rutas.
  - **Mudanzas:** `createStaging` a `@agentsales/importers/staging` (con `saveInput`), y `createErrorThrottle` a `@agentsales/config`. El worker usa los dos.
  - **Core y db:** `NewImportRun.id` e `ImportRunRepository.list`, con la suite de contrato.
  - **API:** compone la cola (arranque diferido, errores resumidos, `stop()` al apagar) y el staging.
  - **Tests:** de rutas con dobles. Probé 4 mutaciones y todas hacen fallar algún test.
  - **Correcciones de `/revisar`:**
    - Los archivos subidos se escriben en streaming, y `MAX_IMPORT_UPLOAD_MB` por defecto baja a 512.
    - Un campo vacío del formulario cuenta como no enviado.
    - Los nombres con `\0` o de más de 255 bytes dan `IMPORT_FILE_INVALID`.
    - `MAX_XLSX_BYTES` en core.
    - La lista de cargas va sin `report`.
    - Si la carga ya existe, sus archivos se conservan.
    - `IMPORT_RUN_CONFLICT` para un id repetido.
    - Se rechazan las rutas que terminan en `/`.
    - `stagingRootOf`, compartido por la API y el worker.
    - Biome impide que los adaptadores se importen entre sí.
    - Tests nuevos: CSRF, 413 con `Content-Length`, falla a mitad de la subida y JSON inválido en `/local`.
    - Se estabilizó un test de orden de la lista.
    - Quedaron anotados: F7 en el roadmap, y notas para T12 y T14.
- 2026-10-01: **F1-T10.** Contratos HTTP y API de lectura.
  - **`@agentsales/api/contracts`:** cuerpo de error, parámetros, filtros y respuestas. Biome lo limita a zod, core e imports relativos, y un test lo comprueba. Para que Biome no ignore el archivo temporal del test, se corre con `--vcs-use-ignore-file=false`.
  - **`validated`:** con `REQUEST_INVALID`. Los ids de ruta se validan como uuid.
  - **Core:**
    - `listingSchema`.
    - `LISTING_MANUAL_TRANSITIONS`, sin `active` ni `closed` hasta F3.
    - `changeListingStatus`: `ready` exige una foto, y el cambio es condicional.
    - Repositorios: `list`, `get` y `changeStatus` de avisos, `list` de corredores y `listCovers` de medios, en Drizzle, en los dobles y en la suite de contrato.
  - **Rutas:** `/listings` (con la portada como URL firmada), `/listings/:id` (con sus medios), `PATCH /listings/:id/status` y `/brokers`.
  - La web y la CLI usan el `errorBodySchema` compartido; `@agentsales/api` pasa a `dependencies`. La web compila.
  - **Tests:** de rutas con `app.request` y dobles en memoria. Probé 4 mutaciones y todas hacen fallar algún test.
  - **Correcciones de `/revisar`:**
    - Una fila corrupta en la base (`*_ROW_INVALID`) responde 500 con su código, no 400.
    - Un JSON mal formado da `INVALID_JSON` en español, también desde `hono/validator`.
    - `ErrorBody` sale de `contracts`.
    - `LISTING_MANUAL_TARGETS` en core.
    - `contracts` sin `../`, con su test.
    - Corredores ordenados igual en Postgres y en memoria (sin mayúsculas, por bytes).
    - Quedaron anotados: `externalRef` para T12; etiquetas de atributos y TTL de las URLs para T13; la tabla de estados provisional para F3; la lista completa como deuda de F7.
- 2026-10-01: **F1-T09.** Job `import.run`.
  - **Core:**
    - `requestImport`: crea el run y encola; con `QUEUE_UNAVAILABLE`, deja el run en `failed` y borra el staging.
    - `runImport`, que es el handler: guarda terminal, `running`, xlsx, `importListings`, medios, `ingestMedia` y `succeeded`. Con un error final, `markFailed` antes de relanzar.
    - Estados del run, condicionales, en el puerto, el doble y Drizzle, con la suite de contrato.
  - **Worker:**
    - `defineJob` tipado por `JobName` y con el esquema de `JOB_PAYLOADS`.
    - `QueuePolicy.policy`, que solo va a `createQueue`; `import.run` usa `exclusive`.
    - `isLastAttempt`, con `includeMetadata`.
    - `buildJobs(deps)`, y la composición en `worker.ts` con db, R2, el lector de xlsx y el staging.
    - El log de cada intento lleva los datos del job (`importRunId`).
  - **Staging:** `extracted/` por intento, `input/` hasta el estado terminal y limpieza al arrancar. Un zip con una sola carpeta en la raíz se desenvuelve si ahí están las carpetas pedidas, como decía la decisión abierta de T06.
  - **Tests:** casos de uso, staging, registro y job. Probé 10 mutaciones y todas menos una hacen fallar algún test. La que sobrevive es la guarda terminal, redundante con `markRunning`: el comportamiento es el mismo.
  - **Correcciones de `/revisar`:**
    - Al arrancar, el worker cierra los runs abandonados: más de 7 h en `running`, por un proceso que murió o una base caída en el último intento.
    - Un error que no es `AppError` se normaliza: el job se cierra, sin gastar reintentos.
    - Si `markFailed` falla, el motivo original va como `cause`.
    - `markSucceeded` sin efecto da `skipped`.
    - Un directorio de extracción por intento, así dos intentos no se pisan.
    - La limpieza del staging no se corta por un error. Primero borra por antigüedad, sin base, y a los huérfanos les da 10 minutos de gracia.
    - El worker avisa si una cola existe con otra política.
    - `openMedia` tiene un contrato más estrecho.
    - Tests nuevos, y 8 mutaciones probadas: todas hacen fallar algún test.
    - Para T11 quedaron anotados el id del run generado por quien llama y `createStaging` en `importers`.
  - **Prueba de humo:** el worker arranca contra Neon con `system.ping` e `import.run`, lo que crea la cola `import.run` como `exclusive`, y se apaga limpio. La prueba de punta a punta con Neon y R2 llega en T12, con la CLI y las propiedades de muestra.
- 2026-10-01: **F1-T08.** `packages/queue`.
  - **Productor (`createJobQueue`):** arranca pg-boss en el primer `enqueue`, valida los datos con `JOB_PAYLOADS` y convierte cualquier falla de la cola en `QUEUE_UNAVAILABLE` (reintentable, 503). Si falla el arranque, el siguiente `enqueue` reintenta.
  - **Se mudaron de `db` y del worker a `packages/queue`:** `createBoss`, `QUEUE_SCHEMA` y `checkQueueSchema`. `QUEUE_NOT_INITIALIZED` desaparece.
  - **Contrato en core:** `JOB_NAMES` y `JOB_PAYLOADS`, con `system.ping` e `import.run`.
  - **Dependencias:** el paquete no depende de `@agentsales/db`; la conexión llega convertida, y se agregó a la regla de Biome de adaptadores.
  - **Demo:** con el worker corriendo, `pnpm worker:ping` encola con el productor nuevo, el worker responde "pong" y se apaga limpio.
  - **Correcciones de `/revisar`:**
    - El productor refresca su caché de colas una vez al día: antes consultaba Neon cada 60 s y no lo dejaba dormir.
    - El mensaje "arranca el worker" solo sale con los errores exactos de pg-boss.
    - `stop()` cierra un arranque en curso y deja la cola cerrada.
    - `JOB_PAYLOAD_INVALID` responde 500.
    - Se quitó `pg-boss` de las dependencias del worker.
    - Tests nuevos: arranque compartido que falla, `onError`, opciones ausentes y configuración de `createBoss`. Probé 4 mutaciones y todas hacen fallar algún test.
    - Quedaron anotados en el spec: para T09, `policy` (`exclusive`, inmutable), `defineJob` tipado y `requestImport`; para T11, `onError` resumido y `stop()`.
    - Pendiente del operador: `CLAUDE.md` (sección Estructura) no lista `queue`; no lo edité porque es el archivo de instrucciones.
- 2026-10-01: **F1-T07b.** `MediaRepository` en Drizzle y `ChecksumSHA256` en R2.
  - **Checksum adoptado.** Contra R2 real (`storage:check`), el sha256 correcto se acepta y el de otro contenido da `BadDigest`, sin guardar el objeto. Ahora R2 detecta un archivo que cambió entre la lectura y la subida. Línea en ADR-0007.
  - **Postgres:**
    - Conflictos de los únicos → `MEDIA_CONFLICT`.
    - Una sola portada por propiedad, garantizada por el repositorio.
    - Solo se consideran originales.
    - `setLogo` rechaza un medio ajeno (`MEDIA_NOT_FOUND`).
    - `arrange` inválido → `MEDIA_ARRANGE_INVALID` (`checkArrangement` en core).
  - **Tests:**
    - Suite de contrato de `MediaRepository`, contra el doble y contra PGlite.
    - Filtro de originales probado con PGlite.
    - Carga de punta a punta (`importListings` + `ingestMedia`) contra PGlite.
    - Tests msw del header.
    - Probé 7 mutaciones y todas hacen fallar algún test.
  - **Nota de operación:** el SDK imprime "An error was encountered in a non-retryable streaming request." cuando R2 rechaza; es esperable.
  - **Correcciones de `/revisar`:**
    - `arrange` bloquea el aviso: dos intentos del job solapados no dejan dos portadas ni se bloquean entre sí. PGlite no puede probar la concurrencia; queda documentado.
    - Test de rollback de `arrange`, con un trigger que falla a mitad.
    - `checkArrangement` valida `sortOrder`.
    - `BadDigest` se reconoce también por `Code`.
    - Tests del sha256 en mayúsculas y del largo distinto con sha256.
    - Se rompió el ciclo de módulos de los dobles (`testing/copy.ts`).
    - Docs: contrato de repositorios, D3, ADR-0007 en orden y modelo de datos.
  - **CI:** falló un test de T06 que contaba los descriptores de archivo del proceso (inestable en Linux: 26 contra 25). Ahora intercepta `open` y verifica que el lector cierra el archivo.
- 2026-10-01: **F1-T07.** `ingestMedia` en core. Plan aprobado: partida en T07 (core) y T07b (adaptadores).
  - **Decisiones:**
    - Sin reintentos por archivo: el reintento es del job, y la deduplicación evita volver a subir.
    - `STORAGE_CONTENT_MISMATCH`, nuevo en `putStream` (antes `STORAGE_ERROR`): el contenido no es el anunciado y es advertencia del archivo. `STORAGE_ERROR` (credenciales) sigue haciendo fallar el run.
    - `ChecksumSHA256` va a T07b, con la nota `docs/integraciones/r2-checksums.md` y la condición de que R2 rechace un sha256 erróneo en `storage:check`.
  - **Puertos:**
    - `MediaRepository` (`listOriginals`, `findByStoragePath`, `create` con `MEDIA_CONFLICT`, `arrange`), con doble en memoria; Drizzle en T07b.
    - `promoteToReady`, `setLogo` y `recordMediaResult` ya tienen Drizzle y suite de contrato con PGlite. Sin ellos, `packages/db` no compilaba.
  - **Dobles:** `MediaStorage` en memoria (largo distinto → `STORAGE_CONTENT_MISMATCH`, registra las subidas) y `MediaFileSource` en memoria (`memoryFile`).
  - **Reporte:** `media` (`filesUploaded`, `filesExisting`, `filesSkipped`, `filesFailed`) más las advertencias por fila. Las del logo van a `broker.warnings`.
  - **Comportamiento:**
    - Los medios que ya no están en la carpeta se conservan, al final y sin portada.
    - Un video no cuenta como foto para `ready`.
    - Sin `--media`, las fotos que el aviso ya tenía bastan para pasar a `ready`.
  - **Tests:** 28 del caso de uso, más los dobles. Probé 12 mutaciones (deduplicación, filas `skipped`, portada, `promoteToReady`, clasificación de errores, `dry_run`, logo) y todas hacen fallar algún test.
  - **Correcciones de `/revisar`:**
    - Sin carpeta legible (sin `--media` o `MEDIA_FOLDER_*`), reimportar ya no cambia la portada elegida. Antes saltaba a otra foto, con una advertencia falsa.
    - Si la carpeta solo trae videos, se conserva la portada.
    - `dry_run` advierte "Sin fotos" también para avisos nuevos.
    - Las advertencias usan textos fijos, sin la clave en R2.
    - Invariante `MEDIA_INGEST_STATE_INVALID`.
    - Tests nuevos:
      - `MEDIA_CONFLICT`, y R2 que acepta la subida mientras falla la inserción, con el reintento convergiendo;
      - fila `updated` que cambia de carpeta;
      - `paused` con fotos;
      - `arrange` solo si cambió;
      - `STORAGE_ERROR` en una fila.
    - Probé 6 mutaciones más, y todas hacen fallar algún test.
    - Los hallazgos para Postgres (una sola portada, `role`, `setLogo` con FK) quedaron anotados en T07b, y lo de `media` ausente, para T10 y T12.
- 2026-10-01: **F1-T06.** Lectores de medios en `packages/importers`.
  - **Puerto `MediaFileSource` en core.** Plan aprobado con tres cambios al spec:
    - `list` devuelve `{ files, skipped }`, con `MEDIA_SKIP_REASONS`;
    - `folder` es relativo a la raíz del adaptador y no puede salir de ella (`MEDIA_FOLDER_INVALID`), porque `carpeta_medios` viene del Excel;
    - el tope de video lo aplica el adaptador, sin hashear.
  - **`createMediaFolderSource`:** firmas propias, sin dependencias. El sha256 se calcula en streaming, y no sigue enlaces simbólicos (`O_NOFOLLOW`).
  - **`extractZip`** con **yauzl 3.4.0** (dependencia nueva del spec, más `@types/yauzl`):
    - Topes de entradas y de bytes, y `validateEntrySizes` contra zip bombs.
    - Un zip-slip rechaza el zip completo.
    - Omite los enlaces simbólicos.
    - Código nuevo `IMPORT_EXTRACT_FAILED`, para cuando el problema es el disco y no el zip.
  - **Tests:** los zips se arman con un generador propio (`test/zip-builder.ts`, con `stored` y `deflate`, y nombres hostiles a mano). Probé con mutaciones que fallan si se quita cada protección: validación de tamaños, enlaces, tope de bytes, raíz de la carpeta y tope de video.
  - **Pendiente para T09:** desenvolver un zip con una sola carpeta raíz (anotado en §4.3 del spec).
  - **Correcciones de `/revisar`:**
    - La carpeta tampoco sale de la raíz por un enlace simbólico (`realpath`).
    - Un zip con nombres `./…` ya no extrae 0 archivos, y `extractZip` cuenta las entradas omitidas (`skipped`).
    - El test de la contraseña ahora ejerce la comprobación propia.
    - `MediaFile.extension` es canónica.
    - Nombres repetidos o en conflicto se detectan antes de escribir, y un destino sucio es `IMPORT_EXTRACT_FAILED`.
    - Desempate binario del orden.
    - Un `EIO` en un archivo es `MEDIA_FOLDER_UNREADABLE`.
    - Marcas `hevm` y `hevs`, y AVIF y audio no son video.
    - Test de que `open()` cortado cierra el archivo.
    - T07 anotado en el spec: los fallos de un archivo son advertencias, y el doble de `MediaFileSource`.
- 2026-10-01: **F1-T05.** `MediaStorage.putStream`.
  - En R2 es un solo `PutObject` con `Content-Length`, sin `lib-storage`, desde un cliente S3 aparte sin reintentos y sin el checksum por defecto del SDK. Con ese checksum, el stream viaja en `aws-chunked` y sin `Content-Length` (lo verifiqué con msw).
  - **Bug encontrado y corregido antes del commit:** si el stream trae otro largo o falla al leerse, el generador avisa y termina **sin lanzar**, y `putStream` aborta la petición. Lanzar dejaba la petición colgada y un `error` sin escuchar, que en el worker tumbaría el proceso.
  - `storage:check` sube 1 MB en streaming contra R2: OK.
  - Correcciones de `/revisar`:
    - Un `AppError` del lector de origen pasa tal cual.
    - El `error` del stream aborta la petición.
    - `contentLength` validado.
    - `maxAttempts: 1` es defensivo: verifiqué que el SDK ya no reintenta streams.
    - D3 corregido, más una línea en ADR-0007.
    - `hookTimeout` de 30 s para PGlite bajo carga.
    - `ChecksumSHA256` y los reintentos por archivo se deciden en T07.
- 2026-10-01: **F1-T04b.** Repositorios Drizzle de brokers, listings e import_runs.
  - Los conflictos de los únicos son `*_CONFLICT`, reintentables.
  - `price_amount` se escribe con `toFixed(2)`.
  - `get` valida los jsonb (`IMPORT_RUN_INVALID`).
  - **Migración `0002`:** `import_runs.report` admite `null`, con un `UPDATE` de `'{}'` a `NULL` agregado a mano; aplicada en Neon (demo del plan aprobado).
  - Correcciones de `/revisar`: `BROKER_ROW_INVALID` en vez de `ZodError`, tests de `updated_at`, `auto_publish` y logo, de `isUniqueViolation` y de que un reporte real sobrevive a `0002`.
  - **Tests:** una suite de contrato corre los mismos casos contra los dobles en memoria y contra PGlite. También hay un test de punta a punta de `importListings` contra Postgres (PGlite) y uno de la migración `0002` sobre datos.
- 2026-09-30: **F1-T04.** `importListings` en core, con la tarea partida en T04 (core) y T04b (Drizzle).
  - Hoja Corredor: `parseBrokerSheet` compara las etiquetas sin mayúsculas ni tildes y avisa las repetidas. `--broker` gana sobre el slug de la hoja.
  - `source_hash` sobre `{ core, attributes, control }`.
  - Un aviso nuevo nace en `draft`, y T07 lo pasa a `ready`.
  - `id_propiedad` repetido en la hoja → `failed`. Un `id_propiedad` numérico se busca ya normalizado, para no duplicar.
  - Nuevos en core: `importReportSchema`, `importRunSchema`, `brokerSchema` y `LISTING_CATEGORIES`, más los puertos de brokers, listings e import_runs con sus dobles en memoria.
  - `toDbError` guarda como `cause` un resumen sin datos del error del driver (ni `params`, ni `detail`, ni el mensaje), y los demás errores de consulta son `DB_QUERY_FAILED`.
  - Correcciones de `/revisar`:
    - `dry_run`, el origen y el `--broker` salen del run (`importRunInputSchema`).
    - Una fila que falla al escribir con un error no reintentable queda `failed`, y la carga sigue.
    - Conflictos reintentables (`*_CONFLICT`).
    - El reporte suma `listingId`, `warnings` y `headers` que puede ser `null`.
    - `externalRef` sale con `validator.refOf`.
    - Hashtags sin repetidos y con `#`.
    - Los métodos que se suman después quedaron anotados en T04b, T07, T09, T10 y T11.
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
- 2026-09-30: **F0 cerrada.** Monorepo con `core`, `config`, `db` (Neon, migración `0000_init`), `storage` (R2), API (`/health`), worker (pg-boss), CLI (`doctor`/`status`) y panel. CI en GitHub Actions. 321 tests. Detalle en `CHANGELOG.md` `[0.0.1]` y en el spec F0.
- 2026-09-30: demo de F0 confirmada por el operador. Arreglo derivado: el worker resume los errores repetidos de pg-boss sin conexión.
- 2026-09-30: el operador decide dejar el repo **sin licencia** (todos los derechos reservados).
- 2026-09-30: el repo `vicentewolde/AgentSales` es **público**, y `main` tiene protección de rama: check `check` obligatorio, rama al día, aplica también a administradores, sin force push. El historial se revisó antes de publicarlo y no tiene secretos.
- **Recordatorios de operación:**
  - `pnpm dev` levanta API, worker y panel; hay que apagarlo al terminar, porque mantiene Neon despierto.
  - `pnpm -s cli doctor` necesita `pnpm dev` corriendo.
