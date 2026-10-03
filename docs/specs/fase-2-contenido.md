# Spec F2 · Contenido

- **Estado:** Aprobado (2026-10-02)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.2.0`
- **Referencias:** `docs/06-roadmap.md#f2--contenido`, ADR-0003, ADR-0005, ADR-0006, ADR-0010, ADR-0011, ADR-0012 y ADR-0013 (nuevos), `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/04-formato-publicaciones.md`, notas de `docs/integraciones/` (`claude-code-cli.md`, `anthropic-api.md`, `heic-conversion.md`, `instagram.md`, `mercadolibre.md`)

## 1. Objetivo
El operador pide "preparar contenido" para una propiedad cargada y, sin publicar nada, ve en el panel y la CLI cómo quedaría en cada canal: el carrusel de Instagram (portada, fotos y ficha), el caption y el reel, y las fotos y el texto de Portal Inmobiliario y de Marketplace. Puede corregir los textos a mano antes de aprobarlos en F3.

## 2. Alcance
- Mínimos y máximos en los campos numéricos (deuda de F1: hoy `dormitorios = -2` pasa).
- Puerto `LLMProvider` y paquete `packages/llm` con `claude-cli` y `fake`; `anthropic-api` como stub (ADR-0003).
- Generación **híbrida** de textos (ADR-0013): el código arma los datos (precio, superficies, dormitorios, contacto, títulos, listas) y la IA redacta solo las frases (gancho, presentación, entorno). Salida validada con zod y prompt versionado.
- Revisión editorial automática (`checkContent`): números, superlativos, dirección, notas internas, requisitos discriminatorios, largos y formato. Se muestra en el panel y la usa `pnpm eval:content`.
- Procesamiento de medios en `packages/media`: medidas (ancho, alto, duración), HEIC → JPEG, orientación y borrado de metadatos (GPS), y variantes `thumb`, `ig_4x5`, `pi_4x3` e `ig_reel`.
- Plantillas de portada, ficha y texto del reel (`packages/templates`), renderizadas con Playwright.
- Corridas de contenido (`content_runs`) como job `content.prepare` del worker, con avance por etapa y reintentos.
- API, CLI y panel: preparar, ver la vista previa por canal y editar los textos.
- `pnpm eval:content` sobre las propiedades de muestra, sin llamar a Anthropic en los tests.
- F2 no publica nada ni toca `PUBLISH_MODE`: todo queda en Neon y R2 para revisar.

## 3. Fuera de alcance
- Aprobar, rechazar y crear `publications` (F3). En F2 no hay cuentas conectadas: el contenido queda listo para revisar (ADR-0012).
- Que la IA elija o sugiera la portada o el orden de las fotos (D3). Manda `foto_portada` o, si viene vacía, la primera foto, como en F1.
- Enviar fotos a la IA (D3): los textos se escriben solo con los datos de la planilla.
- Etiquetas sobre las fotos del carrusel ("Cocina americana"): las fotos van sin texto.
- Cambiar la portada o el orden desde el panel: se cambian en la planilla (`foto_portada`, nombres de archivo) y se reimporta.
- Logo en HEIC: se omite con advertencia (se pide PNG o JPG en la planilla).
- Adaptador real `anthropic-api` con el SDK (F7).
- Google Sheets y Drive como origen directo (D8: backlog post-MVP).
- Mapeo a atributos de Mercado Libre (F4) y campos del formulario de Marketplace (F5).

## 4. Diseño

### 4.1 Componentes
- **core** (sin `node:*` ni tipos de Node):
  - Entidades con esquema zod: `contentRun`, `content` y `media` (`mediaSchema`, el esquema que F1 dejó pendiente; ADR-0011 → Seguimiento), con `MEDIA_VARIANTS` y `CONTENT_RUN_STATUSES`. La vista HTTP `mediaItemSchema` de `contracts` sigue siendo de la API.
  - Contenido (`src/content/`, ADR-0013): `buildContentBrief` (lo que ve la IA), el prompt versionado (`CONTENT_PROMPT_VERSION`), el esquema de salida (`contentDraftSchema`), `generateContentDraft` (llama al proveedor, valida y reintenta), el ensamblado por canal (`assembleContents`) y la revisión editorial (`checkContent`).
  - Composición de medios por canal: `composeCarousel` y `composePhotoSet` (§4.2).
  - Casos de uso: `requestContentRun`, `prepareContent` (el handler del job, §4.4), `getListingContent` y `editContent` (§4.6).
  - **Puertos nuevos:**
    - `LLMProvider` (§4.5).
    - `ContentRunRepository` y `ContentRepository` (§4.3).
    - `MediaProcessor` (§4.2), que maneja sus archivos temporales: core solo ve bytes y streams.
    - `SlideTemplates` (§4.2): arma el HTML de la portada, la ficha y el texto del reel, con su `version`. Los tipos de datos de cada plantilla (`CoverData`, `SpecSheetData`, `ReelOverlayData`) son de core.
    - `HtmlRenderer` (§4.2): convierte un HTML en imagen.
  - `MediaRepository` y `MediaStorage` se amplían (§4.2).
  - Contrato del job `content.prepare` en `JOB_NAMES` y `JOB_PAYLOADS`.
  - Dobles en memoria en `@agentsales/core/testing`, incluidos un `LLMProvider`, un `MediaProcessor`, un `SlideTemplates` y un `HtmlRenderer` falsos.
- **Nuevo `packages/llm`:** `createLlmProvider(options)` con `claude-cli`, `fake` y el stub `anthropic-api` (§4.5). Es solo transporte: el prompt y el esquema vienen de core.
- **Nuevo `packages/media`:** `createMediaProcessor(options)` con sharp (imágenes) y ffmpeg/ffprobe (HEIC y video), y `createHtmlRenderer(options)` con Playwright (Chromium).
- **Nuevo `packages/templates`:** implementa `SlideTemplates`. HTML y CSS con la tipografía Inter (resuelta con `import.meta.resolve`, seguimiento en ADR-0010) y los íconos en SVG.
- Los tres paquetes nuevos entran en el override de Biome de los adaptadores (sin `loadEnv` y sin importarse entre sí) y en `references` del `tsconfig.json` raíz.
- **db:** tres migraciones (§4.3), repositorios Drizzle de `content_runs` y `contents`, y `MediaRepository` con derivados y medidas.
- **storage:** `MediaStorage.getStream` (D3 de F1).
- **config:** variables nuevas (§4.8).
- **worker:** job `content.prepare` y su composición (proveedor de IA, procesador, plantillas, Chromium y directorio temporal por intento); script `eval:content`.
- **api:** rutas de corridas y contenidos (§4.7); `thumbUrl` y medidas en los medios.
- **cli:** comandos `prepare` y `content`; `doctor` con ffmpeg 8.1, ffprobe, Chromium y la sesión de Claude.
- **web:** sección Contenido en el detalle de la propiedad: preparar, avance, vista previa por canal, revisión editorial y edición.

### 4.2 Medios
- **Variantes** (`MEDIA_VARIANTS` en core). Todas en JPEG, salvo el reel:

  | Variante | Origen | Formato |
  |---|---|---|
  | `thumb` | cada foto, y un cuadro de cada video | lado mayor de 800 px, sin recorte, calidad 80. Para el panel (los navegadores no muestran HEIC) |
  | `ig_4x5` | cada foto | 1080×1350, recorte centrado, calidad 90. Instagram: JPEG sRGB de hasta 8 MB y entre 320 y 1440 px de ancho |
  | `pi_4x3` | cada foto | 1600×1200, recorte centrado, calidad 88. Mercado Libre recomendaría 1200 px y aceptaría hasta 1920 (por confirmar en F4) |
  | `ig_reel` | el primer video del aviso | MP4 H.264 (4:2:0, GOP cerrado) + AAC, 1080×1920, 30 fps, `moov` al inicio y sin edit lists, hasta 90 s (se corta) y bajo 300 MB; fondo desenfocado si no es vertical; el texto del reel encima durante los primeros 2 s |
  | `cover` | render | portada del carrusel, 1080×1350 |
  | `spec_sheet` | render | ficha del carrusel, 1080×1350 |

  Los parámetros (tamaños, calidad, recorte) viven en una constante de `packages/media` con su versión (`MEDIA_PIPELINE_VERSION`, que el procesador expone como `version`). Cambiarla regenera las variantes en la siguiente corrida. Requisitos de Meta y Mercado Libre en `docs/integraciones/instagram.md` y `mercadolibre.md`.
- **Fotos:** se rotan según su EXIF, se convierten a sRGB y se les **borran los metadatos**, incluida la ubicación GPS de los iPhone (privacidad: la dirección exacta puede estar oculta).
- **HEIC:** el original se conserva; las variantes salen en JPEG. Los binarios de sharp no decodifican HEIC (`docs/integraciones/heic-conversion.md`), así que ffmpeg (8.1 o más nuevo, que arma las fotos de iPhone hechas de mosaicos) lo pasa a un JPEG intermedio de alta calidad y sharp sigue desde ahí. Verificado en local con ffmpeg 9.0.1: un HEIC de 3840×2160 en mosaicos sale completo. Por eso las fotos también necesitan ffmpeg.
- **Fotos chicas:** una foto de menos de 1080 px de ancho se amplía para `ig_4x5` y deja una advertencia; una de menos de 1200 px deja otra advertencia para Portal.
- **Videos:** ffprobe mide duración, ancho, alto y rotación. Solo el primer video (por orden) genera reel; los demás, solo `thumb`. Un video de menos de 3 s (el mínimo de Meta) no genera reel (advertencia). El tope de 90 s es política nuestra: Meta acepta hasta 15 min.
- **Medidas:** `width`, `height` y `duration_s` del original se guardan al procesarlo (D6 de F1), ya rotados.
- **Claves en R2** (determinísticas, para que reintentar sobrescriba lo mismo):
  - Derivado de una foto o `thumb` de un video: `brokers/{b}/listings/{l}/processed/{variante}/{sha256-del-original}-v{version}.jpg`.
  - Reel: `brokers/{b}/listings/{l}/processed/ig_reel/{sha256-del-original}-{sha256-del-texto}.mp4`, donde el segundo hash es el del JSON canónico de `ReelOverlayData`, la versión de las plantillas y la del procesador. Si cambia el precio, cambia la clave y el reel se rehace.
  - Render: `brokers/{b}/listings/{l}/rendered/{variante}/{sha256-de-la-entrada}.jpg`. La entrada es el JSON canónico de los datos de la plantilla, la versión de las plantillas y los sha256 de las imágenes que usa (la variante `ig_4x5` de la portada y el logo).
  - Core calcula estos hashes con `deps.sha256(text)` inyectado, como `importListings` (core no usa `node:crypto`). Los sha256 de los bytes producidos los devuelven el procesador y el renderizador.
