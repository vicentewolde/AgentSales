// Contratos HTTP compartidos (ADR-0011): la API valida su entrada y tipa sus respuestas con estos
// esquemas, y la CLI y el panel validan con los mismos lo que reciben. Es lo único de la API que
// el panel importa en tiempo de ejecución: Biome limita este directorio a `zod`, `@agentsales/core`
// e imports relativos (nada de Node ni de `@agentsales/config`).
import {
  AGENDA_ACTIONS,
  AGENDA_KINDS,
  BRAND_TEXT_MAX,
  BROKER_KINDS,
  brokerSchema,
  CALENDAR_ENTRY_KINDS,
  CALENDAR_MAX_RANGE_MS,
  CLOSE_REASONS,
  CONTENT_CHECK_CODES,
  CONTENT_CHECK_SEVERITY_LEVELS,
  CONTENT_STATUSES,
  contentRunReportSchema,
  contentRunSchema,
  EDITORIAL_LIMITS,
  editorialProfileSchema,
  FIELD_TYPES,
  IMPORT_UPLOAD,
  importRunSchema,
  LANGUAGES,
  LISTING_ACTIONS,
  LISTING_PLATFORMS,
  LISTING_STATUSES,
  listingSchema,
  MAX_SCHEDULE_BATCH,
  MAX_SCHEDULE_SPACING_MINUTES,
  MAX_XLSX_BYTES,
  MEDIA_KINDS,
  MEDIA_VARIANTS,
  MUSIC_LICENSES,
  MUSIC_STYLES,
  MUSIC_TRACK_IDS,
  musicTrackIdSchema,
  ONBOARDING_STEPS,
  OPERATIONS,
  PLAN_RUN_STATUSES,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  POST_IMAGE_LIMITS,
  POST_KINDS,
  POST_LIMITS,
  POST_PLATFORMS,
  POST_STATUSES,
  POST_UPLOAD,
  PROCESSED_MEDIA_VARIANTS,
  PUBLICATION_ACTORS,
  PUBLICATION_EVENT_TYPES,
  PUBLICATION_FORMATS,
  PUBLICATION_RESOLUTIONS,
  PUBLICATION_STATUSES,
  postImageRequestSchema,
  postImageRunSchema,
  postSchema,
  publicationErrorSchema,
  remoteStateSchema,
  SCHEDULE_STATES,
  SESSION_CLIENTS,
  TOKEN_EXPIRED_REASONS,
  TOKEN_REFRESH_SKIP_REASONS,
  TONE_MAX,
  USER_ROLES,
} from "@agentsales/core";
import { z } from "zod";

/**
 * Lo que le falta a un aviso para un canal (`portalReadiness`, spec F4 §4.5; `marketplaceReadiness`,
 * spec F5 §4.6): el código, el campo del Excel que hay que completar (`null` si no es del aviso,
 * como el WhatsApp del corredor o las fotos) y el motivo en español, sin datos del aviso.
 */
export const readinessIssueSchema = z.object({
  code: z.string(),
  field: z.string().nullable(),
  message: z.string(),
});
export type ReadinessIssueView = z.infer<typeof readinessIssueSchema>;

/** `ready` sin motivos, o los motivos de lo que falta. */
export const readinessSchema = z.object({
  ready: z.boolean(),
  issues: z.array(readinessIssueSchema),
});
export type ReadinessView = z.infer<typeof readinessSchema>;

/** Los nombres de Portal (F4), los mismos esquemas. */
export const portalReadinessIssueSchema = readinessIssueSchema;
export type PortalReadinessIssueView = ReadinessIssueView;
export const portalReadinessSchema = readinessSchema;
export type PortalReadinessView = ReadinessView;

/**
 * Cuerpo de todo error de la API: `code` y `message`, nunca `details` ni `cause`. Las excepciones
 * (seguimiento de ADR-0011), validadas campo por campo:
 * - `issues` en `PORTAL_NOT_READY` (desde F4-T19) y `MARKETPLACE_NOT_READY` (F5-T08): lo que le
 *   falta al aviso, que el panel y la CLI muestran para que el operador complete la planilla;
 * - `publicationId` en `MANUAL_CONFIRM_PENDING` y `MARKETPLACE_FORM_OPEN` (F5-T08): la publicación
 *   de Marketplace con el formulario abierto (esperando el clic final o, solo en
 *   `MARKETPLACE_FORM_OPEN`, todavía llenándose), para ofrecer "lo publiqué" o "no lo publiqué".
 */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(readinessIssueSchema).optional(),
    publicationId: z.uuid().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** `:id` de una ruta: un uuid; otro formato es `REQUEST_INVALID`, no un error de la base. */
export const idParamSchema = z.object({ id: z.uuid() });

/** Filtros de `GET /listings` (todos opcionales y exactos). */
export const listingQuerySchema = z.object({
  status: z.enum(LISTING_STATUSES).optional(),
  operation: z.enum(OPERATIONS).optional(),
  comuna: z.string().trim().min(1).optional(),
  /** `id_propiedad` exacto (la CLI: `agentsales listing <ref>`); se repite entre corredores. */
  externalRef: z.string().trim().min(1).optional(),
  /** Un corredor (su `slug`): filtro del administrador; un corredor que pide otro recibe 404 (F7). */
  broker: z.string().trim().min(1).max(80).optional(),
});
export type ListingQuery = z.infer<typeof listingQuerySchema>;

/**
 * `POST /listings/:id/status` (F6-T10, spec F6 §4.8): la acción, el motivo al cerrar y la
 * confirmación (cerrar siempre; pausar y archivar si cambian algo). Reemplaza al `PATCH` de F1.
 */
export const listingStatusBodySchema = z.object({
  action: z.enum(LISTING_ACTIONS),
  reason: z.enum(CLOSE_REASONS).optional(),
  confirmed: z.boolean().optional(),
});
export type ListingStatusBody = z.infer<typeof listingStatusBodySchema>;

/**
 * `PATCH /listings/:id` (F9.5-T19): la música del reel, un id del catálogo o `null` (sin música).
 * Es lo único de la propiedad que se edita aquí (lo demás viene de la planilla).
 */
export const listingUpdateBodySchema = z
  .object({ musicTrackId: musicTrackIdSchema.nullable() })
  .strict();
export type ListingUpdateBody = z.infer<typeof listingUpdateBodySchema>;

/** Un aviso tal como viaja en JSON: las fechas llegan como texto ISO y se vuelven `Date`. */
export const listingJsonSchema = listingSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/**
 * Un medio original con su URL de lectura temporal (prefirmada). `thumbUrl` es su miniatura JPEG
 * (desde F2-T12; `null` hasta que una corrida la arma): los navegadores no muestran HEIC. Las
 * medidas, ya rotadas, son `null` hasta que la etapa `media` las mide.
 */
export const mediaItemSchema = z.object({
  id: z.string(),
  kind: z.enum(MEDIA_KINDS),
  mime: z.string(),
  bytes: z.number().int(),
  sortOrder: z.number().int(),
  isCover: z.boolean(),
  url: z.string(),
  thumbUrl: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationS: z.number().nullable(),
});
export type MediaItem = z.infer<typeof mediaItemSchema>;

/**
 * Un aviso en la lista (`GET /listings`, spec F7 §4.4): sin notas internas, dirección exacta,
 * unidad ni atributos (el detalle, `GET /listings/:id`, sigue completo dentro del alcance).
 */
export const listingSummarySchema = listingJsonSchema.omit({
  internalNotes: true,
  address: true,
  unitNumber: true,
  attributes: true,
});
export type ListingSummary = z.infer<typeof listingSummarySchema>;

export const listingListResponseSchema = z.object({
  listings: z.array(listingSummarySchema.extend({ coverUrl: z.string().nullable() })),
});
export type ListingListResponse = z.infer<typeof listingListResponseSchema>;

/** Etiqueta de un atributo (`attributes[key]`), de las definiciones efectivas del corredor. */
export const listingFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
});
export type ListingField = z.infer<typeof listingFieldSchema>;

export const listingDetailResponseSchema = z.object({
  listing: listingJsonSchema,
  /** En orden; la portada lleva `isCover`. */
  media: z.array(mediaItemSchema),
  /**
   * Los atributos del aviso que tienen definición, en el orden de las definiciones (ADR-0006: las
   * etiquetas son datos). Los que no la tienen (`_extra`, o un campo ya borrado) no aparecen.
   */
  fields: z.array(listingFieldSchema),
});
export type ListingDetailResponse = z.infer<typeof listingDetailResponseSchema>;

/** `PATCH /listings/:id` (F9.5-T19): la propiedad ya cambiada. */
export const listingResponseSchema = z.object({ listing: listingJsonSchema });
export type ListingResponse = z.infer<typeof listingResponseSchema>;

/**
 * Una pista de la biblioteca de música (`GET /music/tracks`, F9.5-T19): sus datos del catálogo,
 * si el operador ya la subió a R2 (`available`) y, si está, una URL firmada de corta vida para
 * escucharla (`previewUrl`; 10 min). Una pista sin archivo se puede elegir igual: el reel sale sin
 * música, con un aviso, hasta que se suba.
 */
export const musicTrackViewSchema = z.object({
  id: z.enum(MUSIC_TRACK_IDS),
  title: z.string(),
  author: z.string(),
  style: z.enum(MUSIC_STYLES),
  license: z.enum(MUSIC_LICENSES),
  sourceUrl: z.string(),
  available: z.boolean(),
  previewUrl: z.string().nullable(),
});
export type MusicTrackView = z.infer<typeof musicTrackViewSchema>;

export const musicTrackListResponseSchema = z.object({ tracks: z.array(musicTrackViewSchema) });
export type MusicTrackListResponse = z.infer<typeof musicTrackListResponseSchema>;

export const brokerListResponseSchema = z.object({ brokers: z.array(brokerSchema) });
export type BrokerListResponse = z.infer<typeof brokerListResponseSchema>;

/** Extensiones que acepta la subida del panel (la API y el formulario revisan las mismas). */
export const XLSX_EXTENSION = ".xlsx";
export const MEDIA_ZIP_EXTENSION = ".zip";

/** `true` si el nombre del archivo termina en `extension`, sin importar mayúsculas. */
export const hasExtension = (fileName: string, extension: string) =>
  fileName.toLowerCase().endsWith(extension);

/**
 * Un archivo subido. Con el tipo explícito `File` (la interfaz global), y no con `z.instanceof`:
 * ese infiere la clase de `node:buffer` al compilar la API, y `AppType` le pasaría al panel un tipo
 * de Node (docs/01-arquitectura.md, "Tipos alcanzables desde `AppType`").
 */
const fileSchema = z.custom<File>((value) => value instanceof File, "debe ser un archivo");

/** Tope del xlsx subido: el mismo del lector (core). */
export const MAX_XLSX_UPLOAD_BYTES = MAX_XLSX_BYTES;

/**
 * Los archivos de una carpeta del panel o la CLI: el navegador o la CLI calculan el sha256 de los
 * de hasta este tamaño (spec F8 §4.4).
 */
export const UPLOAD_SHA256_UP_TO_BYTES = IMPORT_UPLOAD.sha256UpToBytes;
export const MAX_FOLDER_FILES = IMPORT_UPLOAD.maxFolderFiles;

const uploadName = z.string().min(1).max(300);
const uploadSize = z.number().int().nonnegative();

