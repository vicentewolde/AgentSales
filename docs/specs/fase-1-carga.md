# Spec F1 · Carga de propiedades y medios

- **Estado:** Aprobado (2026-09-30)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.1.0`
- **Referencias:** `docs/06-roadmap.md#f1--carga`, ADR-0005 (enmendado), ADR-0006, ADR-0007, ADR-0010, ADR-0011, `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `data/plantillas/plantilla_propiedades.xlsx`

## 1. Objetivo
El operador carga un Excel con propiedades y una carpeta de fotos y videos, y las ve ordenadas en el panel y la CLI, listas para generar contenido en F2.

## 2. Alcance
- Definiciones de campos globales para `real_estate`, sembradas desde la plantilla.
- Validador dinámico construido desde `field_definitions`.
- Lectura del Excel (hojas **Propiedades** y **Corredor**).
- Importación idempotente con reporte por fila, ejecutada por el worker como job `import.run` (D2).
- Ingesta de medios desde carpetas locales o desde un .zip, subidos a Cloudflare R2.
- API, CLI y panel para importar y ver propiedades.

## 3. Fuera de alcance
- Google Sheets y carpetas de Google Drive (F1b, opcional; se decide al cerrar F1).
- Procesamiento de medios (recortes, variantes, HEIC → jpg) y sus metadatos (ancho, alto, duración): F2 (D6).
- `link_video` y `link_tour_360`: se guardan como atributos; no se descargan.
- Edición manual de propiedades en el panel (solo lectura en F1, salvo cambiar `status`).
- Reducir el bundle del panel (D5): deuda hasta F7.

## 4. Diseño

### 4.1 Componentes
- **Nuevo `packages/importers`:** `xlsx-reader` (exceljs), `media-folder` (implementa `MediaFileSource`) y `zip`.
- **Nuevo `packages/queue`** (D2): adaptador de pg-boss extraído de `apps/worker/src/queue.ts`, que implementa el puerto `JobQueue`. Se lleva `QUEUE_SCHEMA` y `checkQueueSchema` desde `@agentsales/db`. En rol `producer` arranca pg-boss de forma diferida, en el primer `enqueue`, para que la API levante aunque el esquema `pgboss` no exista.
- **core** (sin fs, sin `node:*` y sin tipos de Node: el panel importa core):
  - Casos de uso:
    - `importListings(deps, { runId, input: ListingSheetInput })` recibe `{ headers, rows, broker }`, ya leído por `xlsx-reader`; no lee archivos. `headers` sirve para `checkHeaders`. `ListingSheetInput` es de core y el lector depende de él. `dry_run`, el origen y el `--broker` salen del run (`import_runs.input`, con `importRunInputSchema`).
    - `ingestMedia`.
    - `requestImport`: crea el run y encola; si `enqueue` falla, deja el run en `failed`.
    - `changeListingStatus`.
  - `buildListingValidator(fieldDefs)`.
  - **sha256:** se inyecta como `deps.sha256(text): Promise<string>`; el worker lo compone con `node:crypto`.
  - **Puertos:**
    - `FieldDefinitionRepository`, `BrokerRepository`, `ListingRepository`, `MediaRepository` e `ImportRunRepository`.
    - `JobQueue`.
    - `MediaFileSource.list(folder): Promise<{ files: MediaFile[], skipped: SkippedMediaFile[] }>` (F1-T06):
      - `MediaFile = { relPath, kind, mime, extension, bytes, sha256, open(): AsyncIterable<Uint8Array> }`. `extension` es la canónica, en minúsculas y sin punto (`jpeg` → `jpg`), para la clave en R2.
      - `SkippedMediaFile = { relPath, reason }`, con `reason` en `MEDIA_SKIP_REASONS`: `unsupported_type`, `signature_mismatch`, `empty`, `too_large`, `not_a_file` o `unreadable`.
      - `folder` es relativo a la raíz de medios con que se construye el adaptador (`carpeta_medios`, `id_propiedad` o `_marca`) y no puede salir de ella, tampoco a través de un enlace simbólico (`MEDIA_FOLDER_INVALID`).
      - Si no existe, `MEDIA_FOLDER_NOT_FOUND`. Si no se puede leer la carpeta, o el disco falla con un archivo (`EIO`), `MEDIA_FOLDER_UNREADABLE`.
      - Si `open()` falla al releer un archivo, `MEDIA_FILE_UNREADABLE`.
      - Ninguno de estos errores es reintentable.
  - **Contrato de jobs** en `core/src/jobs.ts` (`JOB_NAMES`, `JOB_PAYLOADS`).
  - **Entidades con esquema zod** (`listing`, `media`, `broker`, `importRun`, `importReport`) y tuplas nuevas (`IMPORT_RUN_STATUSES`, `LISTING_MANUAL_TRANSITIONS`), según ADR-0011. `media` quedó sin esquema en core (`MediaRecord` es una proyección): la API expone `mediaItemSchema` en `contracts` (F1-T10).
  - **Repositorios en memoria** en la salida `@agentsales/core/testing`. Biome prohíbe importarla fuera de los tests.
- **`MediaStorage`:** agrega `putStream` para videos de hasta `MAX_VIDEO_MB` (D3).
- **db:**
  - Migración `0001` (§4.5), implementaciones Drizzle de los repositorios y seed de `field_definitions`.
  - `TEMPLATE_COLUMNS` en `seed-data.ts`.
  - Helper que traduce los errores de conexión de `pg` a `AppError("DB_UNAVAILABLE", { retriable: true })`.
- **api:**
  - Salida `@agentsales/api/contracts` (ADR-0011), limitada por Biome a `zod`, `@agentsales/core` e imports relativos.
  - Rutas en `apps/api/src/routes/<recurso>.ts`, montadas con `.route()` dentro de la cadena de `createApp` para que `AppType` no pierda el esquema.
  - **Lo que depende de Node** (escribir en disco, leer `NODE_ENV`) entra por `AppDeps` y se compone en `server.ts`, según la regla "Tipos alcanzables desde `AppType`":
    - `AppDeps.uploads.save(runId, name, body)`.
    - `AppDeps.localImports: boolean`.
- **worker:** job `import.run`; `JOBS` pasa a `buildJobs(deps)`.
- **Rutas en disco:**
  - Staging en `<workspace>/tmp/imports/{id}/`, resuelto con `findWorkspaceRoot()` en los puntos de entrada, porque `pnpm --filter` corre cada app en su carpeta.
  - `import_runs.input` guarda rutas absolutas.
  - La CLI resuelve las rutas relativas contra `INIT_CWD ?? process.cwd()` y verifica que existan antes de llamar a la API.
- **cli:** `createApiClient` + `unwrap`, un comando por archivo, y comandos `import`, `imports`, `listings` y `listing`.
- **web:** `createApiClient` + `unwrap`, `ApiClientContext`, hooks por recurso y `routes.tsx`; páginas Propiedades, Detalle e Importar.

### 4.2 Reglas de importación
- **Filas ignoradas:** la fila con `id_propiedad = EJEMPLO` y las filas con `estado_carga = Borrador`. Las filtra `importListings` (T04) con `validator.isIgnored(row)`, que usa las columnas ya resueltas por `source_column`. Así el filtro sigue funcionando si un corredor cambia el encabezado.
- **Hoja Corredor:** es vertical. Cada fila es un campo; las columnas se ubican por su encabezado (`Campo` y `Tu valor`), no por letra.
  - Crea o actualiza el broker por `slug`, derivado de `nombre_marca` o dado con `--broker`.
  - Si viene vacía y se pasa `--broker <slug>`, usa ese broker existente; si no existe, `BROKER_NOT_FOUND`.
  - Si viene vacía y sin `--broker`, `BROKER_INVALID`.
  - Mapeo a `brokers`:

    | Campo | Columna | Transformación |
    |---|---|---|
    | `nombre_corredor` | `name` | obligatorio |
    | `nombre_marca` | `brand_name` (y `slug`) | obligatorio |
    | `logo` | `logo_media_id` | se busca en `<mediaDir>/_marca/` (§4.3) |
    | `color_primario` | `primary_color` | obligatorio, HEX `#RRGGBB` |
    | `color_secundario` | `secondary_color` | HEX; si viene vacío, el primario |
    | `whatsapp` | `whatsapp` | |
    | `email` | `email` | |
    | `instagram` | `instagram_handle` | sin `@` |
    | `sitio_web` | `website` | |
    | `tono` | `tone` | |
    | `hashtags_fijos` | `fixed_hashtags` | separados por **espacio** |

  - Una hoja Corredor con errores no crea el broker, y el run falla con `BROKER_INVALID` y el detalle en el reporte.
- **Columnas con destino fijo** (`CORE_FIELD_TARGETS` en core; el resto va a `attributes`):

  | Columna | Destino | Transformación |
  |---|---|---|
  | `id_propiedad` | `listings.external_ref` | obligatorio |
  | `operacion` | `operation` | `Venta` → `sale`, `Arriendo` → `rent` |
  | `tipo` | `property_type` | opciones de la hoja Listas |
  | `region`, `comuna`, `direccion`, `numero_unidad` | `region`, `comuna`, `address`, `unit_number` | |
  | `mostrar_direccion_exacta` | `show_exact_address` | `Sí/No` |
  | `precio` | `price_amount` | obligatorio, mayor que 0 y dentro de `numeric(14,2)` (hasta 12 dígitos enteros) |
  | `moneda` | `price_currency` | obligatorio, `UF` o `CLP` |
  | `destacados` | `highlights` | |
  | `notas_internas` | `internal_notes` | nunca va a la IA ni a las plataformas |
  | `estado_carga`, `carpeta_medios`, `foto_portada` | control de la importación | no se guardan en `attributes` |

  Las 36 columnas tienen su definición en el seed, incluidas las de control (con `is_core = true`), para que el validador las conozca. `acepta_mascotas` es un enum (`Sí`, `No`, `A consultar`), no un boolean.