- **Registro:** un derivado es una fila de `media` con `role = processed`, `variant` y `parent_media_id`; un render tiene `role = rendered`, `variant` y `parent_media_id = null`. `checksum` es el sha256 de la salida, que calcula el procesador o el renderizador. Hay **uno vigente** por original y variante, y por aviso y variante de render (únicos de §4.3). Si cambia la clave, la fila se reemplaza en su lugar y el objeto anterior se borra de R2 (si falla, solo queda en el log). Si cambia el primer video, el reel del anterior se borra.
- **`MediaRepository`** suma `listByListing(listingId)` (originales y derivados), `get(id)` (cualquier medio, por ejemplo el logo), `listVariants(parentIds, variant)` (una variante de varios originales en una consulta: las miniaturas de la lista), `updateMeasurements(id, { width, height, durationS })`, `upsertDerivative(...)` (inserta o reemplaza el vigente y devuelve la clave anterior si cambió) y `deleteDerivative(id)`. Los métodos de F1 (`listOriginals`, `listCovers`, `findByStoragePath`, `arrange`) siguen viendo solo originales. El doble en memoria pasa a modelar `role`.
- **`MediaStorage.getStream(path, { signal? }): Promise<AsyncIterable<Uint8Array>>`:** para videos de hasta 300 MB, que no caben cómodos en memoria. `STORAGE_NOT_FOUND` si no existe. Quien lo pide y no lo lee debe llamar a `return()` o disparar `signal` para liberar la conexión.
- **Cortar trabajo largo:** los puertos que reciben una señal usan `AbortSignalLike` (core), un tipo mínimo que cumple el `AbortSignal` de Node sin cargar sus tipos en core. Vale también para `LLMProvider`, `MediaProcessor` y `HtmlRenderer` (donde este spec dice `AbortSignal`).
- **`MediaProcessor`** (puerto). El worker lo crea por intento, con el directorio temporal de ese intento; core nunca ve rutas:
  ```ts
  interface MediaProcessor {
    readonly version: string;
    processImage(input: Uint8Array, opts: { mime: string; variants: ImageVariant[] }, signal?: AbortSignalLike):
      Promise<{ measurements: MediaMeasurements; outputs: ImageOutput[]; warnings: MediaWarning[] }>;
    processVideo(input: AsyncIterable<Uint8Array>, opts: { reel: { overlayPng: Uint8Array } | null }, signal?: AbortSignalLike):
      Promise<{ measurements: MediaMeasurements; thumb: ImageOutput; reel: VideoOutput | null; warnings: MediaWarning[] }>;
  }
  // ImageVariant = Exclude<ProcessedMediaVariant, "ig_reel">; MediaMeasurements es de MediaRepository (T03)
  // ImageOutput = { variant, bytes, width, height, mime, sha256 }
  // VideoOutput = { size, sha256, width, height, durationS, open(): AsyncIterable<Uint8Array> }  // size en bytes; se sube con putStream
  ```
  - La etapa `media` llama a `processVideo` con `reel: null` (medidas y `thumb`); la etapa `reel` hace una segunda pasada con el PNG del texto, que sale del renderizador.
  - Los procesos hijos (ffmpeg, ffprobe) se cortan con el `AbortSignal`. Los temporales los borra el worker en un `finally`, al terminar el intento: el puerto no tiene `dispose`.
  - Errores: `MEDIA_DECODE_FAILED` (el archivo no se puede leer: advertencia de ese medio, no corta la corrida) y `MEDIA_TOOL_NOT_INSTALLED` (falta ffmpeg o ffprobe, o es anterior a 8.1: no reintentable, con el comando para instalarlo).
- **Composición** (core, pura):
  - **Carrusel de Instagram:** `cover`, después las fotos (`ig_4x5`) en el orden del aviso sin la de portada (que ya está en el render), hasta 8, y al final `spec_sheet`. Máximo 10 elementos, el límite de la API.
  - **Portal y Marketplace:** las fotos `pi_4x3`, la portada primero y después el orden del aviso.
  - **Reel:** el `ig_reel` cuyo padre es el primer video actual, si existe.
- **`SlideTemplates`** (puerto; `packages/templates`):
  - `cover(data: CoverData)`: la foto de portada a sangre, degradado inferior, etiqueta `VENTA` o `ARRIENDO`, precio grande, `Tipo · Comuna`, íconos de m² útiles, dormitorios y baños (los que existan) y el logo en una esquina, con los colores del corredor. La foto y el logo llegan como `{ bytes, mime, sha256 }`: la plantilla arma el `data:` y la clave del render usa el `sha256` (no los bytes). La foto es la variante `ig_4x5` (JPEG), así que una portada HEIC funciona; el logo es el original (PNG o JPG).
  - `specSheet(data: SpecSheetData)`: fondo con el color primario, tabla de atributos con íconos, disponibilidad y contacto (WhatsApp e Instagram del corredor).
  - `reelOverlay(data: ReelOverlayData)`: texto `Operación · Tipo · Comuna · Precio` sobre fondo transparente, 1080×1920.
  - Textos dentro de márgenes de 64 px; los datos se escapan (vienen del Excel). La dirección exacta nunca aparece en una plantilla. Tipografía Inter (licencia OFL) como `data:` en el CSS, íconos SVG propios y nada de red.
- **`HtmlRenderer`** (puerto; Playwright en `packages/media`):
  - `render(html, { width, height, format: "jpeg" | "png" }, signal?)` → `{ bytes, sha256 }`.
  - Un Chromium por proceso, que se abre al primer render y se cierra al apagar el worker. Cada render usa una página nueva que **bloquea toda la red** (solo `data:`), con un tope de 30 s.
  - Instagram solo acepta JPEG, así que la portada y la ficha salen en JPEG (calidad 90), no en PNG como decía el roadmap. El texto del reel sale en PNG con transparencia y no se guarda.
  - `RENDER_BROWSER_NOT_INSTALLED` si falta Chromium (no reintentable, con `pnpm --filter @agentsales/media exec playwright install chromium`).

### 4.3 Datos
Las migraciones se numeran al generarlas con drizzle-kit, en el orden de las tareas: **T01 → T02 → T03** (cada una parte de la anterior).
- **Migración de T01 · rangos:** `field_definitions.min_value` y `max_value` (`numeric null`). Un número fuera de rango es `FIELD_NUMBER_INVALID` (el código que ya usa el tope del precio), con el rango en el motivo. El seed fija:

  | Campo | Mínimo | Máximo |
  |---|---|---|
  | `dormitorios`, `banos` | 0 | 50 |
  | `estacionamientos`, `bodegas` | 0 | 100 |
  | `sup_util_m2`, `sup_total_m2`, `sup_terreno_m2` | 1 | 1.000.000 |
  | `piso` | -10 | 200 |
  | `ano_construccion` | 1800 | 2100 |
  | `gastos_comunes_clp`, `contribuciones_trimestrales_clp` | 0 | — |

  Un corredor puede sobrescribirlos con su propia definición, como el resto.
- **Migración de T02 · contenido** (ADR-0012):
  - **`content_runs`** (nueva): `id`, `listing_id` (FK), `status` (enum `content_run_status` desde `CONTENT_RUN_STATUSES`: `queued`, `running`, `succeeded`, `failed`; default `queued`), `texts boolean default true` (si la corrida genera textos), `stage text null` (`media`, `renders`, `reel` o `texts`), `report jsonb null` (`contentRunReportSchema`: medios procesados, existentes y con problemas, renders, reel, datos de la llamada a la IA y advertencias), `error jsonb null` (`{ code, message }`), `started_at` y `finished_at` (`null`), y `created_at` y `updated_at`. Sin `broker_id`: sale del aviso.
    - Único parcial `(listing_id) WHERE status IN ('queued', 'running')`: una sola corrida activa por aviso.
    - Índice `(listing_id, created_at)` para la última corrida.
  - **`contents`:** suma `content_run_id uuid not null` (FK a `content_runs`; la tabla está vacía desde F0, así que la migración falla a propósito si no lo está), el único `(content_run_id, platform)` y el índice `(listing_id, platform, created_at)`. El contenido **vigente** de un aviso en un canal es su fila más reciente (`created_at` y después `id`). Una corrida con `texts = false` no crea filas y deja vigente lo anterior, con sus ediciones.
- **Migración de T03 · medios:** únicos parciales `(parent_media_id, variant) WHERE role = 'processed'` y `(listing_id, variant) WHERE role = 'rendered'`.
- Cada tarea actualiza `docs/02-modelo-datos.md` (columnas, enums, diagrama).

### 4.4 Corrida de contenido (job `content.prepare`)
- **Pedir** (`requestContentRun({ listingId, texts })`):
  - El aviso debe estar en `ready`, `paused` o `active`, con al menos una foto; si no, `LISTING_NOT_READY` (409).
  - Si ya hay una corrida activa del aviso, la devuelve con `reused: true` (y su propio `texts`, que puede no ser el pedido). Si está en `queued`, **vuelve a encolar** `{ contentRunId }`: con `singletonKey` es idempotente, y así una corrida cuyo job se perdió no bloquea el aviso.
  - **Ediciones a mano:** con `texts = true`, si el contenido vigente de algún canal está en `edited`, responde `CONTENT_EDITED` (409) salvo que venga `replaceEdits: true`. Así ni la CLI ni la API reemplazan una edición sin avisar. Las filas reemplazadas quedan en la base, pero en F2 no hay vista para recuperarlas.
  - Si no, crea la corrida en `queued` y encola. Si `create` choca con el único (`CONTENT_RUN_CONFLICT`, otra petición ganó la carrera), busca la activa y la devuelve.
  - Si `enqueue` falla, la corrida nueva queda en `failed` con `QUEUE_UNAVAILABLE` (503), como en `requestImport`.
