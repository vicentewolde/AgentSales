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
    - `importListings(deps, input: ListingSheetInput)` recibe `{ headers, rows, broker }`, ya leído por `xlsx-reader`; no lee archivos. `headers` sirve para `checkHeaders`. `ListingSheetInput` es de core y el lector depende de él.
    - `ingestMedia`.
    - `requestImport`: crea el run y encola; si `enqueue` falla, deja el run en `failed`.
    - `changeListingStatus`.
  - `buildListingValidator(fieldDefs)`.
  - **sha256:** se inyecta como `deps.sha256(text): Promise<string>`; el worker lo compone con `node:crypto`.
  - **Puertos:**
    - `FieldDefinitionRepository`, `BrokerRepository`, `ListingRepository`, `MediaRepository` e `ImportRunRepository`.
    - `JobQueue`.
    - `MediaFileSource.list(folder): Promise<MediaFile[]>`, con `MediaFile = { relPath, kind, mime, bytes, sha256, open(): AsyncIterable<Uint8Array> }`.
  - **Contrato de jobs** en `core/src/jobs.ts` (`JOB_NAMES`, `JOB_PAYLOADS`).
  - **Entidades con esquema zod** (`listing`, `media`, `broker`, `importRun`, `importReport`) y tuplas nuevas (`IMPORT_RUN_STATUSES`, `LISTING_MANUAL_TRANSITIONS`), según ADR-0011.
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
  - Se descomprime en streaming en `tmp/imports/{id}/extracted/`.
  - Protección contra zip-slip: se rechazan rutas absolutas o con `..`, y se verifica que el destino quede dentro del directorio.
  - Topes: 4 GB descomprimidos y 2000 entradas.
- **Staging:**
  - `tmp/imports/{id}/input/` guarda el xlsx y el zip subidos. Se borra solo cuando el run llega a un estado terminal (`succeeded` o `failed`), para no perderlos entre reintentos.
  - `extracted/` se recrea en cada intento y se borra en un `finally`.
  - Al arrancar, el worker limpia los directorios de runs terminales y los de más de 24 h.
- Una propiedad sin ninguna foto queda en `draft` con advertencia (mínimo 1 foto para `ready`).

### 4.4 Contratos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/imports` | multipart `file` (xlsx) + `media` (zip, opcional) + `broker` (opcional) + `dryRun`. Guarda los archivos en `tmp/imports/{id}/`, crea el `import_run` en `queued`, encola `import.run` y responde `202` con el `ImportRun` |
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
  - Con un error no reintentable, o en el último intento (`retryCount >= retryLimit`, leído con `includeMetadata`), deja el run en `failed` con `error` **antes** de relanzar. Así ningún run queda en `running` para siempre, sea o no `AppError` el error.
- **Idempotencia:** el upsert por `external_ref`, la deduplicación por sha256 y el `storage_path` determinístico hacen que reintentar no duplique nada.
- **Errores reintentables:** `STORAGE_UNAVAILABLE` y `DB_UNAVAILABLE`.
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
  - `storage:check` verifica que R2 acepte el checksum que el SDK agrega por defecto a los streams. Si no, `requestChecksumCalculation: "WHEN_REQUIRED"`.
  - Un stream no se puede reintentar dentro del SDK, así que el reintento es el del job, que vuelve a abrir el archivo.
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
  - `importListings(deps, input: ListingSheetInput)` según §4.2, con `dryRun` y `sha256` inyectado.
  - Puertos `BrokerRepository`, `ListingRepository` e `ImportRunRepository`, con implementaciones Drizzle y en memoria.
  - Esquema `importReport` en core.
- **Hecho cuando:**
  - [ ] Test de idempotencia (dos importaciones: la segunda dice `skipped`)
  - [ ] Test de actualización (cambia el precio → `updated`)
  - [ ] Test: una fila con errores no se escribe ni detiene las demás, y el reporte trae fila, columna y motivo
  - [ ] Test: `dryRun` no escribe nada salvo el `import_run`
  - [ ] Test: reimportar no pisa un `status` puesto a mano
  - [ ] Tests de la hoja Corredor: crea el broker, lo actualiza, `BROKER_NOT_FOUND` y `BROKER_INVALID`
  - [ ] Tests con PGlite de los repositorios (upsert por `external_ref`)

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
  - `zip`: extracción en streaming con protección contra zip-slip y los topes de §4.3.
- **Hecho cuando:**
  - [ ] Tests con una carpeta fixture: 3 fotos + 1 video + 1 archivo inválido, en orden natural y con el sha256 correcto
  - [ ] Tests de zip: extracción normal, una entrada con `..` rechazada, y los topes de tamaño y de entradas superados

### F1-T07 · Caso de uso ingestMedia
- **Depende de:** T04, T05, T06
- **Descripción:** `ingestMedia` según §4.3:
  - Deduplicación, portada, clave en R2 y `putStream` con su `Content-Type`, subiendo antes de insertar.
  - Sube el logo del corredor.
  - Corre también para las filas `skipped`.
  - Pasa el listing a `ready` o `draft` según §4.2.
  - Puerto `MediaRepository`, con implementaciones Drizzle y en memoria.
- **Hecho cuando:**
  - [ ] Test con un `MediaStorage` y un `MediaFileSource` en memoria: suben 4 archivos válidos con su tipo, y el inválido va al reporte
  - [ ] Reimportar no vuelve a subir archivos (verificado por checksum)
  - [ ] Test: agregar una foto a una propiedad `skipped` la sube
  - [ ] Test: una propiedad sin fotos queda en `draft` con advertencia
  - [ ] Test: cambiar `foto_portada` desmarca la portada anterior