- **Normalización:**
  - `Sí/No` → boolean.
  - Números con puntos o espacios → number (`5.800` → 5800).
  - Trim de textos.
  - Listas separadas por coma → arrays.
  - Celdas numéricas o de fecha que Google Sheets exporta como texto se aceptan igual.
- **Validación por fila** contra las definiciones efectivas del corredor (la del corredor sobrescribe la global con el mismo `key`): tipos, obligatorios y opciones de enum. Los errores se acumulan con fila, columna y motivo; nunca se detiene la carga completa.
- **Upsert** por `(broker_id, external_ref)`:
  - `source_hash` es el sha256 de los datos normalizados en forma canónica (claves ordenadas).
  - Si no cambió → `skipped`; si cambió → `updated`.
- **Fila con errores:** una fila con cualquier error de validación no se crea ni se actualiza, y cuenta en `rows_failed`. Si ya existía, se conserva la versión anterior.
- **Estado del listing:**
  - Una propiedad válida queda en `ready` si `estado_carga = Listo` y tiene al menos una foto. Si no, queda en `draft` con advertencia.
  - Reimportar no pisa un estado puesto a mano (`paused`, `archived`) ni los de F3+ (`active`, `closed`).
- **Medios en cada importación:** `ingestMedia` corre también para las filas `skipped`, así que agregar fotos a la carpeta sin tocar el Excel sí las sube.
- **Reintentos:** si el job se reintenta, lo que el primer intento ya creó aparece como `skipped` en el reporte final.
- **Columnas desconocidas:** se reportan como advertencia y se guardan en `attributes._extra`, para no perder datos.
- **`dryRun`:** valida y arma el reporte completo, incluidos los medios que se subirían. Solo escribe el `import_run` (con `dry_run = true`): no crea brokers, listings ni medios, ni sube archivos.

### 4.3 Reglas de medios
- **Carpeta por propiedad:** `<mediaDir>/<carpeta_medios>/`, y si la columna viene vacía, `<mediaDir>/<id_propiedad>/`. El logo va en `<mediaDir>/_marca/logo.png`.
- **Tipos aceptados:** jpg, jpeg, png, webp, heic (se convierte a jpg en F2), mp4 y mov. El tipo se decide por extensión y se verifica con la firma del archivo. Otros → advertencia.
- **Orden:** por nombre de archivo, en orden natural (`2` antes de `10`; `Intl.Collator` con `numeric`).
- **Portada:** `foto_portada` si existe; si no, la primera foto. Al cambiar la portada, la anterior se desmarca. En F2 la IA puede sugerir otra.
- **Deduplicación por sha256:** si el mismo archivo ya existe para esa propiedad, no se vuelve a subir.
- **Orden de escritura:** primero se sube a R2 y después se inserta la fila en `media`. Como el `storage_path` es determinístico, volver a subir tras un fallo solo sobrescribe el mismo objeto.
- **Metadatos:** ancho, alto y duración quedan en `null` en F1. Los mide `media.process` en F2 con sharp y ffprobe (D6).
- **Límite:** un video de más de `MAX_VIDEO_MB` se omite con advertencia.
- **Clave del objeto en R2:** `brokers/{brokerId}/listings/{listingId}/original/{sha256}.{ext}`. El logo va en `brokers/{brokerId}/brand/{sha256}.{ext}`: el único parcial de `media` no lo cubre (`listing_id` es `null`), pero `UNIQUE (storage_path)` sí.
- **Zip:**
  - Se descomprime en streaming en `tmp/imports/{id}/extracted-{uuid}/`, un directorio por intento (desde T09).
  - Protección contra zip-slip: se rechazan rutas absolutas o con `..`, y se verifica que el destino quede dentro del directorio.
  - Topes: 4 GB descomprimidos y 2000 entradas.
  - Se omiten los enlaces simbólicos, `__MACOSX/` y los archivos ocultos.
  - **Zip con una sola carpeta en la raíz** (macOS → Comprimir "medios"), decidido en T09: se desenvuelve si ninguna carpeta que la carga pide está en la raíz pero sí dentro de esa única carpeta. Un zip con una sola propiedad en su raíz no se toca.
- **Staging:**
  - `tmp/imports/{id}/input/` guarda el xlsx y el zip subidos. Se borra solo cuando el run llega a un estado terminal (`succeeded` o `failed`), para no perderlos entre reintentos.
  - `extracted-{uuid}/` es de un intento y se borra en un `finally`.
  - Al arrancar, el worker limpia los directorios de runs terminales y los de más de 24 h.
- Una propiedad sin ninguna foto queda en `draft` con advertencia (mínimo 1 foto para `ready`).

### 4.4 Contratos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/imports` | multipart `file` (xlsx) + `media` (zip, opcional) + `broker` (opcional) + `dryRun`. Guarda los archivos en `tmp/imports/{id}/`, crea el `import_run` en `queued`, encola `import.run` y responde `202` con el run (`ImportRunView`: `input` solo con nombres de archivo) |
| POST | `/imports/local` | `{ xlsxPath, mediaDir?, broker?, dryRun? }`, solo cuando `NODE_ENV=development` (la CLI; `csrf()` bloquea `multipart` sin `Origin`). Responde `202` |
| GET | `/imports` · `/imports/:id` | historial, y estado más reporte. `input` se muestra solo como nombres de archivo, sin las rutas completas |
| GET | `/listings?status=&operation=&comuna=` | lista con portada (URL firmada) |
| GET | `/listings/:id` | detalle con medios (URLs firmadas) y atributos |
| PATCH | `/listings/:id/status` | cambio manual según `LISTING_MANUAL_TRANSITIONS` (a `ready`, `paused` o `archived`). `ready` exige al menos una foto. Una transición no permitida es `409 INVALID_TRANSITION` |
| GET | `/brokers` | para el selector de corredor en Importar |

- **Entrada:** se valida con zod mediante un helper propio sobre `hono/validator`, que lanza `AppError("REQUEST_INVALID")`. No se usa `@hono/zod-validator`, que sería una dependencia nueva.
- **Salida:** se tipa con los esquemas de `@agentsales/api/contracts`.
- **Lógica:** crear el run y encolar (`requestImport`) y las reglas de estado (`changeListingStatus`) son casos de uso de core, no código de las rutas.
- **`/imports/local`:** se habilita con `AppDeps.localImports`, que `server.ts` activa cuando `NODE_ENV=development`.
- **Límites:**
  - `c.req.parseBody()` carga el multipart completo en memoria. Por eso el tope es `MAX_IMPORT_UPLOAD_MB` (nueva variable, default 1024) para todo el cuerpo, con `bodyLimit`.
  - El xlsx no puede pasar de 10 MB; eso se verifica después de leer el cuerpo.
  - En F7, con despliegue, la subida pasa a ser directa a R2 con una URL prefirmada (deuda).
- **Errores de cola:** `QUEUE_NOT_INITIALIZED` (hoy 500) se unifica con `QUEUE_UNAVAILABLE` (503).

CLI:
```
agentsales import <xlsx> [--media <dir|zip>] [--broker <slug>] [--dry-run] [--no-wait]
agentsales imports [<id>]
agentsales listings [--status ready] [--json]
agentsales listing <external_ref|id> [--json]
```
`import`:
- Usa `/imports/local` y luego consulta `/imports/:id` cada 2 s hasta que termina, mostrando el progreso.
- Al final muestra un resumen (creadas, actualizadas, omitidas y con error, más los medios subidos y omitidos) y la tabla de errores por fila y columna.
- Con `--no-wait` imprime el id y sale.
- Si el run sigue en `queued` después de 20 s, avisa "sigue en cola: ¿está corriendo el worker?".
- Deja de esperar a las 2 h con "sigue en curso: `agentsales imports <id>`".

### 4.5 Datos
Migración `0001` (`0000_init` ya está aplicada y no se edita):
- **`field_definitions`:** `UNIQUE NULLS NOT DISTINCT (broker_id, category, key)`, con `unique().on(...).nullsNotDistinct()` de Drizzle (PG ≥ 15). Es el destino del upsert del seed y la garantía de que el corredor sobrescribe la definición global.
- **`media`:**
  - Único parcial `(listing_id, checksum) WHERE role = 'original'`.
  - `UNIQUE (storage_path)`.
- **`import_runs`:**
  - `status`: enum `import_run_status` desde la tupla `IMPORT_RUN_STATUSES` de core (`queued`, `running`, `succeeded`, `failed`), con default `queued`.
  - `dry_run boolean default false`.
  - `input jsonb`: rutas absolutas de entrada y broker pedido, sin secretos. Así el payload del job lleva solo `importRunId`.
  - `error jsonb null`: `{ code, message }`.
  - `broker_id` pasa a `null`, porque se conoce recién al leer la hoja Corredor.
  - `started_at` pasa a `null` sin default. Se fija al pasar a `running`; con `queued`, un `now()` mentiría.