- **Política de la cola:** `exclusive` con `singletonKey = contentRunId`, 2 reintentos con backoff desde 30 s y expiración a los 30 min.
- **Handler (`prepareContent`)**, por etapas. Cada una es idempotente, así que un reintento rehace solo lo que falta:
  0. Si la corrida ya es terminal (`succeeded` o `failed`), no hace nada (`skipped`). `markRunning` es condicional: solo pasa a `running` desde `queued` o `running`.
  1. **`media`:** mide y procesa cada original sin sus variantes vigentes (clave de la versión actual). Las fotos se leen con `get`; los videos, con `getStream` (`processVideo` con `reel: null`). Las medidas se guardan (`updateMeasurements`) **antes** que las variantes: si la corrida se corta entre los dos, la siguiente no salta un original sin medidas. Las claves de R2 salen de una sola función pura de core, que usan la etapa y sus tests para saber qué variante está vigente (comparando `storagePath`). En `listByListing` el orden de los derivados no significa nada: la composición ordena por el original.
  2. **`renders`:** portada y ficha, si cambió su entrada.
  3. **`reel`:** con el primer video, si su clave cambió (segunda pasada de `processVideo` con el PNG del texto); borra el reel de otro video si quedó uno.
  4. **`texts`** (si `texts = true`): arma el brief, llama a la IA, valida, ensambla y guarda las 3 filas de `contents` en una transacción con el paso a `succeeded`.
  - Al empezar cada etapa actualiza `stage`. El reporte suma las advertencias de cada medio (texto fijo por código, sin claves de R2) y las de la IA.
  - Un medio ilegible (`MEDIA_DECODE_FAILED`) es una advertencia y la corrida sigue. Si no queda ninguna foto procesada, la corrida falla con `CONTENT_NO_PHOTOS`.
- **Cierre condicional:** `markSucceeded` solo cambia una corrida en `running`. Si no cambia nada, o si choca con `(content_run_id, platform)` porque un intento solapado (el que expiró y siguió corriendo) ya guardó, el intento termina como `skipped`, no como `failed`, igual que `runImport`.
- **Errores:** como `import.run`. Un error no reintentable, o el último intento, deja la corrida en `failed` con `error` antes de relanzar, y un error que no es `AppError` se normaliza a `INTERNAL_ERROR`. Reintentables: `STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE`, `LLM_UNAVAILABLE`, `LLM_TIMEOUT`, `LLM_ABORTED` y los `*_CONFLICT`. **Corte por apagado:** si el `signal` del worker se disparó, el handler relanza **sin** `markFailed`, también en el último intento (mira `signal.aborted`, no el código de cada adaptador): la corrida queda en `running` y la retoma pg-boss o la cierra la limpieza de abandonadas.
- **Apagado:** el handler recibe un `AbortSignal` que el worker dispara al apagarse; el procesador, el renderizador y la CLI de Claude matan sus procesos hijos con él. Así no quedan procesos `claude` gastando cuota después de apagar.
- **Corridas abandonadas o sin job:** al arrancar, el worker cierra como `failed` con `CONTENT_RUN_ABANDONED` las `running` con `started_at` de hace más de 2 h (3 intentos de 30 min más margen), y **reencola** todas las `queued` (idempotente con `singletonKey`), sin fallarlas: con el worker apagado salvo al desarrollar (ADR-0007), una corrida puede esperar días en cola y su pedido sigue siendo válido.
- **Archivos temporales:** `<workspace>/tmp/content/{runId}/{uuid-del-intento}/`, borrado en un `finally`. Al arrancar, el worker borra los de más de 24 h.
- **ADR-0005:** no se crea el job `media.process` de la lista inicial: el procesamiento es la primera etapa de `content.prepare` (ADR-0012 y seguimiento de ADR-0005).

### 4.5 IA (ADR-0003 y ADR-0013)
- **Puerto:**
  ```ts
  interface LLMProvider {
    readonly name: LlmProvider;   // "claude-cli" | "anthropic-api" | "fake"
    generateStructured(req: {
      system: string;
      prompt: string;
      jsonSchema: Record<string, unknown>;   // JSON Schema draft-07, sin largos ni topes
      signal?: AbortSignal;
    }): Promise<{ data: unknown; model: string }>;
  }
  ```
  - Core genera `jsonSchema` con `z.toJSONSchema` desde una forma **sin topes** del borrador (la CLI no aplica largos), y valida `data` con el esquema estricto (`contentDraftSchema`, con topes). El adaptador solo valida su propio sobre.
  - Sin imágenes en F2 (D3): el campo `images` del contrato de `01-arquitectura.md` se quita hasta que haga falta.
- **Errores** (`AppError`):

  | Código | Reintentable | Cuándo |
  |---|---|---|
  | `LLM_UNAVAILABLE` | sí | la CLI o la API no respondió, se cayó o está sobrecargada |
  | `LLM_TIMEOUT` | sí | pasó `LLM_TIMEOUT_SECONDS` |
  | `LLM_ABORTED` | sí | se cortó con `signal` (por ejemplo, al apagar el worker); el job se reintenta después |
  | `LLM_AUTH_REQUIRED` | no | la CLI no tiene sesión: "abre `claude` y usa /login" |
  | `LLM_RATE_LIMITED` | no | se alcanzó el límite de uso del plan: "intenta más tarde" |
  | `LLM_OUTPUT_INVALID` | no | la salida no calza dos veces, se cortó por largo (`max_tokens`), el modelo se negó (`refusal`) o se agotaron los turnos |
  | `LLM_NOT_CONFIGURED` | no | el stub `anthropic-api`, o la CLI no está instalada o no se puede ejecutar |
- **Validación y reintento** (`generateContentDraft`, core, igual para todo proveedor): si `data` no calza con `contentDraftSchema`, se reintenta **una vez** con el error de validación en el prompt; si vuelve a fallar, la corrida queda `failed` con `LLM_OUTPUT_INVALID` y el contenido anterior sigue vigente.
- **`claude-cli`** (detalle en `docs/integraciones/claude-code-cli.md`):
  - Ejecuta `CLAUDE_CLI_PATH` (default `claude`) con `-p`, `--output-format json`, `--json-schema`, `--model LLM_MODEL`, `--system-prompt` propio, `--tools ""` (sin herramientas), `--safe-mode` (sin `CLAUDE.md`, skills, plugins, hooks ni MCP; la sesión del plan sigue), `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`. `--max-turns` no existe en la 2.1.243 (confirmado en T04): el tope de tiempo es el único límite. El prompt va por stdin, nunca en los argumentos.
  - **No usa `--bare`:** ese modo exige `ANTHROPIC_API_KEY` y no usa el login del plan Max.
  - Corre en un directorio vacío creado con `mkdtemp` en el temporal **del sistema** (`os.tmpdir()`), fuera del repo: Claude Code también lee el `CLAUDE.md` de los directorios padre, así que un directorio dentro del repo no protegería. `--safe-mode` es la defensa principal y este directorio, la segunda.
  - **Entorno mínimo:** solo `PATH`, `HOME`, `USER`, `LANG` y `TMPDIR`. Nunca pasa las del `.env` (base de datos, R2, cifrado) ni `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` o `CLAUDE_CODE_USE_*`: con una clave en el entorno, la CLI cobra por API en vez de usar el plan del operador.
  - **Sobre JSON** (validado con zod): el dato va en `structured_output`. `subtype = error_max_structured_output_retries` o `error_max_turns`, `stop_reason = max_tokens` o `refusal`, y un `success` sin `structured_output`, son `LLM_OUTPUT_INVALID`; "Not logged in" es `LLM_AUTH_REQUIRED`; "You've hit your … limit" y los mensajes de saldo o facturación ("Credit balance is too low") son `LLM_RATE_LIMITED`, no reintentable a propósito (la nota lo marca como "reintentar más tarde": eso lo decide el operador, no el job); el resto, `LLM_UNAVAILABLE`. Los textos de error no son un contrato documentado: T04 los fija con una prueba de humo local (pocas llamadas cortas con datos inventados, del plan del operador) y los guarda como fixture del ejecutable falso.
  - Tope de tiempo y `AbortSignal`: la CLI corre en su propio grupo de procesos, que se corta con SIGINT, después SIGTERM y al final SIGKILL (la CLI no tiene tope propio). Por eso un Ctrl+C a `pnpm dev` no le llega: el worker debe disparar el `signal` y esperar al handler antes de salir (T11).
  - El sobre se clasifica primero por sus campos (`subtype`, `stop_reason`, `api_error_status`) y solo después por el texto de `result`, nunca por `errors`, que puede traer texto del aviso. Un 429 de la API es `LLM_UNAVAILABLE`, reintentable. El modelo que respondió es el de `modelUsage` con más tokens de salida.
  - **Solo uso propio** del operador (ADR-0003).
- **`anthropic-api` (stub):** el entorno exige `ANTHROPIC_API_KEY` si `LLM_PROVIDER=anthropic-api` (deuda de F1), y el adaptador responde `LLM_NOT_CONFIGURED` ("llega en F7"). No agrega el SDK.
- **`fake`:** proveedor de ejecución (para `LLM_PROVIDER=fake` y `eval:content --provider fake`) que devuelve el dato que le pasa quien lo compone: el borrador de ejemplo de core (`SAMPLE_CONTENT_DRAFT`, T05), que pasa la revisión editorial sin errores. Los tests de core usan su propio doble en `@agentsales/core/testing` (con respuestas en orden y registro de peticiones), porque core no puede depender de `packages/llm` y `packages/llm` no puede importar la salida de tests de core.
- **Logs:** solo proveedor, modelo, duración, intentos y largo del prompt. Nunca el prompt ni la respuesta (traen datos de clientes).