/**
 * `POST /imports/uploads` (spec F8 §4.4 y §4.14, ADR-0025): la planilla (nombre, tamaño y sha256)
 * y, si hay, los medios: un zip (nombre y tamaño) o los archivos de una carpeta (ruta relativa con
 * `/`, tamaño y sha256 de los de hasta 100 MB). Los topes, las rutas y los nombres los revisa core
 * (`requestImportUpload`); aquí solo la forma, con un techo para el tamaño del pedido.
 */
export const importUploadRequestSchema = z.object({
  broker: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
  xlsx: z.object({ name: uploadName, size: uploadSize, sha256: z.string().max(64) }),
  media: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("zip"), name: uploadName, size: uploadSize }),
      z.object({
        kind: z.literal("folder"),
        name: uploadName,
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(1100),
              size: uploadSize,
              sha256: z.string().max(64).optional(),
            }),
          )
          .max(2 * IMPORT_UPLOAD.maxFolderFiles),
      }),
    ])
    .nullable()
    .optional(),
});
export type ImportUploadRequest = z.infer<typeof importUploadRequestSchema>;

/** Una URL de subida: un `PUT` a `url` con exactamente `headers` y el archivo como cuerpo. */
export const importUploadTargetSchema = z.object({
  kind: z.enum(["xlsx", "zip", "file"]),
  name: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});
export type ImportUploadTargetView = z.infer<typeof importUploadTargetSchema>;

/**
 * Una carga tal como la ve la CLI o el panel: `input` solo con nombres de archivo, nunca las rutas
 * completas (spec F1 §4.4), y las fechas como `Date`.
 */