- **Seed:**
  - Las 36 `field_definitions` globales (`category = real_estate`), con `key`, `label`, `type`, `required`, `options`, `source_column` e `is_core`.
  - Upsert idempotente sobre el único nuevo. Igual que el seed del broker demo, **pisa los cambios hechos a mano en las definiciones globales**: para personalizar, se crea una definición del corredor.
- Se actualiza `docs/02-modelo-datos.md` en la misma tarea.

### 4.6 Cola: job `import.run` (D2)
- **Encolar:** `requestImport` crea el run en `queued` y encola con `JobQueue` (rol `producer`). Si `enqueue` falla, el run pasa a `failed` con `QUEUE_UNAVAILABLE`, se borra el staging y la API responde `503`.
- **Payload:** `{ importRunId }`.
- **Política:** `singletonKey = importRunId`, 2 reintentos con backoff desde 30 s y expiración a las 2 h. Varios videos de 300 MB con una subida doméstica pueden tardar, y pg-boss no aborta un intento que expira.
- **Handler:**
  - Si el run ya está en `succeeded` o `failed`, no hace nada. Esa guarda evita que dos intentos se pisen.
  - Pasa el run a `running`, lee el xlsx y llama a `importListings` y luego a `ingestMedia`. Al terminar lo deja en `succeeded`.
  - Con un error no reintentable, o en el último intento (`retryCount >= retryLimit`, leído con `includeMetadata`), deja el run en `failed` con `error` **antes** de relanzar.
    - Un error que no es `AppError` se normaliza a `INTERNAL_ERROR`, no reintentable: el job se cierra.
    - Si `markFailed` falla, se lanza ese error con el original como `cause`.
  - **Runs abandonados:** si el proceso muere, o la base no responde justo en el último intento, el run puede quedar en `running`.
    - Al arrancar, el worker cierra los `running` con `started_at` de hace más de 7 h (3 intentos de 2 h más una hora de margen) como `failed` con `IMPORT_ABANDONED` (`ImportRunRepository.failAbandoned`).
    - Los `queued` no se tocan: su job sigue en la cola si el worker estuvo apagado.
  - **Intentos solapados** (dos workers, o uno que expiró y sigue corriendo): cada intento extrae el zip en su propio `extracted-{uuid}/`, y el primer estado terminal gana. Si `markSucceeded` no cambia nada, el intento informa `skipped`, no éxito.
- **Idempotencia:** el upsert por `external_ref`, la deduplicación por sha256 y el `storage_path` determinístico hacen que reintentar no duplique nada.
- **Errores reintentables:** `STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE` y los conflictos de intentos solapados (`BROKER_CONFLICT`, `LISTING_CONFLICT`, `MEDIA_CONFLICT`). El handler decide con `retriable` del `AppError`, no con una lista.
- **Cada intento corre las dos etapas:** `importListings` y después `ingestMedia`. El resultado de `importListings` (con el `control` de cada fila) vive solo en memoria, así que no se puede reanudar solo la ingesta. Al reintentar, `recordListingsResult` deja el reporte sin `media` hasta que `recordMediaResult` lo repone.
- **Worker apagado:** si la cola existe pero el worker no corre, la API responde `202` y el run queda en `queued`. La CLI y el panel lo avisan a los 20 s ("sigue en cola: ¿está corriendo el worker?"). Si el esquema `pgboss` no existe, el `enqueue` falla y aplica el primer punto.
- **Estado compartido:** en el MVP, la API y el worker comparten disco local (`<workspace>/tmp/imports`).
- **ADR-0005:** enmendado en el PR de este spec con el job `import.run` y el disco compartido.

### 4.7 Comportamiento sin red
- **Neon caído:**
  - La API responde `503` con `DB_UNAVAILABLE` o `QUEUE_UNAVAILABLE`. La CLI muestra `CODE: mensaje`, sin stack trace, y sale con código ≠ 0. El panel muestra un estado de error con "reintentar".
  - El worker resume los errores repetidos, como en F0-T10.
- **R2 caído durante un import:** el job se reintenta. Si se agota, el run queda en `failed` con `STORAGE_UNAVAILABLE`, y reimportar retoma sin volver a subir lo que ya subió.
- **API caída:** la CLI y el panel lo dicen (`UNREACHABLE`, `TIMEOUT`).
- **Sondeo:** el panel solo sondea `/imports/:id` mientras el run está `queued` o `running`, y la CLI deja de esperar a las 2 h (§4.4).
- **Logs:** los reintentos de un mismo run registran un solo error por intento, con `importRunId`.

### 4.8 Decisiones (D1, D2, D4 y D6 las eligió el operador el 2026-09-30; D3 y D5 son propuestas del spec)
- **D1 · ADR-0011, contratos HTTP compartidos:**
  - Las entidades de dominio van en `core`.
  - Cuerpo de error (`errorBodySchema`), parámetros, formularios y sobres de respuesta van en `@agentsales/api/contracts`: una salida limitada por Biome a `zod`, `@agentsales/core` e imports relativos, que el panel y la CLI importan en tiempo de ejecución.
  - `healthReportSchema` se queda en core: ya tiene tres consumidores.
  - Así desaparece el `errorBodySchema` duplicado en la web y la CLI.
  - ADR-0011 quedó aceptado en el PR de este spec, junto con "Contratos HTTP compartidos" en `01-arquitectura.md` y las subrutas de `exports` en `05-convenciones.md`. T10 solo implementa.
  - `@agentsales/api` pasa de `devDependencies` a `dependencies` en la web y la CLI, y `apps/api` agrega `zod`.
- **D2 · Importación como job `import.run`** (§4.6), en vez de un `POST /imports` síncrono. Con videos de hasta 300 MB, una petición síncrona puede durar minutos y no se reintenta si R2 falla a mitad; además, ADR-0005 dice que "la API solo encola".
  - **Costo:** se adelanta a F1 la extracción de `packages/queue`, que igual tocaba en F2; los imports necesitan el worker corriendo (`pnpm dev` ya lo levanta); y la CLI y el panel sondean el estado.
  - **Archivos subidos por el panel:** van a disco local, porque en el MVP la API y el worker corren en la misma máquina. En F7 pasan a R2 (deuda).
- **D3 · Streams sin `@aws-sdk/lib-storage`:**
  - `MediaStorage.putStream(path, body: AsyncIterable<Uint8Array>, { contentType, contentLength })`, con tipos de ES2023 y sin tipos de Node en `core`. El adaptador usa `Readable.from(body)`.
  - R2 acepta un `PutObject` de un solo envío de hasta ~5 GB con `ContentLength` conocido, así que para `MAX_VIDEO_MB = 300` no hace falta la subida multiparte de `lib-storage`.
  - **Checksum (decidido en F1-T05):** el cliente de streams usa `requestChecksumCalculation: "WHEN_REQUIRED"`. Con el valor por defecto, el SDK manda el stream en `aws-chunked`, con un CRC32 al final y **sin `Content-Length`** (verificado con msw). No queremos depender de ese formato en R2, así que no se llegó a probar contra R2. Queda un PUT normal con `Content-Length`, que `storage:check` verifica contra R2 (1 MB en streaming, mismo sha256). La integridad en tránsito la da TLS. Hasta T07b, el contenido subido no se verificaba contra el sha256 de la ingesta. Desde T07b se manda como `ChecksumSHA256`: se probó contra R2 que rechaza un sha256 erróneo con `BadDigest` sin guardar el objeto (nota `docs/integraciones/r2-checksums.md`). Un largo distinto, o un `BadDigest`, es `STORAGE_CONTENT_MISMATCH`.
  - Un stream no se puede reintentar dentro del SDK, así que el reintento es el del job, que vuelve a abrir el archivo. El cliente de streams usa `maxAttempts: 1` como defensa: la versión actual del SDK ya no reintenta un cuerpo que es stream.
  - `getStream` se agrega en F2, cuando ffmpeg lo necesite.
- **D4 · Pruebas de los repositorios Drizzle con PGlite:** la CI no tiene base de datos y los tests no tocan Neon. Para que las garantías de idempotencia (`ON CONFLICT`, `NULLS NOT DISTINCT`, el único parcial) tengan prueba automática, se usa **PGlite** (Postgres en WASM) como `devDependency` solo de `packages/db`: aplica las migraciones y prueba los repositorios en la CI. Se descartó probar solo los mapeos y confiar en la demo contra Neon.
- **D5 · Bundle del panel (660 kB):** queda como deuda hasta F7. El panel se sirve en local, así que el tamaño no afecta al operador. F1-T13 solo carga las páginas de forma diferida con `React.lazy` desde `routes.tsx`, lo que es casi gratis.
- **D6 · Metadatos de medios en F2:** ancho, alto y duración los mide `media.process` en F2 (`packages/media`, con sharp y ffprobe). Las columnas aceptan `null`, F1 no los usa y así la CI no necesita ffmpeg. Es un cambio respecto del borrador, que los medía en F1.

### 4.9 Dependencias nuevas (se justifican en el PR de su tarea)
- `exceljs` (T03): leer xlsx.
- `yauzl` (T06): descomprime por entrada en streaming, sin cargar el zip completo en memoria, y ya rechaza nombres absolutos o con `..`. Igual se verifica que la ruta de destino quede dentro del directorio temporal.
- `@electric-sql/pglite` (T01, solo `devDependency` de `packages/db`; D4).