### 4.6 Contenido (ADR-0013)
- **Brief** (`buildContentBrief(listing, definitions, broker)`, core): lo único que ve la IA.
  - Operación, tipo, región, comuna, `sector_referencia`, precio y gastos comunes ya formateados (`formatListingPrice`), los atributos efectivos con su etiqueta y valor formateado (`describeAttributes`; el filtro de `fields` que hoy vive en `apps/api/src/routes/listings.ts` pasa a core, deuda de F1), `destacados`, `disponibilidad`, `amenities`, `requisitos_arriendo` (para que la IA los filtre; solo en arriendo), y tono, marca y hashtags fijos del corredor (para que la IA no los repita).
  - **Nunca:** `internal_notes`, `_extra` (columnas desconocidas), links ni contacto. La dirección y el número de unidad solo si `show_exact_address = true`.
- **Prompt** (`listing-content-v1`): las reglas editoriales de `04-formato-publicaciones.md` en el prompt de sistema, y los datos del aviso como JSON (con sus caracteres escapados) dentro de un bloque delimitado, con la instrucción de tratarlos como datos y nunca como órdenes (el Excel lo escribe un tercero). Un texto del Excel que imite el delimitador no puede cerrar el bloque.
- **Salida de la IA** (`contentDraftSchema`): solo frases.
  ```json
  {
    "instagram": { "hook": "...", "body": "...", "hashtags": ["..."] },
    "portal_inmobiliario": { "presentation": "...", "location": "...", "conditions": "..." },
    "fb_marketplace": { "intro": "..." },
    "warnings": ["Se omitió un requisito discriminatorio: ..."]
  }
  ```
  Con topes de largo por campo (solo en el esquema estricto); `location` y `conditions` admiten `null` (sin datos, se omite). Los títulos no los escribe la IA.
- **Ensamblado** (`assembleContents(brief, draft, contact)`, core, puro), según `04-formato-publicaciones.md`:
  - **Instagram:** caption con la línea de tipo, el gancho, la línea de datos (`📐 … m² útiles · 🛏 … dorm · 🛁 … baños · 🚗 … est`, solo los que existen; estacionamientos solo si es mayor que 0), el precio (`💰 UF 5.800 | GC aprox. $120.000`), el texto de la IA, el contacto (WhatsApp del corredor, o solo DM si no tiene) y los hashtags. Los hashtags se guardan en `contents.hashtags`, aparte de `body`: el caption que se publica (F3) y el que se mide es `instagramCaption({ body, hashtags })`. Hashtags: `#{comuna}` y `#{tipo}{operación}`, los fijos del corredor y los de la IA, normalizados (`normalizeHashtag`: minúsculas, sin tildes ni espacios), sin repetir y entre 5 y 12. Máximo 2.200 caracteres con los hashtags: si se pasa, se recorta el texto de la IA.
  - **Portal Inmobiliario:** título armado por el código con operación, tipo, dormitorios y comuna, sin abreviaturas ni adjetivos y de hasta 60 caracteres (`docs/integraciones/mercadolibre.md`, por confirmar en F4): `Departamento en venta 3 dormitorios 2 baños en Ñuñoa`. Singular y plural (`1 dormitorio`); con 0 dormitorios se omite. Si se pasa, se quitan primero los baños y después los dormitorios. Descripción en texto plano, sin emojis: presentación, `Características:` (lista desde los atributos), `Espacios comunes:` (si hay `amenities`), `Ubicación y conectividad:` (si la IA la redactó), `Condiciones:` (disponibilidad y requisitos filtrados) y un cierre sin teléfono ni email (las reglas de contacto de Mercado Libre se verifican en F4).
  - **Marketplace:** el mismo título (con el tope de 60 de Portal hasta confirmar el de Marketplace en F5) y una descripción intermedia: la introducción de la IA, los datos principales, el precio y el WhatsApp.
  - Las 3 filas guardan `llm_provider`, `llm_model`, `prompt_version` y `raw_output` (la salida validada de la IA).
- **Revisión editorial** (`checkContent(platform, { title, body, hashtags }, ctx)`, core, pura), con `ctx = { brief, contact, private: { address, unitNumber, internalNotes } }`: lo privado no va al brief, pero la revisión lo necesita para detectar una fuga (por ejemplo, en una edición manual). Devuelve `{ code, severity, message }[]`:

  | Código | Severidad | Qué revisa |
  |---|---|---|
  | `NUMBER_NOT_IN_DATA` | error | un número del texto que no está en los datos ni en el contacto |
  | `ADDRESS_EXPOSED` | error | la calle o el número de unidad, con `show_exact_address = false` |
  | `INTERNAL_NOTES_LEAK` | error | 6 palabras seguidas de `internal_notes` |
  | `DISCRIMINATORY` | error | requisitos por nacionalidad, hijos, estado civil, religión, edad o sexo (lista en core) |
  | `EMOJI_NOT_ALLOWED` | error | emojis en el título o la descripción de Portal |
  | `TOO_LONG` | error | caption de más de 2.200 caracteres (medido con `instagramCaption`, con los hashtags), o título de más de `LISTING_TITLE_MAX_LENGTH` |
  | `AMENITY_NOT_IN_DATA` | advertencia | un amenity o servicio cercano (piscina, quincho, metro…) que no está en los datos |
  | `SUPERLATIVE` | advertencia | "increíble", "único", "espectacular"… |
  | `MARKDOWN` | advertencia | `**`, encabezados o links de markdown en Instagram |
  | `HASHTAG_COUNT` | advertencia | menos de 5 o más de 12 hashtags |

  Se calcula al leer, así que no se guarda.
- **Leer** (`getListingContent(listingId)`, core): el contenido vigente por canal con su revisión, el carrusel, las fotos de Portal y Marketplace, el reel y la última corrida.
- **Editar** (`editContent(contentId, { title?, body?, hashtags? })`, core): solo el contenido vigente de su canal (si no, `CONTENT_NOT_CURRENT`, 409; lo compara con `listCurrent`). Mientras el aviso tenga una corrida activa con `texts = true`, responde `CONTENT_RUN_ACTIVE` (409): esa corrida reemplazaría la edición sin avisar, porque `CONTENT_EDITED` solo se revisa al pedirla (desde la revisión de F2-T02). Deja `status = edited` y devuelve el contenido con su revisión. En F2 no hay `approved` (F3). **Hashtags** (desde la revisión de F2-T05): en Instagram se normalizan con `normalizeHashtag` y se descartan los vacíos y repetidos; en Portal y Marketplace deben venir vacíos (si no, `VALIDATION_ERROR`, 400).

### 4.7 Contratos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/listings/:id/content-runs` | `{ texts?: boolean, replaceEdits?: boolean }` (`texts` por defecto `true`). `202` con la corrida (`ContentRunView`) y `reused` si ya había una activa. `409 LISTING_NOT_READY` o `CONTENT_EDITED` |
| GET | `/content-runs/:id` | estado, etapa, reporte y error |
| GET | `/listings/:id/content` | `getListingContent`: contenido vigente por canal (`id`, `title`, `body`, `hashtags`, `status`, `checks`, `updatedAt`, `promptVersion`), carrusel, fotos de Portal y Marketplace y reel (URLs firmadas), y la última corrida |
| PATCH | `/contents/:id` | `editContent`: `{ title?, body?, hashtags? }` → el contenido con `checks`. `409 CONTENT_NOT_CURRENT` o `CONTENT_RUN_ACTIVE` |
| GET | `/listings/:id` | (cambia) cada medio suma `thumbUrl` (o `null`) y sus medidas; solo lista originales |
| GET | `/listings` | (cambia) la portada usa `thumb` si existe (`listCovers` y después `listVariants` de esas portadas, sin una consulta por aviso), para que una portada HEIC se vea |

- Los esquemas van en `@agentsales/api/contracts`, y las entidades (`contentRun`, `content`, `media`) en core (ADR-0011). La vista HTTP del contenido no expone `rawOutput`, `llmProvider` ni `llmModel` (solo `promptVersion`).
- `LISTING_NOT_READY`, `CONTENT_EDITED`, `CONTENT_NOT_CURRENT` y `CONTENT_RUN_ACTIVE` responden 409: se suman a la tabla de códigos de `05-convenciones.md`.
- **CLI:**
  ```
  agentsales prepare <external_ref|id> [--broker <slug>] [--no-texts] [--replace-edits] [--no-wait]
  agentsales content <external_ref|id> [--broker <slug>] [--platform instagram|portal|marketplace] [--json]
  ```
  - `prepare` encola y espera como `import` (cada 2 s, con el aviso de "sigue en cola" a los 20 s y los mismos topes), mostrando la etapa, y termina con el resumen (medios procesados, advertencias y revisión editorial). Si la corrida ya existía, lo dice.
  - Si hay textos editados a mano, `prepare` sin `--replace-edits` termina con un mensaje que lo explica y sugiere `--no-texts` o `--replace-edits`.
  - `content` imprime los textos vigentes y su revisión.
  - Los nombres cortos de `--platform` (`portal`, `marketplace`) se traducen a `PLATFORMS` en un solo lugar de core (`PLATFORM_SHORT_NAMES`).
- **Panel:** en el detalle, la sección **Contenido**:
  - "Preparar contenido" y "Rehacer imágenes" (`texts: false`), con el avance por etapa y el error en lenguaje simple si falla.
  - Pestañas Instagram (carrusel deslizable, caption con "ver más" y reel), Portal Inmobiliario y Marketplace (fotos 4:3, título y descripción).
  - La revisión editorial de cada canal (errores en rojo y advertencias en ámbar) y la edición de los textos (T15).
  - La galería y la lista usan `thumbUrl` cuando existe (las fotos HEIC se ven).