export const importRunViewSchema = importRunSchema.omit({ input: true }).extend({
  input: z.object({
    xlsxFile: z.string(),
    mediaFile: z.string().nullable(),
    broker: z.string().nullable(),
  }),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ImportRunView = z.infer<typeof importRunViewSchema>;

export const importRunResponseSchema = z.object({ importRun: importRunViewSchema });
export type ImportRunResponse = z.infer<typeof importRunResponseSchema>;

/** `POST /imports/uploads` (201): la carga en `awaiting_upload` y una URL por archivo. */
export const importUploadResponseSchema = z.object({
  importRun: importRunViewSchema,
  uploads: z.array(importUploadTargetSchema),
});
export type ImportUploadResponse = z.infer<typeof importUploadResponseSchema>;

/** En la lista va sin el reporte (puede ser grande): el detalle lo trae completo. */
export const importRunSummarySchema = importRunViewSchema.omit({ report: true });
export type ImportRunSummary = z.infer<typeof importRunSummarySchema>;

export const importRunListResponseSchema = z.object({
  importRuns: z.array(importRunSummarySchema),
});
export type ImportRunListResponse = z.infer<typeof importRunListResponseSchema>;

/** `POST /listings/:id/content-runs` (spec F2 §4.7): `texts` por defecto `true`. */
export const contentRunRequestBodySchema = z.object({
  texts: z.boolean().optional(),
  replaceEdits: z.boolean().optional(),
});
export type ContentRunRequestBody = z.infer<typeof contentRunRequestBodySchema>;

/**
 * El reporte de una corrida tal como sale de la API: la llamada a la IA sin `provider` ni `model`
 * (como la vista del texto, spec F2 §4.7), solo la versión del prompt, los intentos y la duración.
 */
export const contentRunReportViewSchema = contentRunReportSchema.extend({
  llm: contentRunReportSchema.shape.llm.unwrap().omit({ provider: true, model: true }).optional(),
});
export type ContentRunReportView = z.infer<typeof contentRunReportViewSchema>;

/** Una corrida de contenido con sus fechas como `Date` (estado, etapa, reporte y error). */
export const contentRunViewSchema = contentRunSchema.extend({
  report: contentRunReportViewSchema.nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ContentRunView = z.infer<typeof contentRunViewSchema>;

/** `POST /listings/:id/content-runs`: la corrida, y `reused` si ya había una activa del aviso. */
export const contentRunRequestResponseSchema = z.object({
  contentRun: contentRunViewSchema,
  reused: z.boolean(),
});
export type ContentRunRequestResponse = z.infer<typeof contentRunRequestResponseSchema>;

export const contentRunResponseSchema = z.object({ contentRun: contentRunViewSchema });
export type ContentRunResponse = z.infer<typeof contentRunResponseSchema>;

/**
 * Un problema de la revisión editorial. Solo esto sale del servidor: la revisión usa lo privado del
 * aviso (dirección, unidad y notas), y sus mensajes no lo citan.
 */
export const contentCheckSchema = z.object({
  code: z.enum(CONTENT_CHECK_CODES),
  severity: z.enum(CONTENT_CHECK_SEVERITY_LEVELS),
  message: z.string(),
});
export type ContentCheckView = z.infer<typeof contentCheckSchema>;

/**
 * Un texto vigente con su revisión, calculada al leer. Sin `rawOutput`, `llmProvider` ni
 * `llmModel`: solo `promptVersion` (spec F2 §4.7).
 */
export const contentViewSchema = z.object({
  id: z.string(),
  platform: z.enum(PLATFORMS),
  /**
   * El idioma del texto (F9-T12): un post tiene uno por red e idioma; un aviso, siempre `es`. Un
   * servidor anterior no lo manda: se lee como `es`.
   */
  language: z.enum(LANGUAGES).default("es"),
  /** Portal y Marketplace; `null` en Instagram. */
  title: z.string().nullable(),
  body: z.string(),
  /** Solo Instagram; el caption que se publica los suma al cuerpo (`instagramCaption`). */
  hashtags: z.array(z.string()),
  status: z.enum(CONTENT_STATUSES),
  checks: z.array(contentCheckSchema),
  promptVersion: z.string(),
  updatedAt: z.coerce.date(),
});
export type ContentView = z.infer<typeof contentViewSchema>;

/** Un medio de un canal (render, variante o reel) con su URL de lectura temporal. */
export const contentMediaSchema = z.object({
  id: z.string(),
  variant: z.enum(MEDIA_VARIANTS),
  mime: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationS: z.number().nullable(),
  url: z.string(),
});
export type ContentMedia = z.infer<typeof contentMediaSchema>;

/** `GET /listings/:id/content`: lo que se publicaría en cada canal y la última corrida. */
export const listingContentResponseSchema = z.object({
  /** El vigente de cada canal, en el orden de `LISTING_PLATFORMS`; vacío si nunca se generó. */
  contents: z.array(contentViewSchema),
  /** Instagram: portada, fotos y ficha (hasta 10). */
  carousel: z.array(contentMediaSchema),
  /** Portal Inmobiliario y Marketplace: fotos 4:3, la portada primero. */
  photos: z.array(contentMediaSchema),
  reel: contentMediaSchema.nullable(),
  /**
   * Si el reel salió de las fotos (F9.5-T18: la propiedad no tiene video); `false` sin reel. Un
   * servidor anterior no lo manda: vale `false`.
   */
  reelFromPhotos: z.boolean().default(false),
  latestRun: contentRunViewSchema.nullable(),
  /** Lo que le falta al aviso para Portal (la pestaña Portal; desde F4-T19). */
  portalReadiness: portalReadinessSchema,
  /**
   * Lo que le falta al aviso para el formulario de Marketplace (la pestaña Marketplace; F5-T08),
   * con `UF_SOURCE_NOT_CONFIGURED` si el precio está en UF y la API no tiene el token del Banco
   * Central.
   */
  marketplaceReadiness: readinessSchema,
});
export type ListingContentResponse = z.infer<typeof listingContentResponseSchema>;

/**
 * `PATCH /contents/:id`: al menos un campo. Los topes son de la petición (un cuerpo enorme), no
 * editoriales: el largo de cada canal lo informa la revisión (`TOO_LONG`).
 */
export const contentEditBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    hashtags: z.array(z.string().max(200)).max(50).optional(),
  })
  .refine(
    (edit) => edit.title !== undefined || edit.body !== undefined || edit.hashtags !== undefined,
    { message: "manda al menos title, body o hashtags" },
  );
export type ContentEditBody = z.infer<typeof contentEditBodySchema>;

export const contentEditResponseSchema = z.object({ content: contentViewSchema });
export type ContentEditResponse = z.infer<typeof contentEditResponseSchema>;

/**
 * El formulario de Marketplace del intento actual (spec F5 §4.10, `marketplaceManualState` de core),
 * sin el progreso crudo: cuándo quedó listo, si fue una simulación, si la ventana sigue abierta o
 * cuándo se cerró, cuántas fotos se subieron y el precio en pesos con la UF usada (`null` si el
 * aviso estaba en pesos).
 */
export const marketplaceManualSchema = z.object({
  formReadyAt: z.coerce.date(),
  simulated: z.boolean(),
  windowOpen: z.boolean(),
  windowClosedAt: z.coerce.date().nullable(),
  photos: z.number().int().nonnegative(),
  priceClp: z.number().int().nonnegative(),
  ufValue: z.string().nullable(),
  ufDate: z.string().nullable(),
  /** Desde F7 (ADR-0023): lo publica el corredor a mano, sin formulario ni ventana. */
  byHand: z.boolean(),
});
export type MarketplaceManualView = z.infer<typeof marketplaceManualSchema>;

/**
 * Una publicación tal como la ven el panel y la CLI (spec F3 §4.3 y §4.8): sin `progress` (lo que
 * el publisher dejó en la plataforma para retomar, interno) y sin URLs de lo que se envía a la
 * plataforma. `dryRun` es el modo del último intento pedido; `lastError`, el motivo legible.
 */
export const publicationViewSchema = z.object({
  id: z.string(),
  /** El aviso de la publicación; `null` si es de un post (F9-T06, ADR-0029). */
  listingId: z.string().nullable(),
  /**
   * El post de la publicación (F9-T06, ADR-0029); `null` si es de un aviso. Un servidor anterior a
   * F9-T06 no lo manda: se lee como `null` (sus publicaciones son todas de avisos).
   */
  postId: z.string().nullable().default(null),
  platformAccountId: z.string(),
  platform: z.enum(PLATFORMS),
  format: z.enum(PUBLICATION_FORMATS),
  /** El idioma de su texto (F9-T12; un aviso, siempre `es`). Sin él (otro servidor), `es`. */
  language: z.enum(LANGUAGES).default("es"),
  contentId: z.string(),
  mediaIds: z.array(z.string()),
  status: z.enum(PUBLICATION_STATUSES),
  dryRun: z.boolean(),
  /**
   * Ya empezó en vivo en la plataforma (`dryRun: false` con progreso): reintentarla con la API en
   * `dry-run` es `PUBLISH_MODE_LOCKED`. El panel lo usa para explicar por qué no se puede.
   */
  startedLive: z.boolean(),
  attempts: z.number().int().nonnegative(),
  lastError: publicationErrorSchema.nullable(),
  externalUrl: z.string().nullable(),
  scheduledAt: z.coerce.date().nullable(),
  publishedAt: z.coerce.date().nullable(),
  /**
   * Lo último que informó la plataforma (Portal: el estado del ítem, su vencimiento y, si la pausó
   * Mercado Libre, el motivo con texto propio; desde F4-T19). `null` hasta el primer dato y en
   * Instagram.
   */
  remoteState: remoteStateSchema.nullable(),
  /** Solo Marketplace: el formulario del intento actual (F5-T08); `null` en los demás canales. */
  manual: marketplaceManualSchema.nullable(),
  /** La publicación de Portal que esta republica (F6-T07); `null` si no es una republicación. */
  relistedFrom: z.string().nullable(),
  /** Una programada: `upcoming`, `due` u `overdue` (atrasada, F6 §4.4); `null` si no lo está. */
  schedule: z.enum(SCHEDULE_STATES).nullable(),
  /** Qué hacer con el último error (`publicationErrorAdvice`, F6 §4.5); `null` sin error. */
  errorAdvice: z.string().nullable(),
  /** Portal: el vencimiento de su aviso (F6 §4.7); `null` sin dato o en otro canal. */
  expiry: z
    .object({
      stopTime: z.coerce.date(),
      daysLeft: z.number().int(),
      soon: z.boolean(),
      expired: z.boolean(),
    })
    .nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PublicationView = z.infer<typeof publicationViewSchema>;

/** Un formato que no se abrió porque ya tenía una publicación activa de otro texto (`skipped`). */
export const skippedPublicationSchema = z.object({
  platformAccountId: z.string(),
  format: z.enum(PUBLICATION_FORMATS),
  publicationId: z.string(),
});
export type SkippedPublicationView = z.infer<typeof skippedPublicationSchema>;

/**
 * `POST /contents/:id/approve`: el texto con su revisión, las publicaciones que nacieron, los
 * formatos saltados y todas las del canal del aviso.
 */
export const contentApproveResponseSchema = z.object({
  content: contentViewSchema,
  created: z.array(publicationViewSchema),
  skipped: z.array(skippedPublicationSchema),
  publications: z.array(publicationViewSchema),
  /** Solo Portal: lo que le falta al aviso (advertencia: el texto se aprobó igual). */
  portalReadiness: portalReadinessSchema.nullable(),
  /** Solo Marketplace: lo que le falta al aviso (advertencia, como en Portal; F5-T08). */
  marketplaceReadiness: readinessSchema.nullable(),
  /**
   * Solo un post (F9.5-T21): el texto se aprobó, pero faltan los medios que pide la red o se están
   * procesando, así que todavía no hay publicaciones. Opcional: un servidor anterior no lo manda.
   */
  mediaPending: z.boolean().optional(),
});
export type ContentApproveResponse = z.infer<typeof contentApproveResponseSchema>;

/** `POST /contents/:id/unapprove`: el texto (vuelve a `edited`) y las publicaciones descartadas. */
export const contentUnapproveResponseSchema = z.object({
  content: contentViewSchema,
  cancelled: z.array(publicationViewSchema),
  publications: z.array(publicationViewSchema),
});
export type ContentUnapproveResponse = z.infer<typeof contentUnapproveResponseSchema>;

/**
 * Una publicación con sus medios, con URL de lectura temporal (en el reel, el MP4 completo: el panel
 * lo muestra con `<video>` o un ícono).
 */
export const listingPublicationSchema = publicationViewSchema.extend({
  /**
   * Solo en las pendientes (`PENDING_PUBLICATION_STATUSES`), cuyos medios no cambian (D3). En las
   * demás va vacío: una corrida posterior puede haber reemplazado la imagen en el mismo medio, y lo
   * que se envió queda en la bitácora (`publish_attempt.sent`).
   */
  media: z.array(contentMediaSchema),
});
export type ListingPublicationView = z.infer<typeof listingPublicationSchema>;

/**
 * `GET /listings/:id/publications`: todas las del aviso, de todos los canales. Para sondear una sola
 * (sin volver a firmar miniaturas), `GET /publications/:id` (`publicationResponseSchema`).
 */
export const listingPublicationsResponseSchema = z.object({
  publications: z.array(listingPublicationSchema),
});
export type ListingPublicationsResponse = z.infer<typeof listingPublicationsResponseSchema>;

/**
 * `POST /listings/:id/publish`: el canal; el modo lo pone la API (`PUBLISH_MODE`), nunca el cuerpo.
 * Solo los canales de avisos (`LISTING_PLATFORMS`): las redes de F9 son de los posts.
 */
export const listingPublishBodySchema = z.object({ platform: z.enum(LISTING_PLATFORMS) });
export type ListingPublishBody = z.infer<typeof listingPublishBodySchema>;

/**
 * Lo que hizo publicar el canal: las que empezaron, las que ya estaban en curso y se reencolaron,
 * las que nacieron ahora, los formatos saltados, las pendientes de una cuenta desconectada
 * (`stranded`: descartarlas o reconectar) y todas las del canal.
 */
export const listingPublishResponseSchema = z.object({
  started: z.array(publicationViewSchema),
  requeued: z.array(publicationViewSchema),
  created: z.array(publicationViewSchema),
  skipped: z.array(skippedPublicationSchema),
  stranded: z.array(publicationViewSchema),
  publications: z.array(publicationViewSchema),
});
export type ListingPublishResponse = z.infer<typeof listingPublishResponseSchema>;

/** `POST /publications/:id/publish`: `requeued` si ya estaba en curso y solo se volvió a encolar. */
export const publicationPublishResponseSchema = z.object({
  publication: publicationViewSchema,
  requeued: z.boolean(),
});
export type PublicationPublishResponse = z.infer<typeof publicationPublishResponseSchema>;

export const publicationResponseSchema = z.object({ publication: publicationViewSchema });
export type PublicationResponse = z.infer<typeof publicationResponseSchema>;

/** El largo máximo del enlace pegado de un aviso de Marketplace (la API y la CLI). */
export const MARKETPLACE_URL_MAX_LENGTH = 2048;

/**
 * `POST /publications/:id/confirm` (spec F5 §4.3): el enlace del aviso publicado en Marketplace,
 * obligatorio en vivo (en simulación se ignora). Nunca vuelve en un error ni va al log.
 */
export const publicationConfirmBodySchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "falta el enlace")
    .max(MARKETPLACE_URL_MAX_LENGTH, "el enlace es demasiado largo")
    .optional(),
});
export type PublicationConfirmBody = z.infer<typeof publicationConfirmBodySchema>;

/** `changed: false`: ya estaba publicada con ese enlace (confirmar dos veces no cambia nada). */
export const publicationConfirmResponseSchema = z.object({
  publication: publicationViewSchema,
  changed: z.boolean(),
});
export type PublicationConfirmResponse = z.infer<typeof publicationConfirmResponseSchema>;

/**
 * `POST /publications/:id/retire`: en `live`, `removedByHand: true` confirma que se borró a mano en
 * la plataforma (Instagram Login no deja borrar por la API, D8). El cuerpo va siempre (`{}`).
 * F9-T19: `deleteRemote: true` la borra AgentSales por la API (LinkedIn o, desde F9.5-T09, X, con
 * la cuenta en modo `api` y la API en `live`; TikTok se borra a mano en la app, D9); no se junta con
 * `removedByHand`.
 */
export const publicationRetireBodySchema = z
  .object({ removedByHand: z.boolean().optional(), deleteRemote: z.boolean().optional() })
  .refine((body) => !(body.removedByHand === true && body.deleteRemote === true), {
    message:
      "o la borraste a mano (removedByHand) o la borra AgentSales (deleteRemote), no las dos",
  });
export type PublicationRetireBody = z.infer<typeof publicationRetireBodySchema>;

/** `listingBackToReady`: era la última publicada en `live` y el aviso volvió de `active` a `ready`. */
export const publicationRetireResponseSchema = z.object({
  publication: publicationViewSchema,
  listingBackToReady: z.boolean(),
});
export type PublicationRetireResponse = z.infer<typeof publicationRetireResponseSchema>;

/**
 * `POST /publications/:id/close` (Portal, spec F4 §4.9): en `live`, `confirmed: true` confirma que
 * se cierra (es irreversible: volver a publicar crea otro aviso y gasta otro cupo). El cuerpo va
 * siempre (`{}`).
 */
export const publicationCloseBodySchema = z.object({ confirmed: z.boolean().optional() });
export type PublicationCloseBody = z.infer<typeof publicationCloseBodySchema>;

/**
 * `POST /publications/:id/pause`, `/resume` y `/close` (Portal, síncronos): la publicación con su
 * estado en la plataforma y, al cerrar, si era la última en `live` y el aviso volvió a `ready`.
 */
export const publicationOperationResponseSchema = z.object({
  publication: publicationViewSchema,
  listingBackToReady: z.boolean(),
});
export type PublicationOperationResponse = z.infer<typeof publicationOperationResponseSchema>;

/**
 * `POST /publications/:id/sync` (202): `queued` si se encoló una lectura ahora; `false` si ya había
 * una programada (después de publicar, o en reintento), que la va a leer.
 */
export const publicationSyncResponseSchema = z.object({
  publicationId: z.string(),
  queued: z.boolean(),
});
export type PublicationSyncResponse = z.infer<typeof publicationSyncResponseSchema>;

/**
 * Un evento de la bitácora (spec F3 §4.3): cambios de estado y un `publish_attempt` por intento,
 * con lo que se envió (o se habría enviado: `publishAttemptPayloadSchema` de core). Sin secretos ni
 * URLs firmadas: quien escribe el evento no los pone.
 */
export const publicationEventViewSchema = z.object({
  id: z.string(),
  type: z.enum(PUBLICATION_EVENT_TYPES),
  fromStatus: z.enum(PUBLICATION_STATUSES).nullable(),
  toStatus: z.enum(PUBLICATION_STATUSES).nullable(),
  actor: z.enum(PUBLICATION_ACTORS),
  /** Quién lo hizo (desde F7, spec §4.3); `null` en lo del sistema y lo anterior a F7. */
  userName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.coerce.date(),
});
export type PublicationEventView = z.infer<typeof publicationEventViewSchema>;

/** `GET /publications/:id/events`: la bitácora, de la más antigua a la más nueva. */
export const publicationEventsResponseSchema = z.object({
  events: z.array(publicationEventViewSchema),
});
export type PublicationEventsResponse = z.infer<typeof publicationEventsResponseSchema>;

/**
 * Una cuenta conectada tal como la ve el operador (spec F3 §4.6 y §4.8, spec F4 §4.2,
 * `GET /accounts`): nunca credenciales. De `meta` solo lo que muestra el panel, según la plataforma
 * (Instagram o Mercado Libre); lo que falta va en `null`.
 */
export const platformAccountViewSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  platform: z.enum(PLATFORMS),
  /** Instagram: `@usuario`; Mercado Libre: el `nickname`, tal cual. */
  displayName: z.string(),
  status: z.enum(PLATFORM_ACCOUNT_STATUSES),
  tokenExpiresAt: z.coerce.date().nullable(),
  /**
   * El vencimiento es una estimación: en Instagram, el token del panel de Meta aún sin refrescar; en
   * Mercado Libre, siempre (es el horizonte del `refresh_token`, ADR-0015).
   */
  tokenExpiryEstimated: z.boolean(),
  connectedAt: z.coerce.date().nullable(),
  tokenRefreshedAt: z.coerce.date().nullable(),
  /** Instagram: `BUSINESS` o `MEDIA_CREATOR`; Mercado Libre: el `user_type` (`normal`, …). */
  accountType: z.string().nullable(),
  /** Instagram: los permisos (`null` con el token del panel); Mercado Libre: los `scopes`. */
  permissions: z.array(z.string()).nullable(),
  /** Marketplace (spec F5 §4.2): la última vez que el worker vio la sesión abierta en el perfil. */
  sessionCheckedAt: z.coerce.date().nullable(),
  /**
   * Marketplace: el último inicio de sesión que falló (tope, perfil ocupado, Chromium), con su texto
   * (`marketplaceLoginErrorText`). Sigue aunque después se conecte: la fecha dice cuál es más nuevo.
   */
  lastLoginError: z
    .object({ code: z.string(), message: z.string(), at: z.coerce.date() })
    .nullable(),
  /**
   * Marketplace (F7, ADR-0023): `profile` (el formulario automático con el perfil del navegador) o
   * `manual` (el corredor publica él mismo); `null` en las demás plataformas.
   */
  marketplaceMode: z.enum(["profile", "manual"]).nullable(),
  /**
   * X (F9-T16, spec F9 §4.12): el tope de gasto del mes de la cuenta (`meta.spendLimitUsd`, o el de
   * por defecto, US$10). Ausente en las demás plataformas.
   */
  spendLimitUsd: z.number().nonnegative().optional(),
  /**
   * Las redes de contenido de marca con modo por cuenta (ADR-0029 punto 9; LinkedIn desde F9-T15):
   * `manual` (deja el texto listo y se publica a mano) o `api`; `null` en las demás plataformas.
   */
  publishingMode: z.enum(["api", "manual"]).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PlatformAccountView = z.infer<typeof platformAccountViewSchema>;

/**
 * `GET /accounts`: las cuentas y cómo se puede conectar cada plataforma. `oauth` es `true` solo si
 * la API tiene el par de la app de Instagram y la URI de retorno es `https://` (F7); si no (F3 en
 * local, D4), el panel muestra el comando de la CLI con `--token-stdin`. `startUrl` es el inicio del
 * OAuth en el mismo host que la URI de retorno (la cookie del `state` lo distingue): el panel y la
 * CLI le suman `?broker=<slug>` y lo abren directo, no por el proxy `/api` (F3-T17).
 */
export const accountListResponseSchema = z.object({
  accounts: z.array(platformAccountViewSchema),
  connect: z.object({
    // Solo http(s): la CLI la abre en el navegador y el panel la pone en un enlace, y viene de la red.
    instagram: z.object({ oauth: z.boolean(), startUrl: z.url({ protocol: /^https?$/ }) }),
    /**
     * Mercado Libre (spec F4 §4.2): `configured` si la API tiene el par de la app (sin él, conectar
     * responde `MERCADOLIBRE_NOT_CONFIGURED`), y la dirección de retorno que el operador registra en
     * la app y desde la que copia la dirección de la barra (no es secreta).
     */
    mercadolibre: z.object({
      configured: z.boolean(),
      redirectUri: z.url({ protocol: /^https$/ }),
      /**
       * Si la vuelta es automática (F8-T19: el servidor con su dominio y HTTPS): el panel ofrece un
       * botón; si no (el Mac), la dirección se pega desde la CLI.
       */
      automatic: z.boolean(),
    }),
    /**
     * Marketplace (F8-T20): `automation` dice si el ambiente permite el formulario automático (el
     * perfil del navegador). En producción no: todos publican a mano y una cuenta de perfil que
     * quedó de antes se pasa a mano.
     */
    marketplace: z.object({ automation: z.boolean() }),
    /**
     * X (F9-T16, spec F9 §4.7): `configured` si la API tiene el par de la app (`X_CLIENT_ID` y
     * `X_CLIENT_SECRET`), y el inicio del OAuth con PKCE en el host de `X_REDIRECT_URI` (la cookie
     * firmada del `state` y del verificador lo distingue): el panel y la CLI le suman
     * `?broker=<slug>` y lo abren en el navegador con la sesión del panel. Siempre presente desde
     * F9-T19 (como LinkedIn y TikTok).
     */
    x: z.object({ configured: z.boolean(), startUrl: z.url({ protocol: /^https?$/ }) }),
    /**
     * LinkedIn (F9-T15): `configured` si la API tiene el par de la app (sin él, el inicio vuelve al
     * panel con `LINKEDIN_NOT_CONFIGURED`), y el inicio del OAuth en el host de la dirección de
     * retorno: la CLI le suma `?broker=<slug>` y lo abre en el navegador con la sesión del panel.
     */
    linkedin: z.object({
      configured: z.boolean(),
      startUrl: z.url({ protocol: /^https?$/ }),
    }),
    /**
     * TikTok (F9-T26): `configured` si la API tiene el par de la app (sin él, el inicio vuelve al
     * panel con `TIKTOK_NOT_CONFIGURED`), y el inicio del OAuth (`/api/oauth/tiktok/start`), que el
     * panel y la CLI abren con `?broker=<slug>`. Siempre presente desde F9-T19.
     */
    tiktok: z.object({ configured: z.boolean(), startUrl: z.url({ protocol: /^https?$/ }) }),
  }),
});
export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

/** `GET /accounts?broker=<slug>`: el filtro del administrador (F7-T17); un corredor ajeno, 404. */
export const accountListQuerySchema = z.object({
  broker: z.string().trim().min(1).max(100).optional(),
});

export const accountResponseSchema = z.object({ account: platformAccountViewSchema });
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/**
 * `POST /accounts/:id/refresh` (spec F3 §4.6): `force` salta solo el tope de 30 días de vigencia,
 * nunca el mínimo de 24 h desde el último refresco. El cuerpo va siempre (`{}` sin `force`).
 */
export const accountRefreshBodySchema = z.object({ force: z.boolean().optional() });
export type AccountRefreshBody = z.infer<typeof accountRefreshBodySchema>;

/**
 * `POST /accounts/:id/spend-limit` (F9-T16, spec F9 §4.12; administrador): el tope de gasto del mes
 * de una cuenta de X, en dólares (0 a 1.000). Core lo redondea a 4 decimales.
 */
export const xSpendLimitBodySchema = z.object({ spendLimitUsd: z.number().finite() }).strict();
export type XSpendLimitBody = z.infer<typeof xSpendLimitBodySchema>;

/**
 * Lo que pasó al refrescar (los valores vienen de core): `refreshed` (token nuevo y vencimiento
 * real), `skipped` (no tocaba: `reason` y desde cuándo se podrá, `refreshableAt`, que es `null` si el
 * token no vence) o `expired` (la cuenta quedó vencida: hay que reconectarla). Nunca lleva el token.
 */
export const accountRefreshResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("refreshed"), account: platformAccountViewSchema }),
  z.object({
    outcome: z.literal("skipped"),
    reason: z.enum(TOKEN_REFRESH_SKIP_REASONS),
    /** `null` con `never_expires` (F9-T02): un token que no vence nunca se refresca. */
    refreshableAt: z.coerce.date().nullable(),
    account: platformAccountViewSchema,
  }),
  z.object({
    outcome: z.literal("expired"),
    reason: z.enum(TOKEN_EXPIRED_REASONS),
    account: platformAccountViewSchema,
  }),
]);
export type AccountRefreshResponse = z.infer<typeof accountRefreshResponseSchema>;