## 5. Tareas

### F1-T01 · Migración 0001, definiciones de campos y errores de base de datos
- **Depende de:** F0
- **Descripción:**
  - Migración `0001` y tupla `IMPORT_RUN_STATUSES` (§4.5).
  - `TEMPLATE_COLUMNS` y seed de las 36 definiciones globales.
  - Puerto `FieldDefinitionRepository` en core, con implementaciones Drizzle y en memoria (`@agentsales/core/testing`, con su salida en `exports` y la regla de Biome).
  - Helper `DB_UNAVAILABLE` (§4.1).
  - Actualización de `02-modelo-datos.md`.
- **Hecho cuando:**
  - [ ] Tests: el seed cubre exactamente `TEMPLATE_COLUMNS`; el helper traduce `ECONNREFUSED` y un timeout a `DB_UNAVAILABLE` reintentable
  - [ ] Tests con PGlite que aplican `0000` y `0001`, y prueban que el seed es idempotente y que el único de `field_definitions` impide dos globales con el mismo `key`
  - [ ] Demo: `pnpm db:migrate` aplica `0001` en Neon, `pnpm db:generate` no genera cambios y `pnpm db:seed` dos veces deja 36 definiciones globales

### F1-T02 · Validador dinámico
- **Depende de:** T01
- **Descripción:** `buildListingValidator(defs)` en core devuelve un esquema zod y un normalizador (§4.2), con `CORE_FIELD_TARGETS`, `_extra` para las columnas desconocidas y la definición del corredor sobre la global.
- **Hecho cuando:**
  - [ ] Tests: fila válida, obligatorio faltante, enum inválido, número con puntos, `Sí/No`, listas, `Venta` → `sale` y columna desconocida
  - [ ] Test que prueba que un campo agregado solo en la base de datos se valida sin cambiar código

### F1-T03 · Lector de Excel
- **Depende de:** T01 (por `TEMPLATE_COLUMNS`)
- **Descripción:** `packages/importers/xlsx-reader` con exceljs.
  - Lee Propiedades y Corredor (vertical, por encabezados) y devuelve `{ broker, headers, rows: [{ rowNumber, raw }] }`, con **todas** las filas no vacías. El filtro de `EJEMPLO` y `Borrador` lo hace T04 con `validator.isIgnored`.
  - Aplana las celdas de exceljs a `RawCell`: hipervínculo → texto, texto enriquecido → texto plano, fórmula → resultado. El validador rechaza cualquier otro objeto, incluidos los errores de Excel, con `FIELD_VALUE_INVALID`.
  - Topes: 10 MB y 1000 filas de datos (`IMPORT_FILE_NOT_FOUND` / `IMPORT_FILE_INVALID`, con el nombre del archivo y sin la ruta).
- **Hecho cuando:**
  - [ ] Test contra la plantilla real: sus encabezados son exactamente `TEMPLATE_COLUMNS`
  - [ ] Fixtures sintéticos (sin datos reales): válido, con errores, con columnas extra, con la hoja Corredor vacía y exportado desde Google Sheets, con un test para cada uno. El de Google Sheets es una **simulación** armada con exceljs: hojas renombradas, texto, booleanos y filas vacías. Un export real con datos inventados se puede agregar en `packages/importers/test/fixtures/`.

### F1-T04 · Caso de uso importListings
- **Depende de:** T02, T03
- **Descripción:**
  - `importListings(deps, { runId, input: ListingSheetInput })` según §4.2, con `sha256` inyectado. `dry_run`, el origen y el `--broker` salen del run.
    - Resuelve el broker desde la hoja Corredor, que se mapea con la tabla de §4.2 y cuyas etiquetas se comparan sin mayúsculas ni tildes. Con `brokerSlug`, gana ese slug y los datos de la hoja lo actualizan.
    - Filtra con `isIgnored`, valida y hace el upsert.
    - Un `id_propiedad` repetido en la hoja es `failed` en la segunda aparición.
    - Una propiedad nueva queda en `draft`, y reimportar no toca `status`. El paso a `ready` es de T07.
    - Devuelve las filas con su `listingId` y `control`, para T07.
  - `source_hash` = sha256 del JSON canónico de `{ core, attributes, control }`.
  - Puertos `BrokerRepository`, `ListingRepository` e `ImportRunRepository`, con dobles en memoria en `@agentsales/core/testing`.
  - Esquema `importReport` en core. También `LISTING_CATEGORIES` en core, que el seed de db pasa a usar.
  - `toDbError` guarda como `cause` el error del driver, no el `DrizzleQueryError` con los `params` de la consulta.
- **Hecho cuando:**
  - [ ] Test de idempotencia (dos importaciones: la segunda dice `skipped`)
  - [ ] Test de actualización (cambia el precio → `updated`)
  - [ ] Test: una fila con errores no se escribe ni detiene las demás, y el reporte trae fila, columna y motivo
  - [ ] Test: `dryRun` no escribe nada salvo el `import_run`
  - [ ] Test: reimportar no pisa un `status` puesto a mano
  - [ ] Tests de la hoja Corredor: crea el broker, lo actualiza, `BROKER_NOT_FOUND` y `BROKER_INVALID`

### F1-T04b · Repositorios Drizzle de brokers, listings e import_runs
- **Depende de:** T04
- **Descripción:**
  - Implementaciones Drizzle de `BrokerRepository`, `ListingRepository` e `ImportRunRepository` en `packages/db/src/repositories/`, sobre `SchemaDatabase` y con `withDbErrors`.
  - `price_amount` (`numeric`) se convierte entre texto y número.
  - `findByExternalRefs([])` devuelve `[]` sin consultar.
  - Los conflictos de `create` son `BROKER_CONFLICT` o `LISTING_CONFLICT`, reintentables (23505 de su único). Un `update` de un id que no existe es `*_NOT_FOUND`. `update` fija `updated_at` y no toca `status`, `logo_media_id` ni `auto_publish`.
  - `get` valida `report` e `input` (jsonb) con sus esquemas.
  - **Migración `0002`:** `import_runs.report` pasa a admitir `null` y pierde su default (`null` hasta que `importListings` registra), y los `'{}'` existentes pasan a `NULL`. Actualizar `02-modelo-datos.md`.
- **Hecho cuando:**
  - [ ] Tests con PGlite de los repositorios (upsert por `external_ref`), con los mismos casos que los dobles en memoria, incluidos los conflictos, `update` que no pisa `status` y la migración `0002`

### F1-T05 · Almacenamiento con streams
- **Depende de:** F0
- **Descripción:** `MediaStorage.putStream` en el puerto de core y en `packages/storage` (D3). Actualización de "Contrato de almacenamiento de archivos" en `01-arquitectura.md`.
- **Hecho cuando:**
  - [ ] Tests con msw: sube con `Content-Length` y `Content-Type` correctos, y un 5xx o un corte de red → `STORAGE_UNAVAILABLE`
  - [ ] Demo: `pnpm storage:check` sube y borra un archivo de prueba con `putStream` contra R2

### F1-T06 · Lectores de medios
- **Depende de:** F0
- **Descripción:** en `packages/importers`:
  - `media-folder` implementa `MediaFileSource`: lista, filtra por tipo, verifica la firma, calcula el sha256 en streaming y ordena en orden natural.
    - `createMediaFolderSource(rootDir, { maxVideoBytes })`. Un video sobre el tope se omite (`too_large`) sin calcular su hash.
    - Los archivos rechazados van a `skipped` con su motivo, para el reporte de T07.
  - `zip`: extracción en streaming con protección contra zip-slip y los topes de §4.3.
    - `extractZip(zipPath, destDir, { maxEntries, maxTotalBytes })`.
    - Un zip con una entrada hostil, nombres repetidos (también si solo cambian mayúsculas) o un archivo y una carpeta con el mismo nombre se rechaza completo (`IMPORT_FILE_INVALID`).
    - Un fallo del disco, o un destino que ya tenía esos archivos, es `IMPORT_EXTRACT_FAILED`.
    - Devuelve `{ files, bytes, skipped }`; `skipped` cuenta las entradas omitidas, para que T09 avise si el zip no trajo medios.
    - Lo que alcanzó a escribir lo borra quien llama (T09).
- **Hecho cuando:**
  - [ ] Tests con una carpeta fixture: 3 fotos + 1 video + 1 archivo inválido, en orden natural y con el sha256 correcto
  - [ ] Tests de zip: extracción normal, una entrada con `..` rechazada, y los topes de tamaño y de entradas superados