### 4.8 Configuración y entorno
- Variables nuevas: `CLAUDE_CLI_PATH` (default `claude`), `LLM_TIMEOUT_SECONDS` (default 180) y `FFPROBE_PATH` (default `ffprobe`), en `packages/config` y `.env.example`.
- `LLM_PROVIDER=anthropic-api` exige `ANTHROPIC_API_KEY`.
- **`agentsales doctor`:**
  - ffmpeg 8.1 o más nuevo, y ffprobe (T07; hoy solo revisa que exista ffmpeg).
  - Chromium de la versión que pide el Playwright instalado (T09; hoy avisa "se necesita en F5").
  - Sesión de la CLI de Claude con `claude auth status`, sin gastar cuota (T04).
- **Requisitos locales** (`docs/08-guia-operador.md` y `docs/07-checklist-cuentas.md`, cada uno en su tarea: T04 la CLI de Claude, T07 ffmpeg con ffprobe y T09 Chromium): ffmpeg con ffprobe (`brew install ffmpeg`), Chromium de Playwright y la CLI de Claude con sesión iniciada.
- **CLAUDE.md:** comandos `prepare`, `content` y `eval:content` (en sus tareas).

### 4.9 Comportamiento sin red
- **Neon o R2 caídos:** como en F1 (503 en la API; el job reintenta y deja la corrida en `failed` al agotar).
- **La CLI de Claude sin sesión o con el límite alcanzado:** la corrida queda `failed` con un mensaje que dice qué hacer. Las etapas de medios ya hechas quedan, y la siguiente corrida no las repite.
- **La IA tarda o se cae:** `LLM_TIMEOUT` o `LLM_UNAVAILABLE`, con 2 reintentos.
- **Falta ffmpeg o Chromium:** `MEDIA_TOOL_NOT_INSTALLED` o `RENDER_BROWSER_NOT_INSTALLED`, no reintentables, con el comando para instalarlos.
- **Sondeo:** la CLI y el panel solo consultan mientras la corrida está `queued` o `running`, con los mismos topes que la importación (`IMPORT_WAIT` pasa a `RUN_WAIT` en T13).
- **Logs:** un error por intento, con `contentRunId`, sin datos del aviso.

### 4.10 Decisiones (el operador dejó aprobación permanente: se aplican las recomendaciones y se le informan)
- **D1 · Contenido sin publicaciones hasta F3 (ADR-0012).** El roadmap pedía dejar el contenido en `pending_approval`, que es un estado de `publications`, y `publications.platform_account_id` es obligatorio, pero las cuentas llegan en F3. F2 crea solo `contents` (en `draft` o `edited`) y sus corridas; las publicaciones nacen en F3 con la cuenta. Se descartaron sembrar una cuenta falsa en `dry-run` y hacer opcional la FK. El criterio de aceptación de F2 pasa a "contenido listo para revisar".
- **D2 · Textos híbridos (ADR-0013).** Los datos los pone el código y la IA redacta frases. Así el precio, las superficies y el contacto no dependen del modelo. Prompt, esquema, ensamblado y revisión viven juntos en core con la misma versión, y `packages/llm` es solo transporte (cambia "los prompts viven en `packages/llm/prompts/`" de `01-arquitectura.md`).
- **D3 · La IA no elige ni sugiere la portada, y no ve las fotos.** La portada es la del operador (`foto_portada`, o la primera foto). Razones: un modelo que mira fotos tiende a describir lo que ve ("piscina", "vista al parque"), que no está en los datos; `media` no recuerda si la portada fue elegida a mano, así que una sugerencia aplicada se perdería al reimportar; y ahorra cuota del plan. La sugerencia con visión queda en el backlog.
- **D4 · Una corrida por aviso con etapas** (`content.prepare`), en vez de jobs separados de medios y contenido: un solo avance que mirar, y las etapas idempotentes hacen que un reintento no repita trabajo.
- **D5 · Reel con fondo desenfocado** para videos que no son verticales (recortar al centro corta media habitación), y el texto de los primeros 2 s como PNG de la misma plantilla (sin depender de las fuentes de ffmpeg).
- **D6 · CI con ffmpeg y Chromium.** Los adaptadores de `packages/media` se prueban de verdad, con fotos generadas por sharp y videos por ffmpeg (`testsrc`), sin archivos de clientes (excepción a "msw para lo externo", que se anota en `05-convenciones.md`). La CI instala el Chromium de Playwright (con caché) y un ffmpeg 8.1 o más nuevo: el de Ubuntu 24.04 (6.1) no arma los HEIC en mosaicos, así que se usa un build estático de la misma rama probada en local (9.0.x), fijado por versión y verificado con sha256 (T07). El mínimo de 8.1 sale del changelog de ffmpeg; solo se probó la 9.0.1.
- **D7 · Mínimos y máximos** como columnas de `field_definitions`, no dentro de `options`: son de los campos numéricos y el validador los lee directo.
- **D8 · Google Sheets y Drive** (pregunta abierta de F1): no hacen falta antes de F3. Durante el piloto basta con Excel y zip, y la exportación de Sheets a xlsx se importó sin problemas en la demo 3 de F1. Pasan al backlog post-MVP.
- **D9 · Título de Portal sin abreviaturas y con la operación** (`Departamento en venta 3 dormitorios 2 baños en Ñuñoa`, no `3D 2B`), de hasta 60 caracteres: operación, tipo, dormitorios y comuna es lo que recomendaría Mercado Libre para inmuebles (por confirmar en F4).

### 4.11 Dependencias nuevas (se justifican en el PR de su tarea)
- `sharp` (T07, `packages/media`): imágenes. Está en el stack.
- `playwright` (T09, `packages/media`): render de plantillas. Está en el stack. Versión fijada; el Chromium se instala aparte.
- `@fontsource/inter` (T09, `packages/templates`): la tipografía Inter (OFL) como archivos `woff2` versionados en el lockfile, en vez de copiarlos al repo.
- ffmpeg y ffprobe son programas del sistema, no paquetes.
- Sin SDK de Anthropic en F2.
- La tabla de stack de `05-convenciones.md` se actualiza en cada tarea.

## 5. Tareas

### F2-T01 · Mínimos y máximos en campos numéricos
- **Depende de:** F1
- **Descripción:** migración y seed (§4.3, D7); `FieldDefinition` con `minValue` y `maxValue`; el validador rechaza fuera de rango (`FIELD_NUMBER_INVALID`) y da `FIELD_CONFIG_INVALID` si `min > max` o el campo no es `number`. Actualiza `02-modelo-datos.md` y la deuda de `ESTADO.md`.
- **Hecho cuando:**
  - [x] Tests del validador: bajo el mínimo, sobre el máximo, en el borde, sin rango y un rango del corredor que sobrescribe el global
  - [x] Tests con PGlite de la migración y del seed idempotente con los rangos
  - [x] Demo: `pnpm db:migrate` y `pnpm db:seed` en Neon; una copia de la planilla con `dormitorios = -2` falla en esa fila
- **Hecho en:** migración `0003_f2_rangos_campos` (`numeric` en modo número, sin conversión de texto). La demo (2026-10-03) aplicó la migración en Neon, corrió el seed dos veces (36 definiciones) e importó en `--dry-run` una copia exportada de Google Sheets con P001 en `dormitorios = -2`: la fila 3 sale con "debe estar entre 0 y 50" y las otras dos quedan sin cambios (las muestras están dentro de los rangos).

### F2-T02 · Datos de contenido: corridas y contenidos
- **Depende de:** T01 (orden de las migraciones)
- **Descripción:** migración de contenido (§4.3, ADR-0012); entidades `contentRun` y `content` con `CONTENT_RUN_STATUSES`; puertos `ContentRunRepository` (`create`, `get`, `findActive`, `latest`, `listQueued`, `markRunning`, `setStage`, `markSucceeded` condicional junto con las filas de `contents`, `markFailed`, `failAbandoned`) y `ContentRepository` (`listCurrent(listingId)`, `get`, `update`), con dobles en memoria e implementaciones Drizzle; `content.prepare` en `JOB_NAMES` y `JOB_PAYLOADS`.
- **Hecho cuando:**
  - [x] Tests con PGlite y en memoria con los mismos fixtures: una sola corrida activa por aviso (el segundo `create` es `CONTENT_RUN_CONFLICT`), contenido vigente = el más reciente por canal, `markSucceeded` guarda filas y estado juntos (rollback probado) y no cambia una corrida que no está en `running`, `failAbandoned` cierra las `running` viejas y no toca las `queued`, y `listQueued` las devuelve para reencolarlas (§4.4)
  - [x] `pnpm db:generate` sin cambios después de commitear la migración
- **Hecho en:** migración `0004_f2_contenido` (aplicada en Neon). El criterio decía que `failAbandoned` cerraba también las `queued` viejas: quedó como en §4.4 desde la revisión del PR #31 (las `queued` se reencolan con `listQueued`). `contentRunReportSchema` tiene una sección opcional por etapa; T10 la completa si hace falta. `ContentRepository.update` fija `updated_at` con la hora de la base también sin otros cambios. El doble en memoria es uno solo para las dos tablas (`createInMemoryContentRepositories`), porque `markSucceeded` escribe en ambas. Desde la revisión: una fila corrupta es `CONTENT_RUN_ROW_INVALID` o `CONTENT_ROW_INVALID` (500, por la regla `*_ROW_INVALID`); un canal repetido en la entrada de `markSucceeded` es `CONTENT_PLATFORM_DUPLICATED`, no reintentable (`checkNewContents`); `update` aplica solo los campos de `ContentChanges` (`pickContentChanges`); `llmProvider` es de `LLM_PROVIDERS`; una salida de la IA ausente se guarda como `null` de JSON; y `editContent` (T12) suma `CONTENT_RUN_ACTIVE`.

### F2-T03 · Medios derivados en la base y `getStream`
- **Depende de:** T02 (orden de las migraciones)
- **Descripción:** migración de medios (§4.3); `MEDIA_VARIANTS` y `mediaSchema` en core; `MediaRepository.listByListing`, `updateMeasurements`, `upsertDerivative` y `deleteDerivative` (§4.2); el doble en memoria modela `role`. `MediaStorage.getStream` en el puerto y en R2. Actualiza "Contrato de almacenamiento" y "Proyecciones" en `01-arquitectura.md`, y el seguimiento de ADR-0011.
- **Hecho cuando:**
  - [x] Tests con PGlite y en memoria: un derivado vigente por original y variante, reemplazo que devuelve la clave anterior, un render por aviso y variante, y los métodos de F1 sin derivados
  - [x] Tests con msw de `getStream` (contenido, `STORAGE_NOT_FOUND` y `STORAGE_UNAVAILABLE`); `pnpm storage:check` lo prueba contra R2