/** El slug de un corredor en una query o un cuerpo. */
const brokerSlugSchema = z.string().trim().min(1).max(100);

/**
 * `POST /accounts/connect-token` (D4): el token largo del botón Generate token del panel de Meta.
 * Sin espacios: un token pegado con un salto de línea en medio no es válido. Nunca vuelve en la
 * respuesta ni va al log.
 */
export const connectTokenBodySchema = z.object({
  broker: brokerSlugSchema,
  platform: z.literal("instagram", { error: "por ahora solo se conecta instagram" }),
  token: z
    .string({ error: "falta el token" })
    .trim()
    .min(20, "el token es demasiado corto: cópialo completo desde Generate token")
    .max(4096, "el token es demasiado largo: copia solo el token")
    .regex(/^\S+$/, "el token no puede tener espacios ni saltos de línea"),
});
export type ConnectTokenBody = z.infer<typeof connectTokenBodySchema>;

/**
 * `POST /accounts/discord/connect` (spec F9 §4.6, F9-T14): la URL del webhook del canal, que es el
 * secreto. Aquí solo el largo y sin espacios; que sea la de un webhook lo revisa core
 * (`DISCORD_WEBHOOK_URL_INVALID`), sin repetirla. Nunca vuelve en la respuesta ni va al log.
 */
export const discordConnectBodySchema = z
  .object({
    broker: brokerSlugSchema,
    webhookUrl: z
      .string({ error: "falta la URL del webhook" })
      .trim()
      .min(1, "falta la URL del webhook")
      .max(512, "la URL del webhook es demasiado larga: copia solo la URL")
      .regex(/^\S+$/, "la URL del webhook no puede tener espacios ni saltos de línea"),
  })
  .strict();
export type DiscordConnectBody = z.infer<typeof discordConnectBodySchema>;

/**
 * `POST /accounts/:id/mode` (F9-T15, ADR-0029 punto 9): el modo de una cuenta de una red de
 * contenido de marca, `manual` o `api` (solo el administrador; LinkedIn nace `manual`, D5).
 */
export const accountModeBodySchema = z.object({ mode: z.enum(["api", "manual"]) }).strict();
export type AccountModeBody = z.infer<typeof accountModeBodySchema>;

/** La respuesta de cambiar el modo: la cuenta y si cambió. */
export const accountModeResponseSchema = z.object({
  account: platformAccountViewSchema,
  changed: z.boolean(),
});
export type AccountModeResponse = z.infer<typeof accountModeResponseSchema>;

/**
 * `POST /accounts/:id/disconnect` (spec F5 §4.2): Marketplace exige `confirmed: true` (borra el
 * perfil del navegador con la sesión de Facebook). El cuerpo va siempre (`{}` sin confirmar).
 */
export const accountDisconnectBodySchema = z.object({ confirmed: z.boolean().optional() });
export type AccountDisconnectBody = z.infer<typeof accountDisconnectBodySchema>;

/**
 * `POST /accounts/marketplace/login` (spec F5 §4.2): el corredor y, si se quiere, el nombre de la
 * cuenta (por defecto "Facebook de <corredor>").
 */
export const marketplaceLoginBodySchema = z.object({
  broker: brokerSlugSchema,
  label: z.string().trim().min(1).max(80).optional(),
});
export type MarketplaceLoginBody = z.infer<typeof marketplaceLoginBodySchema>;

/**
 * El inicio de sesión quedó en cola (202): la CLI y el panel miran `GET /accounts` hasta que una
 * cuenta de Marketplace del corredor tenga `sessionCheckedAt` o `lastLoginError.at` desde
 * `requestedAt` (`marketplaceLoginOutcome` de core).
 */
export const marketplaceLoginResponseSchema = z.object({
  queued: z.literal(true),
  brokerId: z.string(),
  requestedAt: z.coerce.date(),
});
export type MarketplaceLoginResponse = z.infer<typeof marketplaceLoginResponseSchema>;

/** `POST /accounts/mercadolibre/authorize-url` (spec F4 §4.2): el corredor que se conecta. */
export const mercadoLibreAuthorizeUrlBodySchema = z.object({ broker: brokerSlugSchema });
export type MercadoLibreAuthorizeUrlBody = z.infer<typeof mercadoLibreAuthorizeUrlBodySchema>;

/**
 * La URL de autorización de Mercado Libre con el `state` firmado (vale 10 min). Solo `https`: la
 * CLI la abre en el navegador.
 */
export const mercadoLibreAuthorizeUrlResponseSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
});
export type MercadoLibreAuthorizeUrlResponse = z.infer<
  typeof mercadoLibreAuthorizeUrlResponseSchema
>;