### F1-T07 · Caso de uso ingestMedia
- **Depende de:** T04, T05, T06
- **Plan aprobado (2026-10-01):** T07 se parte en T07 (core) y T07b (adaptadores), como T04 y T04b.
- **Descripción:** `ingestMedia(deps, { runId, imported, source })` según §4.3, en el mismo run que `importListings`. `imported` es su resultado. `source` es el `MediaFileSource` de la carga, o `null` sin `--media`; lo compone el job (T09), porque la raíz cambia en cada run.
  - **Logo:** `_marca/<logo>` de la hoja Corredor. Va en `brokers/{brokerId}/brand/{sha256}.{extension}`, no se resube si ya existe (`MediaRepository.findByStoragePath`) y se asigna con `BrokerRepository.setLogo(id, mediaId)`. Sus advertencias van a `broker.warnings`.
  - **Por fila** `created`, `updated` y también `skipped`:
    - la carpeta es `carpeta_medios`, o `id_propiedad` si viene vacía;
    - deduplica por sha256 contra los originales del aviso y dentro de la carpeta;
    - sube con `putStream`, con su `Content-Type`, y después inserta: primero R2 y después la fila;
    - la clave es `{sha256}.{extension}`, con `MediaFile.extension` (canónica; core no repite la tabla de tipos).
  - **Orden y portada** con `MediaRepository.arrange`:
    - el orden natural de la carpeta; los medios que ya no están se conservan al final;
    - la portada es `foto_portada`, comparada sin mayúsculas, si es una foto de la carpeta; si no, la primera foto de la carpeta, con advertencia;
    - **si la carpeta no trae fotos**, se conserva la portada guardada, aunque ese medio ya no esté. `media` no guarda el nombre original, así que `foto_portada` solo se resuelve contra la carpeta;
    - **sin carpeta legible** (sin `--media`, o con `MEDIA_FOLDER_*`), no se tocan orden ni portada, y para el estado cuentan las fotos que el aviso ya tenía (desde la revisión de T07);
    - solo escribe si algo cambió.
  - **Estado:** con `estado_carga = Listo` y al menos una foto del aviso (nueva o de antes; un video no cuenta), `ListingRepository.promoteToReady(id)`. Solo pasa de `draft` a `ready`, así no pisa `paused`, `archived`, `active` ni `closed`. Con `Listo`, sin fotos y en `draft`: advertencia. En `dry_run`, un aviso nuevo cuenta como `draft`.
  - **Textos:** las advertencias de un archivo fallido usan un texto fijo por código, nunca `error.message`, que puede traer la clave interna en R2. Fuera de `dry_run`, una fila guardada sin aviso o sin corredor es `MEDIA_INGEST_STATE_INVALID` (invariante).
  - **Advertencias de la fila (no fallan el run, §4.2):**
    - `skipped` de `list` y archivos repetidos;
    - errores `MEDIA_FOLDER_*`;
    - `MEDIA_FILE_UNREADABLE` (`open()`) y `STORAGE_CONTENT_MISMATCH` (código nuevo de `putStream`: el contenido no es el anunciado; antes era `STORAGE_ERROR`).
  - **Se propagan:** `STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE`, `MEDIA_CONFLICT` (reintentables) y `STORAGE_ERROR` (credenciales).
  - **Sin reintentos por archivo:** el reintento es del job, y la deduplicación evita volver a subir lo que terminó.
  - **`dry_run`:** solo lee, incluidos los medios que el aviso ya tiene. El reporte dice lo que se subiría.
  - **Reporte:** `importReportSchema` suma `media` opcional, `{ filesUploaded, filesExisting, filesSkipped, filesFailed }`, sin el logo, y las advertencias van a `rows[].warnings`. Se guarda con `ImportRunRepository.recordMediaResult(id, report)`.
  - **Puertos:**
    - `MediaRepository` (`listOriginals`, `findByStoragePath`, `create` con `MEDIA_CONFLICT` reintentable, `arrange` todo o nada);
    - `ListingRepository.promoteToReady`, `BrokerRepository.setLogo` e `ImportRunRepository.recordMediaResult`. Estos tres ya tienen implementación Drizzle en T07, con la suite de contrato: sin ella `packages/db` no compila.
  - **Dobles en `@agentsales/core/testing`:**
    - `MediaRepository`;
    - `MediaStorage`: lee el iterable completo, da `STORAGE_CONTENT_MISMATCH` si el largo no calza, como R2, y registra las subidas;
    - `MediaFileSource`: un mapa `folder → listado | AppError`, con `memoryFile` y sha256 fijos. No reimplementa la validación de rutas (`MEDIA_FOLDER_INVALID` es del adaptador, que ya tiene su prueba).
- **Hecho cuando:**
  - [ ] Test con un `MediaStorage` y un `MediaFileSource` en memoria: suben 4 archivos válidos con su tipo, y el inválido va al reporte
  - [ ] Reimportar no vuelve a subir archivos (verificado por checksum)
  - [ ] Test: agregar una foto a una propiedad `skipped` la sube
  - [ ] Test: una propiedad sin fotos queda en `draft` con advertencia
  - [ ] Test: cambiar `foto_portada` desmarca la portada anterior

### F1-T07b · MediaRepository en Drizzle y checksum en R2
- **Depende de:** T07
- **Descripción:**
  - `MediaRepository` en Drizzle (`packages/db/src/repositories/media.ts`), con `withDbErrors`:
    - `create` da `MEDIA_CONFLICT`, reintentable, por los únicos `media_original_listing_checksum_unique` y `media_storage_path_unique`;
    - `arrange` va en una transacción.
  - **`ChecksumSHA256` en `putStream`** (nota `docs/integraciones/r2-checksums.md`):
    - `PutStreamOptions` gana `sha256` opcional, en hex. El adaptador lo manda en base64 como `ChecksumSHA256`, sin `ChecksumAlgorithm`, y conserva `WHEN_REQUIRED`;
    - `BadDigest` da `STORAGE_CONTENT_MISMATCH`;
    - `ingestMedia` pasa el sha256 del archivo.
    - **Solo si** el caso negativo de `storage:check` confirma que R2 rechaza un sha256 erróneo y no guarda el objeto. Si no, se descarta y queda documentado.
    - **Resultado (2026-10-01): adoptado.** Contra R2 real, el sha256 correcto se acepta, y el de otro contenido da `BadDigest`, sin dejar el objeto.
  - **Plan aprobado (2026-10-01):**
    - `setLogo` valida el medio: `MEDIA_NOT_FOUND` si no existe, es de otro corredor o es de un aviso;
    - `arrange` rechaza ids repetidos o más de una portada, con `MEDIA_ARRANGE_INVALID` (`checkArrangement`, en core, que usan todas las implementaciones);
    - el doble no modela `role`: el puerto solo crea originales. El filtro por `role` se prueba con PGlite, con una fila `processed` insertada a mano.
  - **Desde la revisión de T07** (la suite de contrato los fija):
    - `arrange` garantiza **una sola portada** por aviso: al marcar una, desmarca los demás originales, en el doble y en Postgres. Hoy depende de que el caso de uso pase todos los originales;
    - `listOriginals`, `findByStoragePath` y `arrange` filtran `role = 'original'` (el doble no lo modela; ver el plan);
    - la suite no fija el desempate del orden por id (en memoria es texto, en Postgres un uuid), solo `sortOrder`. Los ids repetidos en `arrange` dan `MEDIA_ARRANGE_INVALID`;
    - `setLogo` con un medio inexistente, de otro corredor o de un aviso da `MEDIA_NOT_FOUND`, y no el 23503 (FK) genérico de Postgres. El doble de brokers recibe el de medios para validar igual;
    - `setLogo` escribe en cada carga aunque el logo no cambie; es idempotente y se deja así (anotado);
    - para T10 y T12: `report.media` puede faltar (reportes anteriores a T07 o cargas que no llegaron a la ingesta). Mostrar "medios: —", sin asumir ceros.
- **Hecho cuando:**
  - [ ] Suite de contrato de `MediaRepository` contra el doble en memoria y contra PGlite: los únicos (`MEDIA_CONFLICT`), el orden de `listOriginals` y `arrange` todo o nada
  - [ ] Test de punta a punta de `importListings` más `ingestMedia` contra PGlite: únicos reales, portada, `ready` y logo con su FK
  - [ ] Test msw: con `sha256`, la petición lleva `x-amz-checksum-sha256` y `Content-Length`, sin `aws-chunked`, `x-amz-trailer` ni `x-amz-sdk-checksum-algorithm`; `BadDigest` da `STORAGE_CONTENT_MISMATCH`
  - [ ] Demo: `pnpm storage:check` contra R2: el caso positivo sube con el sha256 correcto, y el negativo da `BadDigest` sin dejar el objeto

### F1-T08 · Paquete de cola
- **Depende de:** F0
- **Descripción:**
  - Extrae `packages/queue` desde `apps/worker/src/queue.ts`: puerto `JobQueue` en core, `JOB_NAMES` y `JOB_PAYLOADS` en `core/src/jobs.ts`, arranque diferido del `producer` y `QUEUE_SCHEMA` y `checkQueueSchema` mudados.
  - `QUEUE_NOT_INITIALIZED` se unifica con `QUEUE_UNAVAILABLE`.
  - Actualización de "Cola de trabajos" en `01-arquitectura.md`.
  - **Hecho en F1-T08:**
    - `createJobQueue({ connectionString, onError })` valida los datos con `JOB_PAYLOADS` antes de conectar. `enqueue` devuelve `null` si el `singletonKey` ya tenía un job activo.
    - `packages/queue` no depende de `@agentsales/db`: la conexión llega ya convertida con `toPgConnectionString`, porque los adaptadores no dependen entre sí. Para `checkQueueSchema` depende de `drizzle-orm`, que es del stack.
    - `JOB_PAYLOADS` ya incluye `import.run` (`{ importRunId }`); el handler llega en T09.
    - `pnpm worker:ping` usa el productor nuevo.