- **Hecho en:** migración `0005_f2_medios_derivados` (aplicada en Neon). Desde la revisión: `get(id)` y `listVariants` (para el logo de la portada en T10 y las miniaturas de la lista en T12), el padre debe ser del mismo corredor y el tipo calzar con la variante, el aviso de un render debe existir (`MEDIA_NOT_FOUND`), un vigente borrado mientras se reemplazaba es `MEDIA_CONFLICT`, `getStream` acepta `signal` y libera la conexión también sin haber leído (`streamFromBody`), R2 sin cuerpo es `STORAGE_UNAVAILABLE`, y `AbortSignalLike` en core. `upsertDerivative` valida el derivado (`checkDerivative`: `MEDIA_DERIVATIVE_INVALID`) y que el padre sea un original del mismo aviso (`MEDIA_NOT_FOUND`), y en Postgres bloquea el original o el aviso para que dos intentos solapados reemplacen de a uno. `deleteDerivative` devuelve la clave borrada (o `null`) y nunca borra un original. Una fila de `media` que no calza con `mediaSchema` es `MEDIA_ROW_INVALID` (500). `duration_s` se lee como número (modo `number` de Drizzle, sin cambio de SQL). `getStream` convierte un corte a mitad de la lectura en `STORAGE_UNAVAILABLE` (`readBody`); msw entrega el cuerpo de una vez, así que la lectura en varios trozos la prueba `storage:check` contra R2 (1 MB en 66 trozos, mismo sha256). El doble en memoria guarda filas completas con `role` y suma `allMedia()`.

### F2-T04 · Proveedor de IA (`packages/llm`)
- **Depende de:** F1
- **Descripción:** puerto `LLMProvider` en core (§4.5); paquete `packages/llm` con `claude-cli`, `fake` y el stub `anthropic-api`; `CLAUDE_CLI_PATH`, `LLM_TIMEOUT_SECONDS` y la exigencia de `ANTHROPIC_API_KEY`; `doctor` con `claude auth status`. Override de Biome. **Guardia en `vitest.config.ts`:** `CLAUDE_CLI_PATH` apunta a un ejecutable que siempre falla, así un test que olvide el ejecutable falso no puede llamar a la CLI real. El resultado de la prueba de humo va a la nota de integración y al seguimiento de ADR-0003. Actualiza `07-checklist-cuentas.md` y `08-guia-operador.md`.
- **Hecho cuando:**
  - [x] Tests de `claude-cli` con un ejecutable falso (un script de Node que imita el sobre de la CLI): éxito, `error_max_structured_output_retries`, `max_tokens`, sin sesión, límite de uso, error del modelo, proceso que muere, tope de tiempo y `AbortSignal` (en los dos últimos, el proceso queda terminado)
  - [x] Test: el proceso hijo recibe solo las variables permitidas (nunca `DATABASE_URL`, `R2_*`, `APP_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY` ni `ANTHROPIC_AUTH_TOKEN`), corre en un directorio vacío fuera del repo (ningún directorio padre tiene un `CLAUDE.md`), recibe el prompt por stdin y lleva `--safe-mode` y `--tools ""`
  - [x] Tests del entorno (`anthropic-api` sin clave falla al arrancar) y del stub
  - [x] Ningún test ejecuta la CLI real de Claude
  - [x] Demo: prueba de humo con la CLI real y un aviso inventado (salida válida), que también confirma `--max-turns` y el comportamiento de `--tools ""` con `--json-schema`; el sobre real queda como fixture, sin datos de clientes. **Parcial (2026-10-03):** `pnpm llm:smoke` desde la sesión de desarrollo, aislada del llavero del operador, fijó el sobre real de una sesión vencida (ahora `LLM_AUTH_REQUIRED`, y caso del ejecutable falso) y confirmó que `--max-turns` no existe; la llamada exitosa la corre el operador en su terminal (`docs/07-checklist-cuentas.md`). **Completa (2026-10-03):** el operador la corrió con su sesión: salida estructurada correcta con `--tools ""` y `--json-schema` (2 turnos y un modelo auxiliar en `modelUsage`), guardada como el caso `exito-real` del ejecutable falso
- **Hecho en:** `packages/llm` con `createLlmProvider` (`claude-cli`, `fake` y el stub `anthropic-api`), `createInMemoryLlmProvider` en `@agentsales/core/testing` y `AbortSignalLike` en core. El adaptador corre la CLI en su propio grupo de procesos (SIGINT, SIGTERM y SIGKILL) y suma `LLM_ABORTED`; una salida de más de 10 MB es `LLM_OUTPUT_INVALID`; una CLI que no existe es `LLM_NOT_CONFIGURED`. `doctor` muestra si la CLI tiene sesión (`claude auth status --json`, que sale con código 1 sin sesión). Guardia en `vitest.config.ts` (`CLAUDE_CLI_PATH` a un ejecutable inexistente). `pnpm llm:smoke` guarda el sobre en `tmp/llm-smoke/`.

### F2-T05 · Contenido en core: brief, prompt, esquema y ensamblado
- **Depende de:** T04 (puerto)
- **Descripción:** `src/content/` en core (§4.6, ADR-0013): `buildContentBrief` (con el filtro de `fields` movido desde la API), prompt `listing-content-v1`, `contentDraftSchema` y su forma sin topes para el JSON Schema, `generateContentDraft` y `assembleContents`; `SAMPLE_CONTENT_DRAFT`, un borrador de ejemplo válido y exportado desde el índice de core, que usan el proveedor `fake` del worker (T11) y `eval:content --provider fake` (T16), con un test que lo valida contra el esquema (y contra `checkContent` en T06). Revisa `04-formato-publicaciones.md` contra lo implementado.
- **Hecho cuando:**
  - [x] Tests del brief: sin notas internas, sin `_extra`, sin links ni contacto, sin dirección con `show_exact_address = false` y con ella si es `true`
  - [x] Test: el JSON Schema enviado no lleva largos y el esquema estricto sí los aplica
  - [x] Tests del ensamblado por canal con avisos inventados (venta en UF, arriendo en pesos con gastos comunes, sin estacionamientos, sin WhatsApp), del recorte a 2.200 caracteres y del título de Portal (sobre 60 caracteres, 1 dormitorio, 0 dormitorios)
  - [x] Test con datos hostiles: un texto del Excel con instrucciones o con el delimitador del bloque queda escapado dentro de los datos
  - [x] Test del reintento con el proveedor falso: la segunda petición lleva el error de validación; dos fallas → `LLM_OUTPUT_INVALID`
- **Hecho en:** `packages/core/src/content/` con `buildContentBrief`, `buildContentPrompt` (`listing-content-v1`; `<`, `>` y `&` escapados dentro de `<datos_del_aviso>`), `contentDraftSchema` (estricto, con topes) y `CONTENT_DRAFT_JSON_SCHEMA` (draft-07 sin topes), `generateContentDraft`, `assembleContents` (con `listingTitle`, `instagramCaption`, `normalizeHashtag` y `stripEmoji`) y `SAMPLE_CONTENT_DRAFT`. `listingFields` en core, que usa el detalle de la API (deuda de F1). Datos inventados para los tests en `@agentsales/core/testing` (`contentListingFixture`, `contentDefinitionsFixture` y `contentBrokerFixture`). `04-formato-publicaciones.md` describe el ensamblado tal como quedó.

### F2-T06 · Revisión editorial (`checkContent`)
- **Depende de:** T05
- **Descripción:** `checkContent` con la tabla de §4.6 y su contexto privado; listas de superlativos, amenities y términos discriminatorios en core. Reusa lo de T05: `instagramCaption` para `TOO_LONG` y `HASHTAG_COUNT` (el cuerpo no trae los hashtags), `hasEmoji` para `EMOJI_NOT_ALLOWED`, y `LISTING_TITLE_MAX_LENGTH`, `INSTAGRAM_CAPTION_MAX_LENGTH`, `HASHTAGS_MIN` y `HASHTAGS_MAX`.
- **Hecho cuando:**
  - [ ] Tests de cada código, en positivo y en negativo (también con tildes, mayúsculas y números con formato chileno: `5.800`, `72,5`)
  - [ ] Test: un contenido ensamblado desde un borrador limpio no tiene errores

### F2-T07 · Procesamiento de imágenes (`packages/media`)
- **Depende de:** T03
- **Descripción:** puerto `MediaProcessor` completo en core (también `processVideo`, que implementa T08); paquete `packages/media` con `processImage` (§4.2): medidas, rotación EXIF, borrado de metadatos, sRGB, HEIC → JPEG con ffmpeg, variantes `thumb`, `ig_4x5` y `pi_4x3` con su sha256, advertencias de foto chica, `MEDIA_DECODE_FAILED` y `MEDIA_TOOL_NOT_INSTALLED`. `FFPROBE_PATH` y `doctor` con ffmpeg 8.1 y ffprobe. Actualiza `08-guia-operador.md`. La CI instala ffmpeg 8.1 o más nuevo (D6). Override de Biome y excepción de tests de `05-convenciones.md`.
- **Hecho cuando:**
  - [ ] Tests con fotos generadas por sharp: tamaño y proporción de cada variante, rotación EXIF aplicada, sin EXIF ni GPS en la salida, sha256 correcto, foto chica con advertencia y archivo corrupto
  - [ ] Test con un HEIC de prueba en mosaicos que sale en JPEG completo y con la orientación correcta. El archivo es sintético: un JPEG generado con sharp (sin personas) convertido una sola vez con `sips -s format heic` de macOS, que codifica en mosaicos las imágenes grandes (verificado en local: una imagen sintética de 1600×1200 sale como `Tile Grid` de 73 KB); de menos de 300 KB, en `test/fixtures/` y anotado en `05-convenciones.md`. La tarea verifica con ffprobe que trae el grupo `Tile Grid`
  - [ ] La CI pasa con el paso de ffmpeg

