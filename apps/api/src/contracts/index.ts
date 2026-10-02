// Contratos HTTP compartidos (ADR-0011): la API valida su entrada y tipa sus respuestas con estos
// esquemas, y la CLI y el panel validan con los mismos lo que reciben. Es lo único de la API que
// el panel importa en tiempo de ejecución: Biome limita este directorio a `zod`, `@agentsales/core`
// e imports relativos (nada de Node ni de `@agentsales/config`).
import {
  brokerSchema,
  importRunSchema,
  LISTING_MANUAL_TARGETS,
  LISTING_STATUSES,
  listingSchema,
  MEDIA_KINDS,
  OPERATIONS,
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

/** Un medio original con su URL de lectura temporal (prefirmada). */
export const mediaItemSchema = z.object({
  id: z.string(),
  kind: z.enum(MEDIA_KINDS),
  mime: z.string(),
  bytes: z.number().int(),
  sortOrder: z.number().int(),
  isCover: z.boolean(),
  url: z.string(),
});
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const listingListResponseSchema = z.object({
  listings: z.array(listingJsonSchema.extend({ coverUrl: z.string().nullable() })),
});
export type ListingListResponse = z.infer<typeof listingListResponseSchema>;

export const listingDetailResponseSchema = z.object({
  listing: listingJsonSchema,
  /** En orden; la portada lleva `isCover`. */
  media: z.array(mediaItemSchema),
});
export type ListingDetailResponse = z.infer<typeof listingDetailResponseSchema>;

export const listingStatusResponseSchema = z.object({ listing: listingJsonSchema });
export type ListingStatusResponse = z.infer<typeof listingStatusResponseSchema>;

export const brokerListResponseSchema = z.object({ brokers: z.array(brokerSchema) });
export type BrokerListResponse = z.infer<typeof brokerListResponseSchema>;

/** Tope del xlsx subido (el mismo del lector, spec F1 §4.4). */
export const MAX_XLSX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * `POST /imports` (multipart, desde el panel): el Excel, el zip de medios (opcional), el corredor
 * (opcional) y `dryRun` como texto. El tope del xlsx se revisa en la ruta, ya leído el cuerpo.
 */
export const importUploadFormSchema = z.object({
  file: z.instanceof(File),
  media: z.instanceof(File).optional(),
  broker: z.string().trim().min(1).optional(),
  dryRun: z.enum(["true", "false"]).optional(),
});

/** Ruta absoluta (Unix o Windows): la CLI resuelve las relativas antes de llamar (spec F1 §4.1). */
const absolutePath = z.string().regex(/^(\/|[A-Za-z]:[\\/])/, "debe ser una ruta absoluta");

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

export const importRunListResponseSchema = z.object({ importRuns: z.array(importRunViewSchema) });
export type ImportRunListResponse = z.infer<typeof importRunListResponseSchema>;