- **Hecho cuando:**
  - [ ] Test: `enqueue` con el esquema o la cola inexistentes → `QUEUE_UNAVAILABLE`
  - [ ] Los tests del worker de F0 siguen pasando, y `pnpm worker:ping` funciona con `packages/queue` (demo)

### F1-T09 · Job import.run
- **Depende de:** T04b, T07, T07b, T08
- **Desde la revisión de T08** (hacer **antes** de que el worker cree la cola `import.run`, porque la política no se puede cambiar después):
  - `QueuePolicy` gana `policy` (pg-boss). Se pasa solo a `createQueue`, no a `updateQueue`, que falla con `policy`. Para `import.run`: `exclusive`, así `singletonKey = importRunId` deduplica de verdad.
  - `defineJob<N extends JobName>` toma el nombre de `JOB_NAMES` y el esquema de `JOB_PAYLOADS[name]`, sin parámetro `schema` y sin repetir el literal en el worker.
  - `requestImport` solo convierte `QUEUE_UNAVAILABLE` en run `failed` + 503. Cualquier otro error (por ejemplo `JOB_PAYLOAD_INVALID`, que es un bug y responde 500) se propaga.
- **Descripción:**
  - Job `import.run` (§4.6) y `buildJobs(deps)` en el worker.
  - Caso de uso `requestImport` en core, que crea el run con `input` según `importRunInputSchema`.
  - `ImportRunRepository` suma los cambios de estado del run (`running`, `succeeded` y `failed`, con `started_at`, `finished_at` y `error`). Son condicionales (`UPDATE … WHERE status IN (…)`, que devuelven si cambió), así un run ya terminal no se vuelve a procesar.
  - Staging en `<workspace>/tmp/imports`, con su limpieza al arrancar.
- **Hecho en F1-T09:**
  - El handler es el caso de uso `runImport` en core. Recibe `readSheet`, `openMedia(run, folders)` y `discardStaging` inyectados, y el job del worker solo lo llama con `isLastAttempt`.
  - Estados del run: `markRunning` (desde `queued` o `running`, `started_at` solo la primera vez), `markSucceeded` y `markFailed`.
  - Staging: `apps/worker/src/staging.ts` (desde T11, `@agentsales/importers/staging`).
- **Hecho cuando:**
  - [ ] Tests del handler con fakes: éxito → `succeeded`; `STORAGE_UNAVAILABLE` → se propaga para reintento; último intento → `failed` con `error`; error no reintentable → `failed`; y un run ya terminal → no hace nada
  - [ ] Tests de `requestImport`: encola; si `enqueue` falla → run `failed` y staging borrado
  - [ ] Test: `extracted/` se borra aunque el intento falle, e `input/` se conserva hasta el estado terminal

### F1-T10 · Contratos HTTP y API de lectura
- **Depende de:** T04b y ADR-0011 aceptado
- **Hecho en F1-T10:**
  - `LISTING_MANUAL_TRANSITIONS`: `draft` → `ready`/`archived`, `ready` → `paused`/`archived`, `paused` → `ready`/`archived` y `archived` → `ready`. `active` y `closed` quedan fuera hasta F3.
  - `ready` exige al menos una foto, que no puede ser un video.
  - `ListingRepository.changeStatus(id, from, to)` es condicional.
  - `MediaRepository.listCovers` trae las portadas de la lista.
  - `@agentsales/api` pasa a `dependencies` en la web y la CLI, que usan el `errorBodySchema` compartido.
  - La regla de Biome de `contracts` tiene su test.
- **Descripción:**
  - Salida `@agentsales/api/contracts` (`errorBodySchema`, parámetros y respuestas), con su regla de Biome.
  - Helper de validación (`REQUEST_INVALID`).
  - Caso de uso `changeListingStatus` con `LISTING_MANUAL_TRANSITIONS`.
  - Entidad `listingSchema` en core, más `ListingRepository.list` y `get`; `BrokerRepository.list`.
  - Los ids de ruta (`/listings/:id`, `/imports/:id`) se validan como uuid con zod antes de llegar al repositorio; un id con otro formato es `REQUEST_INVALID`, no un error de base de datos.
  - Rutas `/listings`, `/listings/:id`, `PATCH /listings/:id/status` y `/brokers`, con URLs firmadas.
- **Hecho cuando:**
  - [ ] Tests con `app.request` y repositorios en memoria: filtros, detalle, 404, `REQUEST_INVALID`, cambio de estado permitido y `409 INVALID_TRANSITION`
  - [ ] Biome rechaza un import de `@agentsales/config` o de `node:*` dentro de `contracts`
  - [ ] La guardia `no-node-types` del panel sigue pasando

### F1-T11 · API de importación
- **Depende de:** T09, T10
- **Hecho en F1-T11:**
  - `createErrorThrottle` se mudó a `@agentsales/config`, y `createStaging` a `@agentsales/importers/staging`, con `inputDirOf` y `saveInput`.
  - `NewImportRun.id` lo puede generar quien llama, e `ImportRunRepository.list(limit)` devuelve las cargas.
  - `MAX_IMPORT_UPLOAD_MB` (1024) se aplica con `bodyLimit` y responde `413 REQUEST_TOO_LARGE`.
  - `POST /imports/local` exige rutas absolutas, y fuera de desarrollo es 404 antes de validar el cuerpo.
  - La API compone `createJobQueue` con `onError` resumido y `stop()` al apagarse.
- **Desde la revisión de T08:** la API compone `createJobQueue` con `onError` resumido (`createErrorThrottle`, que hoy vive en `apps/worker`; mudarlo a `@agentsales/config` o duplicarlo con su test) y llama a `queue.stop()` al apagarse.
- **Desde la revisión de T09:**
  - **El id del run lo genera quien llama:** `NewImportRun` gana `id?` (uuid), así la API escribe `input/` en `tmp/imports/{id}/` **antes** de crear el run y de encolar.
    - Si eso falla a mitad, borra lo escrito.
    - La limpieza del worker ya espera 10 minutos antes de borrar un directorio sin run (`STAGING_ORPHAN_GRACE_MS`).
  - **Mudar `createStaging`** desde `apps/worker/src/staging.ts` a `packages/importers`, como primer paso de T11, cuando aparece el segundo consumidor.
    - Con la subruta `@agentsales/importers/staging`, así la API no carga exceljs.
    - Con `inputDirOf(runId)`.
    - La raíz `<workspace>/tmp/imports` se compone igual en la API y en el worker.
- **Descripción:**
  - `POST /imports` (multipart a `input/` mediante `AppDeps.uploads`, con `bodyLimit`).
  - `POST /imports/local`, habilitado con `AppDeps.localImports`.
  - `GET /imports` e `/imports/:id` (§4.4), con `ImportRunRepository.list`. `report` puede ser `null` (el run falló antes de registrar).
- **Hecho cuando:**
  - [ ] Tests con `app.request`, una `JobQueue` falsa y repositorios en memoria: `202` y job encolado; `/imports/local` → 404 si `localImports` es `false`; cuerpo demasiado grande → 413; xlsx de más de 10 MB → `REQUEST_INVALID`; cola caída → 503 y run `failed`; y `GET /imports/:id` no expone las rutas completas

### F1-T12 · CLI de importación y consulta
- **Depende de:** T11
- **Desde la revisión de T11:** los tests de la CLI contra `createApp` necesitan armar `AppDeps` con dobles. Hoy `apps/api/test/app-deps.ts` (`testDeps`, `fakeUploads`) no es público. Se decide en el plan de T12: una subruta de solo tests, `@agentsales/api/testing`, restringida con Biome como `core/testing` (cabe en ADR-0010), o armar los dobles en la CLI.
- **Desde la revisión de T10:** `agentsales listing <external_ref|id>` necesita buscar por `external_ref`, que es único **por corredor**.
  - Agregar un filtro exacto `externalRef` a `listingQuerySchema` y `ListingFilters`, un cambio aditivo.
  - Si devuelve más de un aviso, pedir `--broker`.
  - Un uuid va directo a `GET /listings/:id`.
- **Descripción:** comandos de §4.4.
  - **Cliente:** antes de sumar comandos, `createApiClient(port, { timeoutMs })` devuelve el `hc<AppType>` completo, y `unwrap(res)` lee el `ErrorBody` (con el esquema de `contracts`) y lo muestra como `CODE: mensaje`.
  - **Estructura:** un comando por archivo (`src/commands/<nombre>.ts`), cada uno con una función `run<Nombre>(deps)` testeable y un `register(program, ctx)`. `checks.ts` pasa a `commands/doctor/`.
  - **Rutas:** relativas a `INIT_CWD ?? process.cwd()`, verificadas antes de llamar a la API.
  - **Tests:** contra la app real en proceso, con `hc<AppType>(url, { fetch: app.request })`, `createApp` y los repositorios en memoria, sin red.
- **Hecho cuando:**
  - [ ] Tests:
    - resumen y tabla de errores
    - sondeo hasta `succeeded`
    - aviso de `queued` a los 20 s
    - `--no-wait`
    - ruta relativa resuelta contra `INIT_CWD`
    - archivo inexistente → error antes de llamar a la API
    - API caída → mensaje claro con código de salida ≠ 0
  - [ ] Demo: `pnpm cli import data/muestras/propiedades.xlsx --media data/muestras/medios` funciona con las 3 propiedades reales de muestra

