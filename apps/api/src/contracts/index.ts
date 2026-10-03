// Contratos HTTP compartidos (ADR-0011): la API valida su entrada y tipa sus respuestas con estos
// esquemas, y la CLI y el panel validan con los mismos lo que reciben. Es lo único de la API que
// el panel importa en tiempo de ejecución: Biome limita este directorio a `zod`, `@agentsales/core`
// e imports relativos (nada de Node ni de `@agentsales/config`).
import {
  brokerSchema,
  CONTENT_CHECK_CODES,
  CONTENT_CHECK_SEVERITY_LEVELS,
  CONTENT_STATUSES,
  contentRunSchema,
  FIELD_TYPES,
  importRunSchema,
  LISTING_MANUAL_TARGETS,
  LISTING_STATUSES,
  listingSchema,
  MAX_XLSX_BYTES,
  MEDIA_KINDS,
  MEDIA_VARIANTS,
  OPERATIONS,
  PLATFORMS,
} from "@agentsales/core";
import { z } from "zod";

/** Cuerpo de todo error de la API: solo `code` y `message`, nunca `details` ni `cause`. */
export const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
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
});
export type ListingQuery = z.infer<typeof listingQuerySchema>;

/** `PATCH /listings/:id/status`: solo hacia los estados manuales (`LISTING_MANUAL_TRANSITIONS`). */
export const listingStatusBodySchema = z.object({ status: z.enum(LISTING_MANUAL_TARGETS) });
export type ListingStatusBody = z.infer<typeof listingStatusBodySchema>;

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

export const listingListResponseSchema = z.object({
  listings: z.array(listingJsonSchema.extend({ coverUrl: z.string().nullable() })),
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

export const listingStatusResponseSchema = z.object({ listing: listingJsonSchema });
export type ListingStatusResponse = z.infer<typeof listingStatusResponseSchema>;

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

/**
 * Un `<input type="file">` sin elegir llega vacío (como texto `""` o un `File` de 0 bytes, según
 * el cliente), y un `<select>` sin corredor como `""`: cuentan como "no enviado".
 */
const optionalFile = z.preprocess(
  (value) => (value === "" || (value instanceof File && value.size === 0) ? undefined : value),
  fileSchema.optional(),
);
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

/**
 * `POST /imports` (multipart, desde el panel): el Excel (hasta `MAX_XLSX_BYTES`), el zip de
 * medios (opcional), el corredor (opcional) y `dryRun` como texto. El tope del xlsx se revisa en
 * la ruta, ya leído el cuerpo.
 */
export const importUploadFormSchema = z.object({
  file: fileSchema,
  media: optionalFile,
  broker: optionalText,
  dryRun: z.enum(["true", "false"]).optional(),
});

/** Tope del xlsx subido: el mismo del lector (core). */
export const MAX_XLSX_UPLOAD_BYTES = MAX_XLSX_BYTES;

/** Ruta absoluta (Unix o Windows): la CLI resuelve las relativas antes de llamar (spec F1 §4.1). */
const absolutePath = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\/])/, "debe ser una ruta absoluta")
  .regex(/[^\\/]$/, "debe terminar en el nombre de un archivo o carpeta");

/** `POST /imports/local` (la CLI, solo en desarrollo): rutas del disco del operador. */
export const localImportBodySchema = z.object({
  xlsxPath: absolutePath,
  mediaDir: absolutePath.optional(),
  broker: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
});
export type LocalImportBody = z.infer<typeof localImportBodySchema>;

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

/** Una corrida de contenido con sus fechas como `Date` (estado, etapa, reporte y error). */
export const contentRunViewSchema = contentRunSchema.extend({
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
  /** El vigente de cada canal, en el orden de `PLATFORMS`; vacío si nunca se generó. */
  contents: z.array(contentViewSchema),
  /** Instagram: portada, fotos y ficha (hasta 10). */
  carousel: z.array(contentMediaSchema),
  /** Portal Inmobiliario y Marketplace: fotos 4:3, la portada primero. */
  photos: z.array(contentMediaSchema),
  reel: contentMediaSchema.nullable(),
  latestRun: contentRunViewSchema.nullable(),
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