/** Un valor de la dirección de vuelta pegada: sin espacios ni saltos de línea. */
const pastedValue = (what: string) =>
  z
    .string({ error: `falta el ${what}` })
    .trim()
    .min(1, `falta el ${what}`)
    .max(4096, `el ${what} es demasiado largo`)
    .regex(/^\S+$/, `el ${what} no puede tener espacios ni saltos de línea`);

/**
 * `POST /accounts/mercadolibre/connect` (spec F4 §4.2): el `code` y el `state` que la CLI saca de
 * la dirección de vuelta pegada. Nunca vuelven en la respuesta ni van al log.
 */
export const mercadoLibreConnectBodySchema = z.object({
  broker: brokerSlugSchema,
  code: pastedValue("código"),
  state: pastedValue("state"),
});
export type MercadoLibreConnectBody = z.infer<typeof mercadoLibreConnectBodySchema>;

/** `GET /oauth/instagram/start?broker=<slug>`. */
export const oauthStartQuerySchema = z.object({ broker: brokerSlugSchema });
export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>;

/**
 * Códigos con que el OAuth vuelve al panel (`/cuentas?error=<código>`, spec F3 §4.6), además de los
 * `IG_*` de Instagram: el panel (T17) los traduce sin copiarlos.
 */
export const OAUTH_REDIRECT_ERRORS = [
  "OAUTH_DENIED",
  "OAUTH_STATE_INVALID",
  "OAUTH_CODE_MISSING",
  "INSTAGRAM_NOT_CONFIGURED",
  "MERCADOLIBRE_NOT_CONFIGURED",
  // F9-T15: falta el par de la app de LinkedIn.
  "LINKEDIN_NOT_CONFIGURED",
  // F9-T16: falta el par de la app de X (`/oauth/x/*` vuelve con `proveedor=x`).
  "X_NOT_CONFIGURED",
  // F9-T26: a la API le falta el par de la app de TikTok.
  "TIKTOK_NOT_CONFIGURED",
  "BROKER_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;
export type OAuthRedirectError = (typeof OAUTH_REDIRECT_ERRORS)[number];

/**
 * El proveedor con que vuelve el OAuth (`/cuentas?proveedor=…`, F8-T19): sin él, Instagram (la vuelta
 * de F3). Cambia el texto del aviso del panel.
 */
export const OAUTH_PROVIDERS = ["instagram", "mercadolibre", "linkedin", "x", "tiktok"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

// --- F6-T10: calendario, la propiedad, Portal y el seguimiento (spec F6 §4.13) ---

/**
 * Una hora en ISO con zona (la CLI y el panel la piden en hora de Chile y la convierten). Queda como
 * texto: el cliente `hc` tipa el cuerpo con lo que sale del validador. La ruta la vuelve `Date`.
 */
const scheduleAtSchema = z.iso.datetime({ offset: true });

/** `POST /listings/:id/status`: la propiedad, lo que cambió y las tareas a mano (D4). */
export const listingStatusResponseSchema = z.object({
  listing: listingJsonSchema,
  changed: z.array(publicationViewSchema),
  manualTasks: z.array(publicationViewSchema),
});
export type ListingStatusResponse = z.infer<typeof listingStatusResponseSchema>;

/** `POST /publications/:id/schedule`: la hora (al minuto; 2 min a 60 días). */
export const publicationScheduleBodySchema = z.object({ at: scheduleAtSchema });
export type PublicationScheduleBody = z.infer<typeof publicationScheduleBodySchema>;

/**
 * `POST /schedule`: una o varias propiedades (1 a 50; core rechaza las repetidas con
 * `SCHEDULE_BATCH_INVALID`), los canales (todos si falta), la hora y el espaciado entre propiedades.
 */
export const scheduleBodySchema = z.object({
  listingIds: z.array(z.uuid()).min(1).max(MAX_SCHEDULE_BATCH),
  platforms: z.array(z.enum(LISTING_PLATFORMS)).min(1).optional(),
  at: scheduleAtSchema,
  spacingMinutes: z.number().int().min(0).max(MAX_SCHEDULE_SPACING_MINUTES).optional(),
});
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

export const scheduleResultSchema = z.object({
  listingId: z.string(),
  /** `null` si la fila es de toda la propiedad (por ejemplo, la propiedad no está lista). */
  platform: z.enum(PLATFORMS).nullable(),
  outcome: z.enum(["scheduled", "skipped"]),
  at: z.coerce.date().optional(),
  publications: z.array(publicationViewSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
export const scheduleResponseSchema = z.object({
  results: z.array(scheduleResultSchema),
  /** Avisos que no bloquearon (más de 3 recordatorios de Marketplace por cuenta y día). */
  notes: z.array(z.string()),
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

/** `POST /publications/:id/update` y `/relist`: la confirmación en vivo. */
export const publicationConfirmedBodySchema = z.object({ confirmed: z.boolean().optional() });
export type PublicationConfirmedBody = z.infer<typeof publicationConfirmedBodySchema>;

/** `GET /tracking` y `GET /agenda`: el corredor (slug; todos si falta) y, en la matriz, las archivadas. */
export const trackingQuerySchema = z.object({
  broker: brokerSlugSchema.optional(),
  archived: z.enum(["0", "1"]).optional(),
});
export const agendaQuerySchema = z.object({ broker: brokerSlugSchema.optional() });

export const trackingPublicationSchema = z.object({
  id: z.string(),
  format: z.enum(PUBLICATION_FORMATS),
  /** El idioma del texto (un post puede tener dos; un aviso, siempre `es`). */
  language: z.enum(LANGUAGES),
  status: z.enum(PUBLICATION_STATUSES),
  dryRun: z.boolean(),
  /**
   * Si el modo ya está fijado (`publicationModeFixed`, D4 del spec F9.5): si no, el panel muestra el
   * del servidor. Un servidor anterior no lo manda: se lee como fijado (lo de antes).
   */
  modeFixed: z.boolean().default(true),
  /** Los medios fijos (un `post` de Instagram con uno es una imagen); `null` de un servidor anterior. */
  mediaCount: z.number().int().nonnegative().nullable().default(null),
  externalUrl: z.string().nullable(),
  scheduledAt: z.coerce.date().nullable(),
  schedule: z.enum(SCHEDULE_STATES).nullable(),
  expiry: publicationViewSchema.shape.expiry,
  lastError: publicationErrorSchema.nullable(),
  /** Como en la vista de una publicación: qué hacer con el último error. */
  errorAdvice: z.string().nullable(),
  manualTask: z.boolean(),
  /**
   * Cuándo salió (F9.5-T03, la portada); `null` si no salió. Con `default(null)`: una CLI o un
   * panel nuevos aceptan la respuesta de un servidor que todavía no lo manda.
   */
  publishedAt: z.coerce.date().nullable().default(null),
  updatedAt: z.coerce.date(),
});
export const trackingRowSchema = z.object({
  listing: z.object({
    id: z.string(),
    brokerId: z.string(),
    externalRef: z.string(),
    status: z.enum(LISTING_STATUSES),
    closeReason: z.enum(CLOSE_REASONS).nullable(),
    operation: z.enum(OPERATIONS).nullable(),
    propertyType: z.string().nullable(),
    comuna: z.string().nullable(),
  }),
  /** La portada (miniatura si existe), con URL de lectura temporal; `null` sin fotos. */
  coverUrl: z.string().nullable(),
  cells: z.object({
    instagram: z.array(trackingPublicationSchema),
    portal_inmobiliario: z.array(trackingPublicationSchema),
    fb_marketplace: z.array(trackingPublicationSchema),
  }),
});
/** La fila de un post (F9-T08): el tema es su título, y una celda por red (`POST_PLATFORMS`). */
export const trackingPostRowSchema = z.object({
  post: z.object({
    id: z.string(),
    brokerId: z.string(),
    topic: z.string(),
    status: z.enum(POST_STATUSES),
    kind: z.enum(POST_KINDS),
    plannedAt: z.coerce.date().nullable(),
  }),
  cells: z.object({
    instagram: z.array(trackingPublicationSchema),
    x: z.array(trackingPublicationSchema),
    linkedin: z.array(trackingPublicationSchema),
    discord: z.array(trackingPublicationSchema),
    tiktok: z.array(trackingPublicationSchema),
  }),
});
/** Las propiedades (`rows`) y, desde F9-T08, los posts del alcance (`posts`), en el mismo pedido. */
export const trackingResponseSchema = z.object({
  rows: z.array(trackingRowSchema),
  posts: z.array(trackingPostRowSchema),
});
export type TrackingResponse = z.infer<typeof trackingResponseSchema>;

export const agendaItemSchema = z.object({
  kind: z.enum(AGENDA_KINDS),
  action: z.enum(AGENDA_ACTIONS),
  listingId: z.string().nullable(),
  /** El post de la publicación (F9-T08); `null` en un aviso. */
  postId: z.string().nullable(),
  externalRef: z.string().nullable(),
  /** El `id_propiedad`, el tema del post o el nombre de la cuenta; `null` en el respaldo. */
  title: z.string().nullable(),
  /** La cuenta de un token por vencer, con el `slug` de su corredor. */
  accountId: z.string().nullable(),
  brokerSlug: z.string().nullable(),
  platform: z.enum(PLATFORMS).nullable(),
  format: z.enum(PUBLICATION_FORMATS).nullable(),
  publicationId: z.string().nullable(),
  at: z.coerce.date().nullable(),
  dryRun: z.boolean().nullable(),
  /** Como en el seguimiento: si el modo ya está fijado (D4 del spec F9.5); `true` si no es una publicación. */
  modeFixed: z.boolean().default(true),
  /** Los medios fijos de la publicación; `null` si no es una publicación o de un servidor anterior. */
  mediaCount: z.number().int().nonnegative().nullable().default(null),
  code: z.string().nullable(),
  advice: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
  expired: z.boolean(),
  stale: z.boolean(),
});
export const agendaResponseSchema = z.object({ items: z.array(agendaItemSchema) });
export type AgendaResponse = z.infer<typeof agendaResponseSchema>;

/**
 * `GET /calendar?from=&to=&broker=` (F9-T18): el rango `[from, to)` en ISO con zona (el panel lo
 * arma con los días de Chile), de hasta 43 días (`CALENDAR_MAX_RANGE_MS`: la vista mensual de seis
 * semanas), y el corredor o marca (slug; todo el alcance si falta).
 */
export const calendarQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    broker: brokerSlugSchema.optional(),
  })
  .refine(
    ({ from, to }) => {
      const span = Date.parse(to) - Date.parse(from);
      return span > 0 && span <= CALENDAR_MAX_RANGE_MS;
    },
    { message: "El rango va de from a to, después de from y de hasta 43 días", path: ["to"] },
  );
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

/** Una entrada del calendario: una publicación programada (se puede mover) o ya publicada. */
export const calendarEntrySchema = z.object({
  publicationId: z.string(),
  kind: z.enum(CALENDAR_ENTRY_KINDS),
  at: z.coerce.date(),
  platform: z.enum(PLATFORMS),
  format: z.enum(PUBLICATION_FORMATS),
  language: z.enum(LANGUAGES),
  status: z.enum(PUBLICATION_STATUSES),
  dryRun: z.boolean(),
  /** Los medios fijos (un `post` de Instagram con uno es una imagen); `null` de un servidor anterior. */
  mediaCount: z.number().int().nonnegative().nullable().default(null),
  schedule: z.enum(SCHEDULE_STATES).nullable(),
  /** El aviso o el post (uno de los dos), con su `id_propiedad` o su tema como título. */
  listingId: z.string().nullable(),
  postId: z.string().nullable(),
  title: z.string(),
  brokerId: z.string(),
  /** El `slug` de su corredor o marca (para "Todos"); `null` si no se encontró. */
  brokerSlug: z.string().nullable(),
  externalUrl: z.string().nullable(),
});
export const calendarResponseSchema = z.object({ entries: z.array(calendarEntrySchema) });
export type CalendarEntryView = z.infer<typeof calendarEntrySchema>;
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

/** `GET /usage?month=AAAA-MM` (spec F7 §4.7): por defecto, el mes de hoy en Chile. */
export const usageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "El mes debe ser AAAA-MM")
    .optional(),
});

/** El gasto de IA estimado de un corredor en el mes (la cifra oficial es la de Anthropic). */
export const brokerUsageSchema = z.object({
  brokerId: z.string(),
  slug: z.string(),
  spentUsd: z.number(),
  capUsd: z.number().nullable(),
  /** Si llegó al tope (core, `isOverLlmCap`): preparar los textos se frena. */
  capReached: z.boolean(),
  runs: z.number().int(),
});
/**
 * El gasto en imágenes con IA de un corredor en el mes (F9.5-T25, ADR-0038 §3), aparte del de
 * texto: con el precio configurado (la cifra oficial es la de Google) y el tope del servidor.
 */
export const brokerImageUsageSchema = z.object({
  brokerId: z.string(),
  slug: z.string(),
  spentUsd: z.number(),
  images: z.number().int(),
  capUsd: z.number(),
  /** Otra imagen ya no cabe en el tope del mes. */
  capReached: z.boolean(),
});
export const usageResponseSchema = z.object({
  month: z.string(),
  brokers: z.array(brokerUsageSchema),
  /** F9.5-T25: un servidor anterior no lo manda: se lee vacío. */
  images: z.array(brokerImageUsageSchema).default([]),
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;

// ── Corredores (F7-T13 y T14, spec F7 §4.6) ───────────────────────────────

// Los largos de core (con margen para los espacios que se recortan): más largo, 400 aquí.
const brandText = z.string().max(BRAND_TEXT_MAX + 50);
/** La marca: lo que edita el corredor (y el administrador). Core la valida y normaliza. */
const brokerBrandBodySchema = z.object({
  name: brandText.optional(),
  brandName: brandText.optional(),
  primaryColor: z.string().max(20).optional(),
  /** `""` o `null`: toma el primario. */
  secondaryColor: z.string().max(20).nullable().optional(),
  whatsapp: brandText.nullable().optional(),
  email: brandText.nullable().optional(),
  instagramHandle: brandText.nullable().optional(),
  website: brandText.nullable().optional(),
  tone: z
    .string()
    .max(TONE_MAX + 50)
    .nullable()
    .optional(),
  fixedHashtags: z.array(brandText).max(50).optional(),
});
/** Lo que solo cambia el administrador. */
const brokerSettingsBodySchema = z.object({
  operatorOwned: z.boolean().optional(),
  llmMonthlyCapUsd: z.number().nullable().optional(),
});

/**
 * `POST /brokers` (administrador): el `slug`, la marca, si es propio y su tope y, desde F9, si es un
 * corredor o una marca (`kind`, por defecto `broker`; no se cambia después).
 */
export const brokerCreateBodySchema = brokerBrandBodySchema
  .extend(brokerSettingsBodySchema.shape)
  .extend({
    kind: z.enum(BROKER_KINDS).optional(),
    slug: z.string().max(100),
    name: brandText,
    brandName: brandText,
    primaryColor: z.string().max(20),
  })
  .strict();

/** `POST /accounts/marketplace/manual` (administrador, F7-T15): activar Marketplace a mano. */
export const marketplaceManualBodySchema = z
  .object({ broker: z.string().trim().min(1).max(100) })
  .strict();

/**
 * `PATCH /brokers/:id`: la marca (el corredor y el administrador) y, solo el administrador, si es
 * propio, el tope de IA y `autoPublish` (spec F6 §4.10 y F7 §4.6; el corredor que los manda: 403).
 */
export const brokerPatchBodySchema = brokerBrandBodySchema
  .extend(brokerSettingsBodySchema.shape)
  .extend({ autoPublish: z.boolean().optional() })
  .strict();

export const onboardingStepSchema = z.object({
  key: z.enum(ONBOARDING_STEPS),
  done: z.boolean(),
  owner: z.enum(["broker", "admin"]).nullable(),
  pending: z.string().nullable(),
});
export type OnboardingStepView = z.infer<typeof onboardingStepSchema>;

export const brokerResponseSchema = z.object({ broker: brokerSchema });
export type BrokerResponse = z.infer<typeof brokerResponseSchema>;
/** `GET /brokers/:id`, `POST /brokers` y `PATCH /brokers/:id`: el corredor y su lista de alta. */
export const brokerDetailResponseSchema = brokerResponseSchema.extend({
  onboarding: z.array(onboardingStepSchema),
});
export type BrokerDetailResponse = z.infer<typeof brokerDetailResponseSchema>;

/** `POST /brokers/:id/logo`: el archivo en el campo `logo` (multipart). */
export const brokerLogoFormSchema = z.object({ logo: fileSchema });

/**
 * `POST /brokers/parse-template` (administrador, F9.5-T16): la planilla en el campo `file`
 * (multipart, hasta `MAX_BROKER_TEMPLATE_BYTES`, 3 MB). Solo se lee la hoja Corredor; no se guarda
 * nada.
 */
export const brokerTemplateFormSchema = z.object({ file: fileSchema });

const draftText = z.string().nullable();
/** Los datos de la hoja Corredor para llenar el formulario de crear un corredor (`brokerSheetDraft`). */
export const brokerTemplateDraftResponseSchema = z.object({
  draft: z.object({
    name: draftText,
    brandName: draftText,
    primaryColor: draftText,
    secondaryColor: draftText,
    whatsapp: draftText,
    email: draftText,
    instagramHandle: draftText,
    website: draftText,
    tone: draftText,
    fixedHashtags: z.array(z.string()),
    logoFile: draftText,
    warnings: z.array(z.string()),
  }),
});
export type BrokerTemplateDraftResponse = z.infer<typeof brokerTemplateDraftResponseSchema>;

// ── Borrar un corredor (F9.5-T14, ADR-0035) ──────────────────────────────────

const purgeCountsSchema = z.object({
  listings: z.number().int().nonnegative(),
  media: z.number().int().nonnegative(),
  publications: z.number().int().nonnegative(),
  /** De ellas, las `published` o `paused`: seguirán publicadas en las redes. */
  livePublications: z.number().int().nonnegative(),
  posts: z.number().int().nonnegative(),
  users: z.number().int().nonnegative(),
  accounts: z.number().int().nonnegative(),
  importRuns: z.number().int().nonnegative(),
});

/**
 * `GET /brokers/:id/purge-summary` (administrador): lo que se borraría y las publicaciones que lo
 * impiden (publicándose, programadas, esperando el clic o con resultado dudoso).
 */
export const brokerPurgeSummaryResponseSchema = z.object({
  broker: z.object({
    id: z.string(),
    slug: z.string(),
    brandName: z.string(),
    kind: z.enum(BROKER_KINDS),
  }),
  counts: purgeCountsSchema,
  blocking: z.array(
    z.object({
      publicationId: z.string(),
      status: z.enum(PUBLICATION_STATUSES),
      platform: z.string(),
    }),
  ),
});
export type BrokerPurgeSummaryResponse = z.infer<typeof brokerPurgeSummaryResponseSchema>;

/** `DELETE /brokers/:id` (administrador): el `slug` del corredor, repetido, como confirmación. */
export const brokerDeleteBodySchema = z.object({ confirm: z.string().max(200) }).strict();

/**
 * La respuesta de `DELETE /brokers/:id`: filas borradas por tabla y lo de R2 (borrados y lo que
 * quedó pendiente, con su clave o prefijo y el código; nunca una URL).
 */
export const brokerPurgeResponseSchema = z.object({
  broker: z.object({ id: z.string(), slug: z.string() }),
  deleted: z.record(z.string(), z.number().int().nonnegative()),
  storage: z.object({
    deleted: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    pending: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("key"), key: z.string(), code: z.string() }),
        z.object({ kind: z.literal("prefix"), prefix: z.string(), code: z.string() }),
      ]),
    ),
  }),
});
export type BrokerPurgeResponse = z.infer<typeof brokerPurgeResponseSchema>;