### F1-T13 · Panel: patrón, Propiedades y Detalle
- **Depende de:** T10
- **Desde la revisión de T10:**
  - **Atributos con su etiqueta:** `attributes` llega con las claves internas (`dormitorios`, `_extra`). Las etiquetas son datos (ADR-0006), así que el detalle suma `fields: [{ key, label, type }]` con las definiciones efectivas del corredor (`resolveEffectiveDefinitions`; la ruta recibe `FieldDefinitionRepository`). Se decide en el plan de T13; la alternativa es mostrar las claves crudas en F1.
  - **URLs firmadas:** duran `SIGNED_URL_TTL_SECONDS` (1 h). `staleTime` y `gcTime` de TanStack Query quedan bien por debajo, o la galería vuelve a pedir los datos si falla una imagen.
  - **Imports desde la API:** el panel solo hace `import type` de la raíz de `@agentsales/api`; en tiempo de ejecución, solo `@agentsales/api/contracts`. Si Biome permite distinguir `import type`, se agrega una regla para `apps/web/src/**`. Si no, queda como revisión manual.
- **Descripción:**
  - **Patrón:** `createApiClient` con el `hc` completo, y `unwrap(res)` que lee `ErrorBody` y lanza `ApiError { code, status }`. Un solo `ApiClientContext`, hooks por recurso en `src/queries/` con fábricas de `queryKey`, y `routes.tsx` separado de `App.tsx` con páginas en `React.lazy` (D5). El `HealthFetcher` desaparece con este patrón, y se actualiza la sección de tests del panel en `05-convenciones.md`.
  - **Propiedades:** grilla con portada, operación, tipo, comuna, precio formateado (`UF 5.800`, `$650.000`) y estado. Filtros en los parámetros de la URL.
  - **Detalle:** galería, atributos y cambio de estado.
- **Hecho cuando:**
  - [ ] Tests de componentes con el router en memoria (`initialEntries`) y un cliente inyectado: grilla, filtros desde la URL, detalle, cambio de estado y error de API
  - [ ] La página Estado de F0 sigue funcionando con el patrón nuevo

### F1-T14 · Panel: Importar
- **Desde la revisión de T11:**
  - El formulario puede mandar el campo de medios vacío y el corredor vacío: la API los trata como "no enviado".
  - Comprobar que el proxy de Vite (`/api`) conserva el header `Origin`, porque `csrf()` rechaza un multipart sin él.
  - `GET /imports` devuelve las cargas sin `report`; el reporte viene en `/imports/:id`.
- **Depende de:** T11, T13
- **Descripción:** subir el xlsx y el zip (con el selector de corredor), y ver el progreso, el aviso de `queued` y el reporte por fila y columna.
- **Hecho cuando:**
  - [ ] Tests de componentes: envío del formulario, sondeo que se detiene en un estado terminal, aviso de `queued` y tabla de errores
  - [ ] Demo: flujo completo desde el navegador con los archivos de muestra

### F1-T15 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 1`.

Orden sugerido: T01 → T02/T03 → T04 → T04b. T05, T06 y T08 se pueden hacer en cualquier momento después de F0. Luego T07 → T07b → T09. T10 va después de T04b. T11 después de T09 y T10. Luego T12, T13 → T14, y al final T15.

## 6. Criterios de aceptación de la fase
- [ ] Ver `docs/06-roadmap.md#f1--carga`
- [ ] Las 3 propiedades de muestra del operador se ven correctamente en el panel

## 7. Plan de demo
1. `pnpm dev`, y en otra terminal `pnpm cli import data/muestras/propiedades.xlsx --media data/muestras/medios`
2. Repetir el comando → todo `skipped`, sin subir archivos
3. Cambiar un precio en el Excel → reimportar → 1 `updated`
4. Agregar una fila con errores → aparece en el reporte y no bloquea las demás
5. Abrir el panel → Propiedades → detalle con galería
6. Panel → Importar → subir el xlsx y un zip de medios → ver el reporte

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Excel editado en Google Sheets cambia tipos (fechas, números como texto) | Normalizador tolerante y fixture exportado desde Sheets |
| Fotos HEIC desde iPhone | Se aceptan en F1 y se convierten en F2 (sharp con libheif, o fallback a ffmpeg) |
| Archivos grandes de video | `MAX_VIDEO_MB` (default 300) con advertencia, subida en streaming y reintento del job. R2 no limita el tamaño por archivo, pero el plan gratis incluye 10 GB en total |
| Zip malicioso o gigante | Protección contra zip-slip, topes de tamaño y cantidad, y un directorio temporal que se borra |
| Import con el worker apagado | Si la cola no existe, `503 QUEUE_UNAVAILABLE`. Si existe, el run queda en `queued` y la CLI y el panel avisan a los 20 s; `pnpm dev` levanta el worker |
| Run que queda en `running` para siempre | El handler lo deja en `failed` en el último intento, y un run terminal no se vuelve a procesar. Si el proceso muere o la base no responde al final, el worker lo cierra al arrancar (`IMPORT_ABANDONED`, §4.6) |
| Rutas relativas resueltas en otra carpeta | `findWorkspaceRoot()` para el staging, `INIT_CWD` en la CLI y rutas absolutas en `input` |
| Repositorios Drizzle sin tests contra Postgres en la CI | PGlite (D4) |
| El proceso de la API cae entre crear el run y encolarlo | El run queda en `queued` sin job. La CLI y el panel avisan a los 20 s; reintentar la carga crea un run nuevo (MVP). Desde la revisión de T08 |

