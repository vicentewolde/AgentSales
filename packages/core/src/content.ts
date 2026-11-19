import { z } from "zod";
import { CONTENT_CHECK_CODES } from "./content/check.js";
import {
  CONTENT_RUN_STAGES,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  LANGUAGES,
  LLM_PROVIDERS,
  PLATFORMS,
  POST_PLATFORMS,
} from "./enums.js";
import { llmUsageSchema } from "./llm-usage.js";
import { subjectFields } from "./subject.js";

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
  /** Etapa `reel`: `none` sin video y con menos de 3 fotos; `skipped` si el video (o las fotos) no sirve. */
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
  /**
   * Corridas de posts (F9-T11): los códigos de la revisión de cada red **e idioma**
   * (`checkPostContent`), con la misma salvedad que `checks` (es una foto de la corrida).
   */
  postChecks: z
    .array(
      z.object({
        platform: z.enum(PLATFORMS),
        language: z.enum(LANGUAGES),
        codes: z.array(z.enum(CONTENT_CHECK_CODES)),
      }),
    )
    .optional(),
  /**
   * Corridas de posts: una huella (`postSourceHashes`) del tema y del brief con que se redactó, para avisar si
   * cambiaron después (`postSourceChanges`). Sin el texto: solo la huella. Las corridas anteriores
   * no la traen.
   */
  postSource: z.object({ topic: z.string(), brief: z.string() }).optional(),
  warnings: z.array(z.string()),
});
export type ContentRunReport = z.infer<typeof contentRunReportSchema>;

/** Motivo de una corrida fallida (`content_runs.error`): sin rutas ni datos de clientes. */
export const contentRunErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ContentRunError = z.infer<typeof contentRunErrorSchema>;

/** El tope de la indicación «¿Qué cambiar?» al rehacer un texto de un post (caracteres). */
export const CONTENT_RUN_GUIDANCE_MAX = 300;

/** Qué hace una corrida acotada: `missing` solo crea los textos que faltan; `replace` rehace los pedidos. */
export const CONTENT_RUN_SCOPE_MODES = ["missing", "replace"] as const;
export type ContentRunScopeMode = (typeof CONTENT_RUN_SCOPE_MODES)[number];

/**
 * El alcance de una corrida de un post (`content_runs.scope`): sin él (`null`), la corrida redacta
 * todas las redes del post en todos los idiomas de la marca. Con él, solo `platforms` (y solo
 * `language`, si viene): `missing` crea solo los textos que todavía no existen (una red agregada al
 * post, sin tocar los demás); `replace` rehace esos textos (rehacer uno, con la indicación del
 * operador `guidance` como guía de forma y tono, nunca como fuente de hechos).
 */
export const contentRunScopeSchema = z.object({
  platforms: z.array(z.enum(POST_PLATFORMS)).min(1).max(POST_PLATFORMS.length),
  language: z.enum(LANGUAGES).nullable(),
  mode: z.enum(CONTENT_RUN_SCOPE_MODES),
  guidance: z.string().max(CONTENT_RUN_GUIDANCE_MAX).nullable(),
});
export type ContentRunScope = z.infer<typeof contentRunScopeSchema>;

/**
 * Corrida de contenido (`content_runs`, ADR-0012): la entidad que devuelve el repositorio. Desde F9
 * (ADR-0029), de un aviso o de un post (`subject`).
 */
export const contentRunSchema = z.object({
  id: z.string(),
  ...subjectFields,
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
  /** Lo gastado en IA, sumado por llamada (spec F7 §4.7); `null` si no llamó al modelo. */
  llmUsage: llmUsageSchema.nullable(),
  /** El alcance de una corrida de post (`contentRunScopeSchema`); `null`: todo el post. */
  scope: contentRunScopeSchema.nullable().default(null),
});
export type ContentRun = z.infer<typeof contentRunSchema>;

/**
 * Texto de un aviso (o, desde F9, de un post: `subject`) para un canal y un idioma (`contents`,
 * ADR-0012 y ADR-0013). El **vigente** de cada canal e idioma es el más reciente; los anteriores
 * quedan como historial. `rawOutput` es la salida validada de la IA (`contentDraftSchema`, F2-T05):
 * aquí se guarda tal cual.
 */
export const contentSchema = z.object({
  id: z.string(),
  ...subjectFields,
  contentRunId: z.string(),
  platform: z.enum(PLATFORMS),
  /** `LANGUAGES`: los textos de un aviso son `es`; un post puede tener uno por idioma (spec F9 §4.4). */
  language: z.enum(LANGUAGES),
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