/** El tipo del archivo de `GET /brokers/:id/template.xlsx`. */
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ── Perfil editorial (F9-T09, spec F9 §4.3 y §4.10) ────────────────────────

// Solo la forma y topes holgados (el tamaño del pedido): las reglas, con sus mensajes en español,
// son de core (`normalizeEditorialProfile`, `EDITORIAL_PROFILE_INVALID` con `issues`).
const profileText = (max: number) => z.string().max(max + 50);
const profileList = (items: number, length: number) => z.array(profileText(length)).max(items * 2);

/**
 * `PUT /brokers/:id/editorial-profile`: el perfil completo (reemplaza al anterior). Estricto: un
 * campo desconocido (o un `brokerId`, que es siempre el de la ruta) es 400.
 */
export const editorialProfileBodySchema = z
  .object({
    languages: profileList(EDITORIAL_LIMITS.languages, 10),
    audience: profileText(EDITORIAL_LIMITS.audience).nullable(),
    pillars: z
      .array(
        z
          .object({
            key: profileText(EDITORIAL_LIMITS.pillarKey),
            name: profileText(EDITORIAL_LIMITS.pillarName),
            description: profileText(EDITORIAL_LIMITS.pillarDescription).optional(),
            weight: z.number(),
          })
          .strict(),
      )
      .max(EDITORIAL_LIMITS.pillars * 2),
    facts: profileList(EDITORIAL_LIMITS.facts, EDITORIAL_LIMITS.fact),
    avoid: profileList(EDITORIAL_LIMITS.avoid, EDITORIAL_LIMITS.avoidItem),
    cadence: z
      .record(
        z.string().max(40),
        z
          .object({
            postsPerWeek: z.number(),
            days: profileList(7, 10).optional(),
            hours: profileList(EDITORIAL_LIMITS.hoursPerPlatform, 10).optional(),
            languageGapHours: z.number().optional(),
          })
          .strict(),
      )
      .refine((cadence) => Object.keys(cadence).length <= 20, { message: "Demasiadas redes" }),
    defaultHashtags: profileList(EDITORIAL_LIMITS.hashtags, EDITORIAL_LIMITS.hashtag),
  })
  .strict();
export type EditorialProfileBody = z.infer<typeof editorialProfileBodySchema>;

/** El perfil como viaja en JSON: `updatedAt` es `null` si el corredor todavía no lo guarda. */
export const editorialProfileViewSchema = editorialProfileSchema
  .omit({ createdAt: true, updatedAt: true })
  .extend({ updatedAt: z.coerce.date().nullable() });
export type EditorialProfileJson = z.infer<typeof editorialProfileViewSchema>;

/** `GET` y `PUT /brokers/:id/editorial-profile`: el guardado o, si no tiene, el vacío por defecto. */
export const editorialProfileResponseSchema = z.object({ profile: editorialProfileViewSchema });
export type EditorialProfileResponse = z.infer<typeof editorialProfileResponseSchema>;

// ── Posts y sus medios (F9-T10, spec F9 §4.2, §4.5 y §4.10) ─────────────────