### F2-T08 · Procesamiento de video (`packages/media`)
- **Depende de:** T07
- **Descripción:** `processVideo` con ffprobe y ffmpeg (§4.2, D5): medidas y rotación, `thumb` y reel 1080×1920 con fondo desenfocado, tope de 90 s, mínimo de 3 s y el PNG del texto encima durante 2 s; temporales en el directorio del intento y `AbortSignal`. Un video sin audio recibe una pista AAC silenciosa.
- **Hecho cuando:**
  - [ ] Tests con videos generados por ffmpeg (`testsrc`: horizontal, vertical, sin audio, de 100 s y de 2 s): duración y medidas; reel de 1080×1920 en H.264 4:2:0 con audio, `moov` al inicio, sin edit lists, GOP cerrado y bitrate bajo 25 Mbps (todo leído con ffprobe), cortado a 90 s; el de 2 s sin reel
  - [ ] Tests: un `FFMPEG_PATH` inexistente → `MEDIA_TOOL_NOT_INSTALLED`; abortar corta ffmpeg

### F2-T09 · Plantillas y render
- **Depende de:** T07
- **Descripción:** puertos `SlideTemplates` y `HtmlRenderer` con los tipos de datos en core; `packages/templates` (`cover`, `specSheet` y `reelOverlay`, Inter e íconos SVG); `createHtmlRenderer` con Playwright en `packages/media` (red bloqueada, tope de 30 s, Chromium compartido, `RENDER_BROWSER_NOT_INSTALLED`). La CI instala Chromium (D6). `doctor` revisa la versión de Chromium. Override de Biome y seguimiento en ADR-0010 (`import.meta.resolve` de la fuente; si no funciona dentro de Vitest, `createRequire(import.meta.url).resolve`). Actualiza `08-guia-operador.md`.
- **Hecho cuando:**
  - [ ] Tests de HTML: datos escapados, sin dirección, íconos solo de los datos que existen, colores del corredor, venta y arriendo
  - [ ] Tests del render: JPEG de 1080×1350 y PNG transparente de 1080×1920; una plantilla que pide una URL externa no la carga
  - [ ] Imágenes de muestra con datos inventados adjuntas al PR para revisar el diseño

### F2-T10 · Caso de uso `prepareContent`
- **Depende de:** T02, T03, T06, T07 (puerto), T09 (puertos)
- **Descripción:** `requestContentRun` y `prepareContent` (§4.4) con dobles de todos los puertos; `composeCarousel` y `composePhotoSet`; claves de R2 de derivados, reel y renders; completa `contentRunReportSchema` (existe desde T02) si hace falta.
- **Hecho cuando:**
  - [ ] Tests: corrida completa con el proveedor falso (variantes, renders, reel y 3 contenidos); segunda corrida sin cambios (nada se procesa ni se sube, solo la IA); `texts = false` (sin IA y con el contenido anterior vigente); cambio de versión del procesador (regenera y borra lo anterior); cambio de precio (rehace la portada, la ficha y el reel); cambio del primer video (borra el reel anterior)
  - [ ] Tests de errores: medio ilegible (advertencia), ninguna foto procesable (`CONTENT_NO_PHOTOS`), sin sesión de la IA (`failed` con su mensaje), error reintentable que sube, último intento que deja `failed`, intento solapado que termina `skipped` y corrida ya terminal que no se toca
  - [ ] Tests de `requestContentRun`: aviso no listo, corrida activa devuelta (y reencolada si está `queued`), carrera con `CONTENT_RUN_CONFLICT`, contenido editado sin y con `replaceEdits`, y cola caída

### F2-T11 · Job `content.prepare` en el worker
- **Depende de:** T04, T08, T09, T10
- **Descripción:** `defineJob` con la política de §4.4; composición en `worker.ts` (R2, base, procesador y temporales por intento, plantillas, renderizador con cierre al apagar, proveedor de IA según `LLM_PROVIDER` y `AbortSignal` de apagado); corridas abandonadas y limpieza de temporales al arrancar. Seguimiento en ADR-0005 y tabla de colas de `01-arquitectura.md`. **Apagado:** en SIGINT o SIGTERM, el worker dispara el `AbortController` de los handlers, espera a que pg-boss los detenga con gracia y recién después sale (la CLI de Claude corre en su propio grupo de procesos y no recibe el Ctrl+C). Con `LLM_PROVIDER=fake`, el proveedor recibe `SAMPLE_CONTENT_DRAFT`.
- **Hecho cuando:**
  - [ ] Tests del handler (como `import-run.test.ts`): datos inválidos, error no reintentable, último intento y temporales borrados también si falla
  - [ ] Test de arranque: cierra las `running` abandonadas, reencola las `queued` y borra temporales viejos
  - [ ] Test de apagado: dispara el `signal` y espera al handler; un corte en el último intento no deja la corrida en `failed`
  - [ ] Demo: con `pnpm dev`, una corrida de P001 encolada a mano termina `succeeded` en Neon y R2

### F2-T12 · API de contenido
- **Depende de:** T10
- **Descripción:** `getListingContent` y `editContent` en core; rutas de §4.7 con sus contratos; `LISTING_NOT_READY`, `CONTENT_EDITED`, `CONTENT_NOT_CURRENT` y `CONTENT_RUN_ACTIVE` → 409; `thumbUrl` y medidas en `GET /listings/:id`, y portada `thumb` en `GET /listings`.
- **Hecho cuando:**
  - [ ] Tests de los casos de uso: contenido vigente con su revisión y medios, editar el vigente (`edited`), uno viejo (`CONTENT_NOT_CURRENT`) y con una corrida de textos activa (`CONTENT_RUN_ACTIVE`; con una de solo imágenes sí se puede)
  - [ ] Tests de rutas con `testDeps`: pedir (nueva, reusada, aviso no listo, contenido editado, cola caída), consultar la corrida, contenido con `checks` y URLs firmadas, editar (cuerpo inválido, id inexistente)

### F2-T13 · CLI `prepare` y `content`
- **Depende de:** T12
- **Descripción:** comandos de §4.7; `IMPORT_WAIT` pasa a `RUN_WAIT` en core y se comparte (toca también `apps/web/src/queries/imports.ts`, `apps/web/src/pages/ImportRunPage.tsx` y la espera de `import` en la CLI); `PLATFORM_SHORT_NAMES`. Actualiza `CLAUDE.md` y `08-guia-operador.md`.
- **Hecho cuando:**
  - [ ] Tests contra la API en proceso con reloj falso: espera con etapas, aviso de cola, corrida reusada, `--no-wait`, `--no-texts`, textos editados sin y con `--replace-edits`, corrida fallida (código ≠ 0 y mensaje) y `content` con y sin `--platform` y `--json`

### F2-T14 · Panel: preparar y vista previa
- **Depende de:** T13 (`RUN_WAIT`)
- **Descripción:** sección Contenido del detalle (§4.7): botones, avance por etapa con sondeo, error, pestañas por canal con carrusel, caption, reel, fotos 4:3 y textos; la revisión editorial; `thumbUrl` en la galería y la lista.
- **Hecho cuando:**
  - [ ] Tests de componentes con el arnés: sin contenido, corrida en curso que termina, corrida fallida, cada pestaña con sus textos y medios, y revisión con error y advertencia

### F2-T15 · Panel: edición de textos
- **Depende de:** T14
- **Descripción:** editar título, cuerpo y hashtags de cada canal, con contador de caracteres (en Instagram cuenta el caption con los hashtags, `instagramCaption`), guardar (`edited`), revisión actualizada y aviso al regenerar textos sobre un contenido editado ("se reemplazará tu edición"), que al confirmar envía `replaceEdits`.
- **Hecho cuando:**
  - [ ] Tests: editar y guardar, error al guardar, `CONTENT_NOT_CURRENT`, `CONTENT_RUN_ACTIVE` (edición bloqueada mientras se regeneran los textos, con el motivo), contador sobre el tope y la confirmación al regenerar

### F2-T16 · `pnpm eval:content`
- **Depende de:** T06, T11
- **Descripción:** `evaluateListingContent` en core (brief → IA → ensamblado → revisión, sin escribir) y un script delgado en el worker (`apps/worker/src/scripts/eval-content.ts`) que lee de Neon los avisos `ready` de un corredor (`--broker`, default `agentsales-pruebas`) y usa el proveedor configurado (o `--provider fake`). Imprime por aviso y canal los errores y advertencias, deja los textos en `tmp/eval/` (fuera de git) y sale con código 1 si hay algún error. Actualiza `CLAUDE.md`.
- **Hecho cuando:**
  - [ ] Tests con el proveedor falso y repositorios en memoria: un borrador limpio sale 0, uno con un número inventado sale 1
  - [ ] Demo: `pnpm eval:content` con `claude-cli` sobre las 3 muestras, sin errores. El brief de las muestras va a Anthropic a través del plan del operador, sin dirección ni notas internas (es lo mismo que hace una corrida normal), y los textos quedan solo en `tmp/eval/`

### F2-T17 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 2`.
- **Hecho cuando:**
  - [ ] Demos del plan de demo (§7) con las 3 propiedades de muestra
  - [ ] Criterios de §6 verificados con evidencia
  - [ ] Auditoría de coherencia docs-código (subagente `arquitecto`) y docs corregidos
  - [ ] `CHANGELOG.md` `[0.2.0]`, spec cerrado y `docs/ESTADO.md` apuntando a F3
  - [ ] Tag `v0.2.0` desde `main`, después del merge del cierre

Orden: T01 → T02 → T03 (migraciones en cadena). T04 en cualquier momento; T05 → T06 después de T04. T07 después de T03, y luego T08 y T09. T10 cuando estén T02, T03, T06, T07 y T09. Luego T11 → T12 → T13 → T14 → T15, y T16 después de T11. Al final, T17.