### F1-T08 · Paquete de cola
- **Depende de:** F0
- **Descripción:**
  - Extrae `packages/queue` desde `apps/worker/src/queue.ts`: puerto `JobQueue` en core, `JOB_NAMES` y `JOB_PAYLOADS` en `core/src/jobs.ts`, arranque diferido del `producer` y `QUEUE_SCHEMA` y `checkQueueSchema` mudados.
  - `QUEUE_NOT_INITIALIZED` se unifica con `QUEUE_UNAVAILABLE`.
  - Actualización de "Cola de trabajos" en `01-arquitectura.md`.
- **Hecho cuando:**
  - [ ] Test: `enqueue` con el esquema o la cola inexistentes → `QUEUE_UNAVAILABLE`
  - [ ] Los tests del worker de F0 siguen pasando, y `pnpm worker:ping` funciona con `packages/queue` (demo)

### F1-T09 · Job import.run
- **Depende de:** T07, T08
- **Descripción:**
  - Job `import.run` (§4.6) y `buildJobs(deps)` en el worker.
  - Caso de uso `requestImport` en core.
  - Staging en `<workspace>/tmp/imports`, con su limpieza al arrancar.
- **Hecho cuando:**
  - [ ] Tests del handler con fakes: éxito → `succeeded`; `STORAGE_UNAVAILABLE` → se propaga para reintento; último intento → `failed` con `error`; error no reintentable → `failed`; y un run ya terminal → no hace nada
  - [ ] Tests de `requestImport`: encola; si `enqueue` falla → run `failed` y staging borrado
  - [ ] Test: `extracted/` se borra aunque el intento falle, e `input/` se conserva hasta el estado terminal

### F1-T10 · Contratos HTTP y API de lectura
- **Depende de:** T04 y ADR-0011 aceptado
- **Descripción:**
  - Salida `@agentsales/api/contracts` (`errorBodySchema`, parámetros y respuestas), con su regla de Biome.
  - Helper de validación (`REQUEST_INVALID`).
  - Caso de uso `changeListingStatus` con `LISTING_MANUAL_TRANSITIONS`.
  - Rutas `/listings`, `/listings/:id`, `PATCH /listings/:id/status` y `/brokers`, con URLs firmadas.
- **Hecho cuando:**
  - [ ] Tests con `app.request` y repositorios en memoria: filtros, detalle, 404, `REQUEST_INVALID`, cambio de estado permitido y `409 INVALID_TRANSITION`
  - [ ] Biome rechaza un import de `@agentsales/config` o de `node:*` dentro de `contracts`
  - [ ] La guardia `no-node-types` del panel sigue pasando

### F1-T11 · API de importación
- **Depende de:** T09, T10
- **Descripción:**
  - `POST /imports` (multipart a `input/` mediante `AppDeps.uploads`, con `bodyLimit`).
  - `POST /imports/local`, habilitado con `AppDeps.localImports`.
  - `GET /imports` e `/imports/:id` (§4.4).
- **Hecho cuando:**
  - [ ] Tests con `app.request`, una `JobQueue` falsa y repositorios en memoria: `202` y job encolado; `/imports/local` → 404 si `localImports` es `false`; cuerpo demasiado grande → 413; xlsx de más de 10 MB → `REQUEST_INVALID`; cola caída → 503 y run `failed`; y `GET /imports/:id` no expone las rutas completas

### F1-T12 · CLI de importación y consulta
- **Depende de:** T11
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
- **Descripción:**
  - **Patrón:** `createApiClient` con el `hc` completo, y `unwrap(res)` que lee `ErrorBody` y lanza `ApiError { code, status }`. Un solo `ApiClientContext`, hooks por recurso en `src/queries/` con fábricas de `queryKey`, y `routes.tsx` separado de `App.tsx` con páginas en `React.lazy` (D5). El `HealthFetcher` desaparece con este patrón, y se actualiza la sección de tests del panel en `05-convenciones.md`.
  - **Propiedades:** grilla con portada, operación, tipo, comuna, precio formateado (`UF 5.800`, `$650.000`) y estado. Filtros en los parámetros de la URL.
  - **Detalle:** galería, atributos y cambio de estado.
- **Hecho cuando:**
  - [ ] Tests de componentes con el router en memoria (`initialEntries`) y un cliente inyectado: grilla, filtros desde la URL, detalle, cambio de estado y error de API
  - [ ] La página Estado de F0 sigue funcionando con el patrón nuevo

### F1-T14 · Panel: Importar
- **Depende de:** T11, T13
- **Descripción:** subir el xlsx y el zip (con el selector de corredor), y ver el progreso, el aviso de `queued` y el reporte por fila y columna.
- **Hecho cuando:**
  - [ ] Tests de componentes: envío del formulario, sondeo que se detiene en un estado terminal, aviso de `queued` y tabla de errores
  - [ ] Demo: flujo completo desde el navegador con los archivos de muestra

### F1-T15 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 1`.

Orden sugerido: T01 → T02/T03 → T04. T05, T06 y T08 se pueden hacer en cualquier momento después de F0. Luego T07 → T09. T10 va después de T04. T11 después de T09 y T10. Luego T12, T13 → T14, y al final T15.

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
| Run que queda en `running` para siempre | El handler lo deja en `failed` en el último intento, y un run terminal no se vuelve a procesar (§4.6) |
| Rutas relativas resueltas en otra carpeta | `findWorkspaceRoot()` para el staging, `INIT_CWD` en la CLI y rutas absolutas en `input` |
| Repositorios Drizzle sin tests contra Postgres en la CI | PGlite (D4) |

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