// Solo la forma y topes holgados (el tamaño del pedido): las reglas, con sus mensajes en español,
// son de core (`POST_INVALID`, `POST_UPLOAD_INVALID`, `POST_UPLOAD_TOO_LARGE`).

/** Una fecha en ISO con zona (el filtro de la lista queda como texto: ver `postQuerySchema`). */
const postDateText = z.iso.datetime({ offset: true });

/**
 * La fecha de un cuerpo: ISO con zona, que el esquema entrega como `Date` (la ruta no convierte).
 * El cliente `hc` la tipa como `Date`, que viaja como su ISO en UTC (`JSON.stringify`) y calza.
 */
const postDateSchema = postDateText.transform((value) => new Date(value));

/** Un post tal como viaja en JSON: las fechas llegan como texto ISO y se vuelven `Date`. */
export const postJsonSchema = postSchema.extend({
  plannedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PostJson = z.infer<typeof postJsonSchema>;

/**
 * Filtros de `GET /posts`: el corredor o marca (su id; un corredor que pide otro recibe 404), el
 * estado y el rango de `planned_at` `[from, to)` (los sin fecha quedan fuera si viene alguno).
 * `from` y `to` quedan como texto ISO: el cliente `hc` tipa la consulta con lo que sale del
 * validador y arma la URL con `String(valor)`, que de un `Date` no da un ISO. La ruta los convierte.
 */
export const postQuerySchema = z.object({
  brokerId: z.uuid().optional(),
  status: z.enum(POST_STATUSES).optional(),
  from: postDateText.optional(),
  to: postDateText.optional(),
});
export type PostQuery = z.infer<typeof postQuerySchema>;

const postTopic = z.string().max(POST_LIMITS.topic + 50);
const postBrief = z
  .string()
  .max(POST_LIMITS.brief + 100)
  .nullable();
const postPillar = z.string().max(100).nullable();

/**
 * `POST /posts`: un post manual (en `draft`, con el brief del operador). El administrador manda el
 * corredor o marca; un usuario corredor lo omite (o manda el suyo). `kind` por defecto `text`.
 */
export const createPostBodySchema = z
  .object({
    brokerId: z.uuid().optional(),
    topic: postTopic,
    brief: postBrief.optional(),
    kind: z.enum(POST_KINDS).optional(),
    pillar: postPillar.optional(),
    plannedAt: postDateSchema.nullable().optional(),
    /** La marca que permite un enlace en el texto de X (F9-T16: cuesta US$0,20); por defecto no. */
    xLinkAllowed: z.boolean().optional(),
  })
  .strict();
export type CreatePostBody = z.infer<typeof createPostBodySchema>;

/** `PATCH /posts/:id`: lo que cambia (`null` borra el brief, la línea o la fecha). */
export const updatePostBodySchema = z
  .object({
    topic: postTopic.optional(),
    brief: postBrief.optional(),
    kind: z.enum(POST_KINDS).optional(),
    pillar: postPillar.optional(),
    plannedAt: postDateSchema.nullable().optional(),
    /** La marca que permite un enlace en el texto de X (F9-T16: cuesta US$0,20). */
    xLinkAllowed: z.boolean().optional(),
    /**
     * Las redes del post (F9-T20 y T21): `post.draft` redacta solo para estas y, sin redes
     * pedidas, programar o publicar usa solo estas; `null` = todas las de la marca.
     */
    platforms: z.array(z.enum(POST_PLATFORMS)).max(POST_PLATFORMS.length).nullable().optional(),
    /**
     * La música de sus videos (F9.5-T19): un id del catálogo o `null` (sin música). Cambiarla
     * encola `post.media`, que rehace los videos (reel, X y Discord) con la pista nueva. Solo en un
     * post de video: en otro, `POST_INVALID` (400).
     */
    musicTrackId: musicTrackIdSchema.nullable().optional(),
  })
  .strict();
export type UpdatePostBody = z.infer<typeof updatePostBodySchema>;

/**
 * Un medio original de un post con su URL de lectura temporal y su miniatura, como los de un aviso,
 * más las variantes que ya tiene (`thumb`, `ig_4x5`, `ig_reel`, `x_video`): mientras falten, el
 * worker las está armando.
 */
export const postMediaItemSchema = mediaItemSchema.extend({
  variants: z.array(z.enum(PROCESSED_MEDIA_VARIANTS)),
});
export type PostMediaItem = z.infer<typeof postMediaItemSchema>;

/** `POST /posts`, `PATCH /posts/:id` y `POST /posts/:id/archive`. */
export const postResponseSchema = z.object({ post: postJsonSchema });
export type PostResponse = z.infer<typeof postResponseSchema>;

/**
 * `GET /posts/:id`: el post y sus medios originales, en orden; desde F9-T12, también sus textos
 * vigentes por red e idioma con su revisión (`POST_PLATFORMS` y `LANGUAGES` en orden), la última
 * corrida de textos y todas sus publicaciones (las más nuevas primero). Un servidor anterior no los
 * manda: se leen vacíos.
 */
export const postDetailResponseSchema = z.object({
  post: postJsonSchema,
  media: z.array(postMediaItemSchema),
  contents: z.array(contentViewSchema).default([]),
  latestRun: contentRunViewSchema.nullable().default(null),
  publications: z.array(publicationViewSchema).default([]),
  /**
   * Los archivos grandes sin sha256 que llegaron y el worker todavía revisa (`uploaded`, F9-T17):
   * todavía no son medios. Un servidor anterior no lo manda: se lee 0.
   */
  uploadsInReview: z.number().int().nonnegative().default(0),
});
export type PostDetailResponse = z.infer<typeof postDetailResponseSchema>;

export const postListResponseSchema = z.object({ posts: z.array(postJsonSchema) });
export type PostListResponse = z.infer<typeof postListResponseSchema>;

/**
 * `POST /posts/:id/uploads` (ADR-0025): cada archivo con su nombre, su tamaño exacto y su sha256 en
 * hexadecimal: obligatorio hasta 100 MB (`UPLOAD_SHA256_UP_TO_BYTES`, es su identidad) y opcional
 * sobre eso (F9-T17: el navegador no puede hashear en streaming; lo calcula el worker). Tipos y
 * topes, en core.
 */
export const postUploadRequestSchema = z
  .object({
    files: z
      .array(
        z
          .object({ name: uploadName, size: uploadSize, sha256: z.string().max(64).optional() })
          .strict(),
      )
      .max(2 * POST_UPLOAD.maxFilesPerRequest),
  })
  .strict();
export type PostUploadRequest = z.infer<typeof postUploadRequestSchema>;

/**
 * Por archivo, en el orden pedido: `upload` (un `PUT` a `url` con exactamente `headers` y el
 * archivo como cuerpo; `uploadId` es la subida), o `existing` (ese contenido ya es un medio del
 * post: nada que subir).
 */
export const postUploadTargetSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("upload"),
    name: z.string(),
    uploadId: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
  z.object({ status: z.literal("existing"), name: z.string(), mediaId: z.string() }),
]);
export type PostUploadTargetView = z.infer<typeof postUploadTargetSchema>;

/** `POST /posts/:id/uploads` (201). */
export const postUploadResponseSchema = z.object({
  post: postJsonSchema,
  uploads: z.array(postUploadTargetSchema),
});
export type PostUploadResponse = z.infer<typeof postUploadResponseSchema>;

/**
 * `POST /posts/:id/uploads/complete`: las subidas que quedaron como medios (`completed`), las que
 * siguen sin llegar a R2 (`missing`: se suben y se vuelve a llamar) y los medios del post.
 */
export const postUploadCompleteResponseSchema = z.object({
  post: postJsonSchema,
  completed: z.array(z.string()),
  missing: z.array(z.string()),
  /**
   * Las subidas grandes sin sha256 que llegaron (F9-T17): el worker calcula su sha256, crea su
   * medio y deduplica. Un servidor anterior no lo manda: se lee vacío.
   */
  uploaded: z.array(z.string()).default([]),
  media: z.array(postMediaItemSchema),
});
export type PostUploadCompleteResponse = z.infer<typeof postUploadCompleteResponseSchema>;

// ── Conseguir imágenes para un post (F9.5-T25, ADR-0038) ─────────────────

/** Un pedido de imágenes tal como viaja: las fechas como texto ISO se vuelven `Date`. */
export const postImageRunViewSchema = postImageRunSchema
  .omit({ brokerId: true, createdBy: true, startedAt: true, updatedAt: true })
  .extend({ createdAt: z.coerce.date(), finishedAt: z.coerce.date().nullable() });
export type PostImageRunView = z.infer<typeof postImageRunViewSchema>;

/**
 * `GET /posts/:id/images`: las tres fuentes (sin la clave, `available: false` y lo que falta), lo
 * que se propone buscar y pedir (editable) y los últimos pedidos del post.
 */
export const postImageOptionsResponseSchema = z.object({
  sources: z.object({
    card: z.object({ available: z.literal(true) }),
    stock: z.object({ available: z.boolean(), missing: z.string().nullable() }),
    ai: z.object({
      available: z.boolean(),
      missing: z.string().nullable(),
      priceUsd: z.number().nullable(),
      capUsd: z.number().nullable(),
      spentUsd: z.number(),
      capReached: z.boolean(),
    }),
  }),
  suggestions: z.object({ query: z.string(), prompt: z.string() }),
  runs: z.array(postImageRunViewSchema),
});
export type PostImageOptionsResponse = z.infer<typeof postImageOptionsResponseSchema>;

/** `POST /posts/:id/images`: tarjetas, una foto de la biblioteca (por su id) o una imagen con IA. */
export const postImageBodySchema = postImageRequestSchema;
export type PostImageBody = z.infer<typeof postImageBodySchema>;

/** `POST /posts/:id/images` (202) y `GET /posts/:id/images/:runId`. */
export const postImageRunResponseSchema = z.object({ run: postImageRunViewSchema });
export type PostImageRunResponse = z.infer<typeof postImageRunResponseSchema>;

export const postImageRunParamSchema = z.object({ id: z.uuid(), runId: z.uuid() });

/** `GET /posts/:id/images/stock?q=…&people=1`: sin `people=1`, sin fotos con personas. */
export const postImageStockQuerySchema = z.object({
  q: z.string().trim().min(1, "Escribe qué buscar").max(POST_IMAGE_LIMITS.queryMaxChars),
  people: z.enum(["0", "1"]).optional(),
});

/** Una foto de la biblioteca para elegir (la miniatura es de Pixabay: se muestra, no se publica). */
export const stockPhotoSchema = z.object({
  id: z.string(),
  previewUrl: z.string(),
  pageUrl: z.string(),
  tags: z.array(z.string()),
  width: z.number(),
  height: z.number(),
  author: z.string(),
});
export type StockPhotoView = z.infer<typeof stockPhotoSchema>;
export const postImageStockResponseSchema = z.object({ photos: z.array(stockPhotoSchema) });
export type PostImageStockResponse = z.infer<typeof postImageStockResponseSchema>;

// ── Textos, aprobación, publicar y programar un post (F9-T12, spec F9 §4.10) ──

/** `POST /posts/:id/draft`: pide los textos; `replaceEdits` reemplaza también los editados o aprobados. */
export const postDraftBodySchema = z.object({ replaceEdits: z.boolean().optional() }).strict();
export type PostDraftBody = z.infer<typeof postDraftBodySchema>;

