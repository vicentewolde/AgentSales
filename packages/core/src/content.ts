import { z } from "zod";
import { CONTENT_CHECK_CODES } from "./content/check.js";
import {
  CONTENT_RUN_STAGES,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  LLM_PROVIDERS,
  PLATFORMS,
} from "./enums.js";

const count = z.number().int().nonnegative();

/**
 * Reporte de una corrida de contenido (`content_runs.report`, spec F2 §4.4): lo muestran la CLI y
 * el panel. Se arma en memoria durante la corrida (una sección por etapa, así que todas son
 * opcionales) y se guarda una vez, al terminar (`markSucceeded` o `markFailed`); las
 * advertencias usan textos fijos por código (sin claves de R2 ni datos del aviso). Los campos
 * nuevos se agregan como opcionales, para que los reportes ya guardados sigan validando.
 */
/** Qué pasó con el reel en una corrida (`report.reel`). */
export const CONTENT_REEL_OUTCOMES = ["created", "existing", "none", "skipped"] as const;
export type ContentReelOutcome = (typeof CONTENT_REEL_OUTCOMES)[number];

export const contentRunReportSchema = z.object({
  /** Etapa `media`: originales procesados ahora, los que ya tenían sus variantes y los ilegibles. */
  media: z.object({ processed: count, existing: count, failed: count }).optional(),
  /** Etapa `renders`: portada y ficha renderizadas ahora o que no cambiaron. */
  renders: z.object({ rendered: count, existing: count }).optional(),
  /** Etapa `reel`: `none` si el aviso no tiene video; `skipped` si el video no sirve (muy corto). */
  reel: z.enum(CONTENT_REEL_OUTCOMES).optional(),
  /** Etapa `texts`: la llamada a la IA (sin el prompt ni la respuesta, que traen datos). */
  llm: z
    .object({
      provider: z.enum(LLM_PROVIDERS),
      model: z.string(),
      promptVersion: z.string(),
      attempts: count,
      durationMs: count,
    })
    .optional(),
  /**
   * Etapa `texts`: los códigos de la revisión editorial de cada canal (F2-T10), sin los mensajes,
   * que traen trozos del aviso. Es una foto de la corrida: tras una edición queda vieja, y la
   * revisión vigente se calcula al leer (`getListingContent`, F2-T12).
   */
  checks: z.partialRecord(z.enum(PLATFORMS), z.array(z.enum(CONTENT_CHECK_CODES))).optional(),
  warnings: z.array(z.string()),
});
export type ContentRunReport = z.infer<typeof contentRunReportSchema>;

/** Motivo de una corrida fallida (`content_runs.error`): sin rutas ni datos de clientes. */
export const contentRunErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ContentRunError = z.infer<typeof contentRunErrorSchema>;

/** Corrida de contenido (`content_runs`, ADR-0012): la entidad que devuelve el repositorio. */
export const contentRunSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  status: z.enum(CONTENT_RUN_STATUSES),
  /** Si la corrida genera textos; `false` solo rehace medios y renders. */
  texts: z.boolean(),
  /** Etapa en curso o la última que empezó; `null` antes de empezar. */
  stage: z.enum(CONTENT_RUN_STAGES).nullable(),
  /** `null` hasta que la corrida termina. */
  report: contentRunReportSchema.nullable(),
  error: contentRunErrorSchema.nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ContentRun = z.infer<typeof contentRunSchema>;

/**
 * Texto de un aviso para un canal (`contents`, ADR-0012 y ADR-0013). El **vigente** de cada canal
 * es el más reciente; los anteriores quedan como historial. `rawOutput` es la salida validada de
 * la IA (`contentDraftSchema`, F2-T05): aquí se guarda tal cual.
 */
export const contentSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  contentRunId: z.string(),
  platform: z.enum(PLATFORMS),
  /** Portal y Marketplace; `null` en Instagram. */
  title: z.string().nullable(),
  body: z.string(),
  hashtags: z.array(z.string()),
  status: z.enum(CONTENT_STATUSES),
  llmProvider: z.enum(LLM_PROVIDERS),
  llmModel: z.string(),
  promptVersion: z.string(),
  rawOutput: z.unknown(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Content = z.infer<typeof contentSchema>;