## 9. Preguntas abiertas
- [ ] ¿Google Sheets y Drive son necesarios antes de F3, o basta con Excel y zip durante el piloto?

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-09-28 | Borrador inicial |
| 2026-09-29 | Almacenamiento en Cloudflare R2 en vez de Supabase (ADR-0007); `MAX_VIDEO_MB` vuelve a 300 |
| 2026-09-29 | Desde la revisión de F0-T08: ADR-0011 sobre dónde viven los contratos HTTP compartidos (entidades en `core`; sobres y parámetros HTTP en `@agentsales/api/contracts`), antes de F1-T05. Panel (F1-T07): `createApiClient` con el `hc` completo y `unwrap(res)` que lee `ErrorBody` y lanza `ApiError { code, status }`, un solo `ApiClientContext`, hooks por recurso en `src/queries/` con fábricas de `queryKey`, `routes.tsx` separado de `App.tsx`, router en memoria con `initialEntries` en los tests y filtros de Propiedades en los parámetros de la URL. El `HealthFetcher` duplicado en la CLI y la web desaparece con ese patrón |
| 2026-09-29 | Desde la revisión de F0-T06: si se adopta el job `import.run`, la API encola desde F1: extraer `packages/queue` (puerto `JobQueue`, `JOB_NAMES`/`JOB_PAYLOADS` en `core`) y registrar el job en ADR-0005 (es una enmienda: ese ADR fija los jobs iniciales y "la API solo encola") |
| 2026-09-29 | Desde la revisión de F0-T05 (resolver en `/fase-plan 1`): `POST /imports` síncrono choca con ADR-0005 ("la API solo encola"): job `import.run` o aclaración del ADR; rutas en `apps/api/src/routes/<recurso>.ts` montadas con `.route()` dentro de la cadena de `createApp` (si no, `AppType` pierde el esquema); salida `./testing` en `exports` para los repositorios en memoria; hook de validación zod que lance `AppError("REQUEST_INVALID")` (y `@hono/zod-validator` es dependencia nueva); `csrf()` bloquea `multipart` sin `Origin`, así que la CLI usa `/imports/local` (JSON) |
| 2026-09-29 | Desde la revisión de F0-T04: `MediaStorage` ya existe y F1-T04 lo amplía con streams; migración `0001` con únicos de `field_definitions` y `media` |
| 2026-09-30 | Revisión en `/fase-plan 1` contra el código de F0 y la plantilla, con observaciones del subagente `arquitecto`. 15 tareas (antes 8): migración `0001` (T01), streams (T05), lectores de medios (T06), paquete de cola (T08), job `import.run` (T09), la API partida en lectura (T10) e importación (T11), y el panel partido en dos (T13, T14). Core no lee archivos: `importListings` recibe filas, el sha256 se inyecta y hay un puerto `MediaFileSource`. `import_runs` gana `status`, `dry_run`, `input` y `error`, y `broker_id` y `started_at` pasan a `null`. Una fila con errores no se escribe. Hay tablas de destino para las columnas y para la hoja Corredor (vertical). La carpeta de medios sale de `carpeta_medios`, y reimportar no pisa un estado puesto a mano. Se agregan el ciclo de vida del run, la limpieza del staging, las rutas absolutas, lo que depende de Node por `AppDeps` y el comportamiento sin red (§4.7). Sin `q=` ni `GET /brokers/:id`. Decisiones D1–D6 (§4.8) propuestas al operador |
| 2026-09-30 | Decisiones del operador: D1 (ADR-0011 aceptado), D2 (job `import.run`; ADR-0005 enmendado), D4 (PGlite en `packages/db`) y D6 (metadatos de medios en F2). D3 y D5 quedan como propuestas del spec |
| 2026-09-30 | Spec **aprobado** por el operador |
| 2026-09-30 | Desde la revisión de F1-T02: el filtro de `EJEMPLO` y `Borrador` pasa del lector (T03) a `importListings` (T04), con `validator.isIgnored`; T03 aplana las celdas de exceljs a `RawCell` y devuelve los encabezados; `precio` tiene un tope por `numeric(14,2)` |
| 2026-09-30 | Desde F1-T03: `ListingSheetInput` y `RawBrokerSheet` en core (entrada de `importListings`, con `headers`); `RawListingRow` pasa a `Readonly<Record<string, unknown>>` y core exporta `foldText`; el lector tiene un tope de 1000 filas y los errores `IMPORT_FILE_NOT_FOUND` / `IMPORT_FILE_INVALID`; la fixture de Google Sheets es una simulación |
| 2026-09-30 | Plan de F1-T04, aprobado por el operador: T04 se parte en T04 (core: caso de uso, puertos, dobles y reporte) y T04b (repositorios Drizzle con PGlite). `source_hash` sobre `{ core, attributes, control }`; una propiedad nueva queda en `draft` y T07 la pasa a `ready`; `--broker` gana sobre el slug de la hoja |
| 2026-09-30 | Desde la revisión de F1-T04: `dry_run`, el origen y el `--broker` salen del run (`importRunInputSchema` en `import_runs.input`); los conflictos de `create` son reintentables (`*_CONFLICT`); `report` pasa a admitir `null` (migración `0002` en T04b); el reporte suma `listingId` y `warnings` por fila, y `headers` puede ser `null`; métodos anotados para T07 (`promoteToReady`, `setLogo`), T09 (estado del run), T10 (`listingSchema`, `list`/`get`) y T11 (`list` de runs) |
| 2026-10-01 | Desde F1-T05: D3 queda con el checksum por defecto del SDK desactivado en el cliente de streams (`WHEN_REQUIRED`), porque mandaba `aws-chunked` sin `Content-Length`; `maxAttempts: 1` defensivo. T07 decide `ChecksumSHA256` y la política de reintentos por archivo |
| 2026-10-01 | Plan de F1-T06, aprobado por el operador: `MediaFileSource.list` devuelve `{ files, skipped }` con `MEDIA_SKIP_REASONS`; `folder` es relativo a la raíz del adaptador y no puede salir de ella; el tope de video lo aplica el adaptador (sin hashear); los zips de los tests se arman con un generador propio, sin dependencia nueva; desenvolver una carpeta raíz del zip se decide en T09 |
| 2026-10-01 | Desde la revisión de F1-T06: `MediaFile` gana `extension` canónica; códigos `MEDIA_FOLDER_UNREADABLE`, `MEDIA_FILE_UNREADABLE` e `IMPORT_EXTRACT_FAILED`; la carpeta no puede salir de la raíz tampoco por un enlace simbólico (`realpath`); `extractZip` devuelve `skipped` y rechaza nombres repetidos o en conflicto antes de escribir; T07 convierte en advertencia los fallos de un archivo y tiene un doble de `MediaFileSource` |
| 2026-10-01 | Plan de F1-T07, aprobado por el operador: se parte en T07 (core: `ingestMedia`, `MediaRepository`, dobles y reporte; más `promoteToReady`, `setLogo` y `recordMediaResult` en Drizzle) y T07b (`MediaRepository` en Drizzle y `ChecksumSHA256` en `putStream`, condicionado a la prueba negativa contra R2); sin reintentos por archivo (el reintento es del job); `STORAGE_CONTENT_MISMATCH` para un contenido distinto del anunciado, que la ingesta trata como advertencia; T09 depende de T07b |
| 2026-10-01 | Desde la revisión de F1-T07: sin carpeta legible no se tocan orden ni portada; si la carpeta no trae fotos se conserva la portada guardada; en `dry_run` un aviso nuevo cuenta como `draft` para la advertencia; las advertencias de archivos usan textos fijos (sin la clave en R2); invariante `MEDIA_INGEST_STATE_INVALID`; §4.6 suma los `*_CONFLICT` a los reintentables y que cada intento corre las dos etapas; notas para T07b (una sola portada, `role`, `setLogo` con FK) y para T10 y T12 (`media` puede faltar) |
| 2026-10-01 | Plan de F1-T07b, aprobado por el operador: `setLogo` valida el medio (`MEDIA_NOT_FOUND`); `arrange` rechaza ids repetidos o dos portadas (`MEDIA_ARRANGE_INVALID`, `checkArrangement` en core); el doble no modela `role`. `ChecksumSHA256` **adoptado**: `storage:check` contra R2 confirmó el rechazo con `BadDigest` sin guardar el objeto. D3 actualizado |
| 2026-10-01 | Desde la revisión de F1-T07b: `arrange` bloquea el aviso (`FOR NO KEY UPDATE`) para que dos intentos del job no dejen dos portadas ni se bloqueen entre sí; `checkArrangement` también valida `sortOrder` (entero de 0 al máximo de int4); `BadDigest` se reconoce por `Code` además de `name`; test de rollback de `arrange` con PGlite. La concurrencia real no se puede probar con PGlite (una sola conexión): queda documentada |
| 2026-10-01 | F1-T08: `packages/queue` con `createJobQueue` (productor con arranque diferido), `createBoss`, `QUEUE_SCHEMA` y `checkQueueSchema`; `JOB_NAMES` y `JOB_PAYLOADS` en core, con `import.run`; `QUEUE_NOT_INITIALIZED` pasa a `QUEUE_UNAVAILABLE`; el paquete no depende de `@agentsales/db` (la conexión llega convertida) |
| 2026-10-01 | Desde la revisión de F1-T08: el productor refresca el caché de colas una vez al día, para no mantener Neon despierto; el mensaje de "cola no lista" solo sale con los errores exactos de pg-boss; `stop()` deja la cola cerrada y cierra un arranque en curso; `JOB_PAYLOAD_INVALID` responde 500; T09 suma `policy` (`exclusive` para `import.run`, inmutable), `defineJob` tipado por `JobName` y `requestImport` acotado a `QUEUE_UNAVAILABLE`; T11 resume `onError` y llama a `stop()`; riesgo del run sin job en §8 |
| 2026-10-01 | F1-T09: `requestImport` y `runImport` en core; estados del run (`markRunning`, `markSucceeded`, `markFailed`, condicionales); job `import.run` con cola `exclusive`, `defineJob` tipado por `JobName`, `isLastAttempt` (pg-boss `includeMetadata`) y `policy` solo al crear; staging en el worker con su limpieza al arrancar; un zip con una sola carpeta en la raíz se desenvuelve si ahí están las carpetas pedidas |
| 2026-10-01 | Desde la revisión de F1-T09: runs abandonados cerrados al arrancar el worker (`failAbandoned`, `IMPORT_ABANDONED`, tras 7 h en `running`); un error que no es `AppError` se normaliza a `INTERNAL_ERROR` no reintentable; si `markFailed` falla, el original va como `cause`; `markSucceeded` sin efecto da `skipped`; `extracted-{uuid}/` por intento; limpieza del staging robusta (por antigüedad sin base, huérfanos con 10 min de gracia, sin cortar el barrido); el worker avisa si una cola existe con otra política; `openMedia({ runId, mediaDir, folders })`; notas para T11 (id del run generado por quien llama, `createStaging` a `importers`) |
| 2026-10-01 | F1-T10: `@agentsales/api/contracts` con su frontera de Biome (y un test); `validated` (`REQUEST_INVALID`); `listingSchema`, `ListingRepository.list`, `get` y `changeStatus`, `BrokerRepository.list` y `MediaRepository.listCovers`; `changeListingStatus` con `LISTING_MANUAL_TRANSITIONS` (fuera `active` y `closed` hasta F3); rutas `/listings`, `/listings/:id`, `PATCH /listings/:id/status` y `/brokers` |
| 2026-10-01 | Desde la revisión de F1-T10: `*_ROW_INVALID`, `IMPORT_RUN_INVALID` y `JOB_PAYLOAD_INVALID` responden 500; el JSON mal formado de `hono/validator` es `INVALID_JSON`; `ErrorBody` sale de `contracts`; `LISTING_MANUAL_TARGETS` en core; `contracts` sin `../`; corredores ordenados igual en Postgres y en memoria; `media` sin esquema en core (aclarado); notas en T12 (`externalRef`), T13 (etiquetas de atributos, TTL de las URLs) y F3 (tabla de estados provisional) |
| 2026-10-01 | F1-T11: rutas `/imports` (multipart con `bodyLimit` y 413, `/imports/local` solo en desarrollo, lista y detalle con nombres de archivo); `createStaging` en `@agentsales/importers/staging` y `createErrorThrottle` en `@agentsales/config`; `NewImportRun.id` e `ImportRunRepository.list`; `MAX_IMPORT_UPLOAD_MB` |
| 2026-10-01 | Desde la revisión de F1-T11: subidas guardadas en streaming (`File.stream()`) y `MAX_IMPORT_UPLOAD_MB` por defecto en 512; campos vacíos del formulario cuentan como no enviados; `saveInput` rechaza nombres con `\0` o de más de 255 bytes; `MAX_XLSX_BYTES` en core; `GET /imports` sin `report`; `IMPORT_RUN_CONFLICT` para un id repetido; rutas locales que terminan en `/` rechazadas; `stagingRootOf`; Biome impide que los adaptadores se importen entre sí; notas para T12 (`@agentsales/api/testing`), T14 (proxy y `Origin`) y F7 (roadmap) |