/** `/posts/:id/contents/:platform/:language`: el texto vigente de una red (de posts) e idioma. */
export const postContentParamSchema = z.object({
  id: z.uuid(),
  platform: z.enum(POST_PLATFORMS),
  language: z.enum(LANGUAGES),
});
export type PostContentParam = z.infer<typeof postContentParamSchema>;

/**
 * `POST /posts/:id/publish`: una red del post (todos sus idiomas); el modo lo pone la API
 * (`PUBLISH_MODE`), nunca el cuerpo. Sin `--platform`, la CLI publica una red tras otra.
 */
export const postPublishBodySchema = z.object({ platform: z.enum(POST_PLATFORMS) }).strict();
export type PostPublishBody = z.infer<typeof postPublishBodySchema>;

/** Lo que hizo publicar una red del post: lo mismo que publicar un canal de un aviso. */
export const postPublishResponseSchema = listingPublishResponseSchema;
export type PostPublishResponse = ListingPublishResponse;

/**
 * `POST /posts/:id/schedule`: las redes (sin ellas, cada una con texto aprobado y la cuenta
 * conectada) y la hora (ISO con zona; la CLI la pide en hora de Chile).
 */
export const postScheduleBodySchema = z
  .object({
    platforms: z.array(z.enum(POST_PLATFORMS)).min(1).optional(),
    at: scheduleAtSchema,
  })
  .strict();
export type PostScheduleBody = z.infer<typeof postScheduleBodySchema>;

/** Una fila por red: programada (con su hora y sus publicaciones) o saltada (con el motivo). */
export const postScheduleResponseSchema = z.object({
  results: z.array(
    z.object({
      /** `null` si la fila es del post entero (`NOTHING_TO_PUBLISH`: ninguna red sirve). */
      platform: z.enum(PLATFORMS).nullable(),
      outcome: z.enum(["scheduled", "skipped"]),
      at: z.coerce.date().optional(),
      publications: z.array(publicationViewSchema).optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
});
export type PostScheduleResponse = z.infer<typeof postScheduleResponseSchema>;

/**
 * `POST /publications/:id/resolve` (ADR-0029 punto 8): el operador dice si una publicación con
 * resultado dudoso salió (con su enlace, si lo tiene; en simulación se ignora) o no. El enlace nunca
 * vuelve en un error ni va al log. Responde como `confirm` (`changed: false` si ya estaba así).
 */
export const publicationResolveBodySchema = z
  .object({
    outcome: z.enum(PUBLICATION_RESOLUTIONS),
    url: z
      .string()
      .trim()
      .min(1, "falta el enlace")
      .max(MARKETPLACE_URL_MAX_LENGTH, "el enlace es demasiado largo")
      .optional(),
  })
  .strict();
export type PublicationResolveBody = z.infer<typeof publicationResolveBodySchema>;

// ── El plan de ideas (F9-T21, spec F9 §4.9 y §4.10, ADR-0030) ──────────────

/**
 * `POST /plans`: la marca (el administrador la manda; un corredor la omite o manda la suya), el
 * primer día (`AAAA-MM-DD`, hora de Chile; por defecto mañana), los días (por defecto 14), las
 * redes (por defecto, todas las de la marca), cuántas ideas (por defecto, según la cadencia) y,
 * desde F9.5-T23, el pedido del operador (`guidance`: «¿Qué quieres que trate este plan?», hasta 500
 * caracteres; guía temas y tono, nunca es fuente de hechos). Los rangos y el largo los revisa core
 * (`PLAN_RUN_INVALID`, con su mensaje); aquí solo se acota lo que entra.
 */
export const planRequestBodySchema = z
  .object({
    brokerId: z.uuid().optional(),
    startDay: z.string().max(10).optional(),
    days: z.number().int().optional(),
    platforms: z.array(z.enum(POST_PLATFORMS)).max(POST_PLATFORMS.length).optional(),
    count: z.number().int().optional(),
    guidance: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type PlanRequestBody = z.infer<typeof planRequestBodySchema>;

/**
 * `GET /plans`: los planes de una marca (el administrador la manda; un corredor ve los suyos), los
 * 20 más recientes (fijo: el contrato no expone `limit`).
 */
export const planQuerySchema = z.object({ brokerId: z.uuid().optional() });

/**
 * Un plan como lo ven la CLI y el panel: su período (en días de Chile, los dos incluidos), su
 * estado, lo pedido (redes, cuántas ideas y el pedido del operador) y, si falló, el error con qué
 * hacer (`errorAdvice`). Sin el gasto ni el proveedor de IA (eso lo muestra `usage`).
 */
export const planRunViewSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  firstDay: z.string(),
  lastDay: z.string(),
  status: z.enum(PLAN_RUN_STATUSES),
  platforms: z.array(z.enum(POST_PLATFORMS)),
  count: z.number().int().nullable(),
  /** El pedido del operador (F9.5-T23); `null` si no pidió nada (o es un plan de antes). */
  guidance: z.string().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  errorAdvice: z.string().nullable(),
  promptVersion: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type PlanRunView = z.infer<typeof planRunViewSchema>;

/**
 * Una idea del plan (un post con `plan_run_id`, en cualquier estado): el post, las redes que se le
 * quitaron al proponerla (`notes`), cuántos textos vigentes tiene y su última corrida de textos.
 * Una idea aceptada sin textos ni corrida activa es la que "Redactar lo aceptado" pide de nuevo.
 */
export const planIdeaViewSchema = postJsonSchema.extend({
  notes: z.array(z.string()),
  texts: z.number().int().nonnegative(),
  latestRun: contentRunViewSchema.nullable(),
});
export type PlanIdeaView = z.infer<typeof planIdeaViewSchema>;

/** Lo que las verificaciones descartaron (con su motivo) y las advertencias de la IA. */
export const planReportViewSchema = z.object({
  discarded: z.array(z.object({ topic: z.string(), code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
});
export type PlanReportView = z.infer<typeof planReportViewSchema>;

/** `GET /plans/:id`: el plan, su reporte (`null` mientras corre o si falló) y sus ideas. */
export const planDetailResponseSchema = z.object({
  plan: planRunViewSchema,
  report: planReportViewSchema.nullable(),
  ideas: z.array(planIdeaViewSchema),
});
export type PlanDetailResponse = z.infer<typeof planDetailResponseSchema>;

/**
 * `POST /plans` (202): el plan y `reused` si la marca ya tenía uno en cola o corriendo; con
 * `guidanceIgnored`, ese plan tiene otro pedido guardado y el que llegó no se usó (F9.5-T23).
 */
export const planRequestResponseSchema = z.object({
  plan: planRunViewSchema,
  reused: z.boolean(),
  guidanceIgnored: z.boolean().default(false),
});
export type PlanRequestResponse = z.infer<typeof planRequestResponseSchema>;

/** `GET /plans`: los de la marca, los más recientes primero. */
export const planListResponseSchema = z.object({ plans: z.array(planRunViewSchema) });
export type PlanListResponse = z.infer<typeof planListResponseSchema>;

/**
 * `POST /posts/:id/accept` (202): la idea aceptada (en `draft`) y la corrida de sus textos
 * (`post.draft` encolado; `reused` si ya había una activa).
 */
export const ideaAcceptResponseSchema = z.object({
  post: postJsonSchema,
  contentRun: contentRunViewSchema,
  reused: z.boolean(),
});
export type IdeaAcceptResponse = z.infer<typeof ideaAcceptResponseSchema>;

// ── Usuarios y sesiones (F7-T04 y T05, spec F7 §4.13, ADR-0021) ────────────

/** Un usuario como lo ve el panel o la CLI: nunca el hash de la contraseña ni los tokens. */
export const userViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(USER_ROLES),
  brokerId: z.string().nullable(),
  /** Si ya eligió su contraseña (aceptó la invitación). */
  hasPassword: z.boolean(),
  disabled: z.boolean(),
  /** Bloqueado ahora por los intentos fallidos. */
  locked: z.boolean(),
  lastLoginAt: z.coerce.date().nullable(),
  /**
   * Desde F8-T15: si tiene el doble factor activo. Opcional (`false` sin él): una API anterior no
   * lo trae.
   */
  totpEnabled: z.boolean().optional().default(false),
});
export type UserView = z.infer<typeof userViewSchema>;

/** `POST /auth/login`: con `client: "cli"` el token vuelve en el cuerpo; si no, en la cookie. */
export const loginBodySchema = z.object({
  email: z.string().max(254),
  password: z.string().max(1024),
  client: z.enum(SESSION_CLIENTS).optional(),
});
export const loginResponseSchema = z.object({ user: userViewSchema, token: z.string().optional() });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * `POST /auth/login` desde F8-T15 (spec F8 §4.8): la sesión, o con el doble factor activo el
 * segundo paso (`totpRequired`), con un desafío de un solo uso que vence a los 5 min.
 */
export const totpRequiredResponseSchema = z.object({
  totpRequired: z.literal(true),
  challenge: z.string(),
  expiresAt: z.coerce.date(),
});
export type TotpRequiredResponse = z.infer<typeof totpRequiredResponseSchema>;
export const loginStepResponseSchema = z.union([totpRequiredResponseSchema, loginResponseSchema]);
export type LoginStepResponse = z.infer<typeof loginStepResponseSchema>;

/** `POST /auth/login/totp`: el desafío y el código de la app (o uno de recuperación). */
export const loginTotpBodySchema = z.object({
  challenge: z.string().min(1).max(256),
  code: z.string().max(64),
  client: z.enum(SESSION_CLIENTS).optional(),
});

/** `GET /auth/totp`: si está activo y cuántos códigos de recuperación quedan. */
export const totpStatusResponseSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesLeft: z.number().int(),
});
export type TotpStatusResponse = z.infer<typeof totpStatusResponseSchema>;

/** `POST /auth/totp/setup`: la clave (base32) y el enlace `otpauth://`, para la app del teléfono. */
export const totpSetupResponseSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

/** `POST /auth/totp/confirm` y `/disable`: un código de la app (o de recuperación al desactivar). */
export const totpCodeBodySchema = z.object({ code: z.string().max(64) });

/** `POST /auth/totp/confirm`: los códigos de recuperación, que se muestran una sola vez. */
export const totpConfirmResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type TotpConfirmResponse = z.infer<typeof totpConfirmResponseSchema>;

/** `GET /auth/me`: el usuario de la sesión, con su corredor. */
export const meResponseSchema = z.object({
  user: userViewSchema.extend({
    broker: z.object({ id: z.string(), slug: z.string(), brandName: z.string() }).nullable(),
  }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `POST /auth/invitations/accept`: el token del enlace y la contraseña elegida. */
export const acceptInvitationBodySchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().max(1024),
});

export const usersResponseSchema = z.object({ users: z.array(userViewSchema) });
export type UsersResponse = z.infer<typeof usersResponseSchema>;

/** `POST /users` (administrador). */
export const createUserBodySchema = z.object({
  email: z.string().max(254),
  name: z.string().max(200),
  role: z.enum(USER_ROLES),
  brokerId: z.uuid().nullable().optional(),
});

/** Un usuario con su enlace (crear o restablecer): `invitationUrl` se muestra una sola vez. */
export const userLinkResponseSchema = z.object({
  user: userViewSchema,
  invitationUrl: z.string(),
  expiresAt: z.coerce.date(),
});
export type UserLinkResponse = z.infer<typeof userLinkResponseSchema>;

export const userResponseSchema = z.object({ user: userViewSchema });
export type UserResponse = z.infer<typeof userResponseSchema>;
