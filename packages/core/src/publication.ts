import { z } from "zod";
import {
  PLATFORMS,
  type Platform,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  type PublicationStatus,
} from "./enums.js";
import { AppError } from "./errors.js";

/**
 * Lo que el publisher de Instagram ya creó en la plataforma (`publications.progress`, ADR-0014):
 * se guarda antes de `media_publish` para que un reintento retome sin publicar dos veces
 * (spec F3 §4.4). Es jsonb, así que la fecha va como texto ISO.
 */
export const instagramProgressSchema = z.object({
  /** Inicio del intento que creó los contenedores: para reconocer el medio si ya se publicó. */
  attemptStartedAt: z.iso.datetime(),
  /** Contenedores de los hijos de un carrusel, en orden; vacío en un reel o una imagen suelta. */
  childIds: z.array(z.string().min(1)),
  /** Contenedor que se publica (el del carrusel, la imagen o el reel); `null` hasta crearlo. */
  containerId: z.string().min(1).nullable(),
  /**
   * Cuándo se pidió `media_publish` (F3-T09): si un corte deja la respuesta sin leer, el reintento
   * espera y busca el medio antes de pedirlo otra vez. Opcional: los progresos anteriores no lo tienen.
   */
  publishRequestedAt: z.iso.datetime().optional(),
});
export type InstagramProgress = z.infer<typeof instagramProgressSchema>;

/** Esquema del progreso de cada plataforma; las que aún no publican no tienen. */
export const PUBLICATION_PROGRESS_SCHEMAS = {
  instagram: instagramProgressSchema,
} as const satisfies Readonly<Partial<Record<Platform, z.ZodType>>>;

/**
 * Valida el progreso antes de guardarlo (`PublicationRepository`): con el esquema de su plataforma,
 * o `null` para borrarlo. `PUBLICATION_PROGRESS_INVALID` (no reintentable) si no calza: así un
 * progreso mal formado nunca deja una publicación ilegible e imposible de reintentar.
 */
export function checkPublicationProgress(platform: Platform, progress: unknown): unknown {
  if (progress === null) return null;
  const schemas: Readonly<Partial<Record<Platform, z.ZodType>>> = PUBLICATION_PROGRESS_SCHEMAS;
  const parsed = schemas[platform]?.safeParse(progress);
  if (parsed === undefined || !parsed.success) {
    throw new AppError(
      "PUBLICATION_PROGRESS_INVALID",
      `El progreso no calza con el de ${platform}`,
      { details: { platform } },
    );
  }
  return parsed.data;
}

/**
 * `payload` de un evento tal como queda guardado (jsonb): un objeto JSON. `PUBLICATION_EVENT_INVALID`
 * si no lo es. No revisa secretos: quien lo arma no los pone (spec F3 §4.3).
 */
export function normalizeEventPayload(payload: unknown): Record<string, unknown> {
  const json: unknown = JSON.parse(JSON.stringify(payload ?? {}));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AppError("PUBLICATION_EVENT_INVALID", "El detalle de un evento debe ser un objeto");
  }
  return json as Record<string, unknown>;
}

/**
 * Al pasar a `publishing`, el modo de ese intento es obligatorio (spec F3 §4.3, D11): el worker lo
 * respeta, así que nunca puede quedar uno viejo. `PUBLICATION_MODE_REQUIRED` si falta.
 */
export function requirePublicationMode(to: PublicationStatus, dryRun: boolean | undefined): void {
  if (to === "publishing" && dryRun === undefined) {
    throw new AppError(
      "PUBLICATION_MODE_REQUIRED",
      "Al pasar a publishing hay que fijar el modo (dry-run o live)",
    );
  }
}

/** Motivo del último intento fallido (`publications.last_error`): legible y sin secretos. */
export const publicationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retriable: z.boolean(),
});
export type PublicationError = z.infer<typeof publicationErrorSchema>;

/**
 * Un aviso en una cuenta y un formato (`publications`, ADR-0014). Nace en `approved` con
 * `contentId` y `mediaIds` fijos; `progress` debe calzar con el esquema de su plataforma.
 */
export const publicationSchema = z
  .object({
    id: z.string(),
    listingId: z.string(),
    platformAccountId: z.string(),
    platform: z.enum(PLATFORMS),
    format: z.enum(PUBLICATION_FORMATS),
    contentId: z.string(),
    /** Medios que se publican, en orden. */
    mediaIds: z.array(z.string()),
    status: z.enum(PUBLICATION_STATUSES),
    scheduledAt: z.date().nullable(),
    publishedAt: z.date().nullable(),
    externalId: z.string().nullable(),
    externalUrl: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: publicationErrorSchema.nullable(),
    /** Modo con que se pidió el último intento: lo respeta el worker (spec F3 §4.3, D11). */
    dryRun: z.boolean(),
    progress: z.unknown().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .superRefine((publication, ctx) => {
    if (publication.progress === null) return;
    const schemas: Readonly<Partial<Record<Platform, z.ZodType>>> = PUBLICATION_PROGRESS_SCHEMAS;
    const schema = schemas[publication.platform];
    if (schema === undefined || !schema.safeParse(publication.progress).success) {
      ctx.addIssue({
        code: "custom",
        path: ["progress"],
        message: `El progreso no calza con el de ${publication.platform}`,
      });
    }
  });
export type Publication = z.infer<typeof publicationSchema>;

/** Tipos de evento de la bitácora (`publication_events.type`). */
export const PUBLICATION_EVENT_TYPES = [
  "status_changed",
  "publish_attempt",
  "sync",
  "manual_edit",
] as const;
export type PublicationEventType = (typeof PUBLICATION_EVENT_TYPES)[number];

/** Quién causó un evento: el sistema (worker), el operador (panel) o la CLI. */
export const PUBLICATION_ACTORS = ["system", "operator", "cli"] as const;
export type PublicationActor = (typeof PUBLICATION_ACTORS)[number];

/** Evento de la bitácora (`publication_events`, inmutable): `payload` nunca lleva secretos. */
export const publicationEventSchema = z.object({
  id: z.string(),
  publicationId: z.string(),
  type: z.enum(PUBLICATION_EVENT_TYPES),
  /** `null` al nacer la publicación y en los eventos que no cambian el estado. */
  fromStatus: z.enum(PUBLICATION_STATUSES).nullable(),
  toStatus: z.enum(PUBLICATION_STATUSES).nullable(),
  actor: z.enum(PUBLICATION_ACTORS),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
});
export type PublicationEvent = z.infer<typeof publicationEventSchema>;