## 6. Criterios de aceptación de la fase
- [ ] Las 3 propiedades de muestra tienen contenido preparado y visible en el panel: carrusel con portada y ficha, caption, fotos 4:3, textos de Portal y Marketplace, y el reel de P002. El operador lo aprobaría sin cambios mayores (ADR-0012: listo para revisar, sin publicaciones).
- [ ] `pnpm eval:content` sobre las 3 muestras termina sin errores editoriales.
- [ ] Repetir la preparación no duplica medios ni vuelve a subir lo que no cambió.
- [ ] Una edición manual en el panel se guarda y la revisión editorial se actualiza.
- [ ] Ninguna variante publicable conserva la ubicación GPS de la foto.
- [ ] Ningún test llama a Anthropic ni ejecuta la CLI de Claude; `pnpm check` en verde.

## 7. Plan de demo
1. `pnpm dev`; en otra terminal, `pnpm -s cli prepare P001` → termina con el resumen y sin errores editoriales.
2. `pnpm -s cli prepare P001 --no-texts` → no procesa ni sube nada nuevo.
3. Panel → P001 → Contenido: carrusel (portada, fotos y ficha), caption, Portal y Marketplace.
4. P002: preparar desde el panel y ver el reel con el texto de los primeros 2 s.
5. Editar el caption de P003 en el panel → queda "editado" y la revisión se actualiza.
6. `pnpm eval:content` → las 3 sin errores; leer los textos en `tmp/eval/`.
7. Con el worker apagado, preparar P001 → el aviso de "sigue en cola" a los 20 s.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| La IA inventa datos | Textos híbridos (D2), brief sin dirección ni notas, revisión editorial, `eval:content` y revisión humana antes de aprobar (F3) |
| Datos del Excel que parecen órdenes para la IA | Los datos van en un bloque delimitado con la instrucción de tratarlos como datos; la IA no tiene herramientas, y el ensamblado y la revisión no dependen de ella |
| La CLI de Claude cambia sus opciones o su salida (los textos de error no son un contrato) | Adaptador aislado que valida el sobre con zod, fixture tomado de una prueba de humo, nota de integración fechada, `doctor` y proveedor falso en los tests |
| Límite de uso del plan Max | Una llamada por corrida, salidas cortas (D2), "Rehacer imágenes" sin IA, sin reintentos de `LLM_RATE_LIMITED` ni de `LLM_OUTPUT_INVALID`, y mensaje claro |
| La CLI usa `ANTHROPIC_API_KEY` y cobra por API, o lee el `CLAUDE.md` y los hooks | Entorno mínimo sin claves, `--safe-mode` y directorio de trabajo vacío (§4.5), con test |
| Procesos `claude` o ffmpeg huérfanos al apagar el worker | `AbortSignal` de apagado hasta los procesos hijos, con test |
| HEIC: sharp no lo decodifica y un ffmpeg viejo saca solo un mosaico | ffmpeg 8.1 o más nuevo, exigido por `doctor` y en la CI, con un test de HEIC en mosaicos (T07) |
| Chromium de Playwright distinto del instalado | Versión de Playwright fijada, `doctor` la revisa y `RENDER_BROWSER_NOT_INSTALLED` con el comando para instalarlo |
| Una corrida queda en `queued` sin job | Pedirla de nuevo la reencola, y el worker reencola todas las `queued` al arrancar; una corrida terminal nunca se reprocesa |
| Regenerar textos borra una edición a mano | `CONTENT_EDITED` salvo `replaceEdits` (CLI `--replace-edits`, confirmación en el panel), y `CONTENT_RUN_ACTIVE` mientras una corrida de textos está pendiente |
| Un test llama por error a la CLI real de Claude | Guardia en `vitest.config.ts` (`CLAUDE_CLI_PATH` a un ejecutable que falla) y ejecutable falso en los tests del adaptador |
| La CI se alarga con ffmpeg y Chromium | Caché de los navegadores y build estático de ffmpeg; si pasa de 5 min, se revisa |
| Fotos con la ubicación GPS del corredor | Las variantes salen sin metadatos, con test (§6) |
| R2 se llena (10 GB gratis) | Tres variantes JPEG por foto y un reel por aviso; los derivados viejos se borran al reemplazarse |
| Neon despierto por las corridas | Igual que F1: el worker solo corre en desarrollo |
| Términos de uso de Claude | `claude-cli` solo para el operador (ADR-0003); `anthropic-api` real en F7 |

## 9. Preguntas abiertas
Resueltas con la recomendación del spec, por la aprobación permanente del operador (§4.10):
- [x] ¿Puede la portada que sugiera la IA pisar la `foto_portada` del operador? **No**, y en F2 la IA no sugiere portada (D3).
- [x] ¿Cómo queda el contenido sin cuenta conectada? Solo `contents` y corridas; publicaciones en F3 (D1, ADR-0012).
- [x] ¿Google Sheets y Drive antes de F3? **No**; backlog post-MVP (D8).
- [x] ¿Se suman mínimos y máximos a los campos numéricos? **Sí**, en T01 (D7).

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-02 | Borrador inicial (`/fase-plan 2`), con las notas de integración de F2 (CLI de Claude, API de Anthropic, HEIC, Instagram y Mercado Libre) y verificaciones locales (opciones de la CLI 2.1.243 y HEIC en mosaicos con ffmpeg 9.0.1) |
| 2026-10-02 | Revisión del subagente `arquitecto`: puertos `SlideTemplates` y `HtmlRenderer` en core (las plantillas no tenían dueño); `MediaProcessor` maneja sus temporales y devuelve el sha256 de cada salida (core no toca archivos); clave del reel con el hash de su texto; `checkContent` con contexto privado; migraciones en cadena T01 → T02 → T03; una corrida `queued` se reencola al pedirla y la carrera de `create` devuelve la activa; `jsonSchema` sin topes y validación en core; `max_tokens`, `refusal` y `error_max_turns` como `LLM_OUTPUT_INVALID`; `getListingContent` y `editContent` en core (`CONTENT_NOT_CURRENT`); portada desde la variante `ig_4x5`; cierre condicional y `AbortSignal`; `mediaSchema`; `FIELD_NUMBER_INVALID`; errores `*_NOT_INSTALLED` y `CONTENT_NO_PHOTOS`; índices; `content_runs` sin `broker_id`; la revisión editorial pasa a su propia tarea (T06) y el cierre a T17 |
| 2026-10-02 | Spec **aprobado** (aprobación permanente del operador): decisiones D1–D9 con la recomendación del spec. ADR-0012 y ADR-0013 aceptados; seguimientos en ADR-0003 y ADR-0005; `01-arquitectura.md` (flujo 2, estructura y contrato de IA), `04-formato-publicaciones.md`, `06-roadmap.md` y `00-vision.md` actualizados |
| 2026-10-02 | Revisión del PR (#31) con `revisor` y `arquitecto`: el worker reencola las corridas `queued` al arrancar (en vez de fallarlas a las 24 h) y una corrida terminal no se reprocesa (`markRunning` condicional); `CONTENT_EDITED` y `replaceEdits` para no reemplazar ediciones sin avisar; la CLI de Claude corre en un temporal del sistema, fuera del repo; `--max-turns` por confirmar en la prueba de humo; título de Portal con la operación; `VideoOutput.size`, `processVideo` en dos pasadas y sin `dispose`; `sha256` inyectado y `{ bytes, mime, sha256 }` en las plantillas; guardia de Vitest contra la CLI real; tests de datos hostiles, del reel con ffprobe y del HEIC sintético; estacionamientos en el caption; tabla de colas y diagrama de `01-arquitectura.md`, `02-modelo-datos.md`, ADR-0012, ADR-0013 y notas de integración corregidos |
| 2026-10-03 | Desde la revisión de F2-T02: `editContent` responde `CONTENT_RUN_ACTIVE` (409) mientras hay una corrida de textos activa (una corrida en cola no puede pisar una edición sin avisar); la vista HTTP del contenido sin `rawOutput` ni datos del modelo; T10 completa `contentRunReportSchema`, que existe desde T02 |
| 2026-10-03 | Desde la revisión de F2-T03: `MediaRepository.get` y `listVariants` (§4.2 y §4.7); `AbortSignalLike` en core para todos los puertos que cortan trabajo; `MediaMeasurements` e `ImageVariant` en el ejemplo de `MediaProcessor`; la etapa `media` guarda las medidas antes que las variantes y las claves salen de una función pura de core |
| 2026-10-03 | Desde F2-T04: `LLM_ABORTED` (reintentable) en la tabla de errores de la IA; `--max-turns` no existe en la CLI 2.1.243; la prueba de humo es `pnpm llm:smoke` y la llamada exitosa la corre el operador |
| 2026-10-03 | Desde la revisión de F2-T04: `LLM_ABORTED` entre los reintentables de §4.4 y el corte por apagado que no marca `failed`; `SAMPLE_CONTENT_DRAFT` en T05 para el proveedor `fake`; T11 dispara el `signal` y espera antes de salir; `LLM_NOT_CONFIGURED` también para la CLI que falta; clasificación del sobre por campos; `LLM_TIMEOUT_SECONDS` hasta 600 |
| 2026-10-03 | Desde F2-T05 (detalles que el spec no fijaba, en `04-formato-publicaciones.md`): `requisitos_arriendo` va al brief solo en arriendo; los hashtags de Instagram van en `contents.hashtags`, aparte del cuerpo, y el caption que se publica los suma (`instagramCaption`); con menos de 5 se completan con genéricos y sobre 12 salen primero los de la IA; el título de Portal se recorta en una palabra si ni sin dormitorios cabe; Marketplace usa el mismo título que Portal; la descripción de Portal queda sin emojis aunque vengan de la planilla o de la IA (salvo `©`, `®` y `™`); dormitorios y baños en 0 no se muestran en ningún canal, tampoco los baños del título. Desde la revisión del PR (#37): el motivo del reintento usa textos fijos por tipo de problema (nunca claves ni valores que inventó la IA); el título se recorta en palabras enteras y sin terminar en `de`, `la` o `en`; `editContent` normaliza los hashtags (§4.6); T06 y T15 miden el caption con `instagramCaption`; los campos propios de un corredor llegan a la IA (deuda anotada para F7) |
