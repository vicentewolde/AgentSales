import { z } from "zod";
import {
  MEDIA_KINDS,
  PLATFORMS,
  type Platform,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  PUBLISH_MODES,
  type PublicationStatus,
} from "./enums.js";
import { AppError } from "./errors.js";
import { marketplaceProgressSchema } from "./marketplace/progress.js";
import { portalProgressSchema } from "./portal/progress.js";

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
  portal_inmobiliario: portalProgressSchema,
  fb_marketplace: marketplaceProgressSchema,
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
 * El código de un motivo de `remote_state` (Mercado Libre: el `name` de la moderación): un
 * identificador, nunca un texto libre. Lo comparten el esquema y el cliente que lo lee.
 */
export const REMOTE_REASON_CODE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Lo último que informó la plataforma sobre lo publicado (`publications.remote_state`, ADR-0015):
 * su estado y subestado tal cual (Mercado Libre: `active`, `paused`, `under_review`, `closed`…),
 * cuándo vence y cuándo se consultó. No es el estado de la publicación (que es nuestro): el sync
 * (spec F4 §4.9) lo usa para ajustarlo y el panel para mostrar "procesando fotos" o "en revisión".
 * Es jsonb: las fechas van como texto ISO. Sin secretos. Solo se amplía con campos opcionales: si
 * se endurece, las filas ya guardadas dejarían de calzar (`PUBLICATION_ROW_INVALID`).
 */
export const remoteStateSchema = z.object({
  status: z.string().min(1),
  subStatus: z.array(z.string()),
  /** Fin de la vigencia del aviso en la plataforma (Mercado Libre: `stop_time`). */
  stopTime: z.iso.datetime({ offset: true }).nullable(),
  /** Vencimiento de lo que lo cubre (Mercado Libre: `expiration_time`, el del paquete). */
  expirationTime: z.iso.datetime({ offset: true }).nullable(),
  /**
   * Por qué la plataforma la pausó (Mercado Libre: la última moderación, desde F4-T15): el código
   * de la moderación (`ABANDONED_ITEM_REX_DEN`) y un texto propio en español, nunca el de la
   * plataforma. Opcional: solo en una pausa por moderación.
   */
  reason: z
    .object({
      code: z.string().regex(REMOTE_REASON_CODE),
      message: z.string().min(1).max(300),
    })
    .optional(),
  checkedAt: z.iso.datetime(),
});
export type RemoteState = z.infer<typeof remoteStateSchema>;

/**
 * Valida el estado remoto antes de guardarlo (`PublicationRepository`): `null` lo borra.
 * `PUBLICATION_REMOTE_STATE_INVALID` (no reintentable) si no calza.
 */
export function checkRemoteState(remoteState: unknown): RemoteState | null {
  if (remoteState === null) return null;
  const parsed = remoteStateSchema.safeParse(remoteState);
  if (!parsed.success) {
    throw new AppError(
      "PUBLICATION_REMOTE_STATE_INVALID",
      "El estado informado por la plataforma no es válido",
    );
  }
  return parsed.data;
}

/**
 * `payload` de un evento `sync` (spec F4 §4.9): lo que se leyó de la plataforma. Si el sync
 * cambió el estado, ese cambio va en su propio `status_changed`.
 */
export const syncPayloadSchema = z.object({ remote: remoteStateSchema });
export type SyncPayload = z.infer<typeof syncPayloadSchema>;

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

/**
 * Si una publicación ya empezó en vivo en la plataforma (`dryRun: false` con progreso guardado): no
 * se reintenta en `dry-run` (`PUBLISH_MODE_LOCKED`, D11) y la API lo anticipa (`startedLive`).
 */
export const hasStartedLive = (publication: { dryRun: boolean; progress: unknown }): boolean =>
  !publication.dryRun && publication.progress !== null;

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
    /** Lo último que informó la plataforma (ADR-0015); `null` hasta el primer dato y en Instagram. */
    remoteState: remoteStateSchema.nullable(),
    /**
     * `source_hash` del aviso al nacer (ADR-0015, spec F4 §4.6): las plataformas que envían datos
     * del aviso no publican si cambió. `null` en las anteriores a la migración `0007`.
     */
    listingSourceHash: z.string().min(1).nullable(),
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

/**
 * Lo que se envió en un intento (o se habría enviado en `dry-run`): formato, título, caption, medios
 * (ruta de R2, tipo, tamaño y medidas) y la cuenta. **Nunca** URLs firmadas ni credenciales. Lo
 * arma `publishAttemptRecord`.
 */
export const publishAttemptRecordSchema = z.object({
  platform: z.enum(PLATFORMS),
  format: z.enum(PUBLICATION_FORMATS),
  title: z.string().nullable(),
  caption: z.string(),
  media: z.array(
    z.object({
      mediaId: z.string(),
      storagePath: z.string(),
      kind: z.enum(MEDIA_KINDS),
      mime: z.string(),
      bytes: z.number().int().nonnegative(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      durationS: z.number().nullable(),
    }),
  ),
  account: z.object({ id: z.string(), displayName: z.string() }),
  /**
   * Portal y Marketplace (spec F4 §4.6): los datos del aviso enviados, nunca `internal_notes` ni
   * `attributes._extra`; la dirección y la unidad en `null` si el aviso no las muestra. Solo se
   * amplía con campos opcionales (las filas guardadas tienen que seguir leyéndose).
   */
  listing: z
    .object({
      id: z.string(),
      externalRef: z.string(),
      operation: z.string().nullable(),
      propertyType: z.string().nullable(),
      region: z.string().nullable(),
      comuna: z.string().nullable(),
      address: z.string().nullable(),
      unitNumber: z.string().nullable(),
      showExactAddress: z.boolean(),
      priceAmount: z.number(),
      priceCurrency: z.string(),
      attributes: z.record(z.string(), z.unknown()),
    })
    .optional(),
  /** El contacto del corredor enviado, con el WhatsApp enmascarado (`maskWhatsapp`). */
  brokerContact: z
    .object({ name: z.string(), email: z.string().nullable(), whatsapp: z.string().nullable() })
    .optional(),
});
export type PublishAttemptRecord = z.infer<typeof publishAttemptRecordSchema>;

/** Resultado de un intento: publicado, se reintenta (sigue en `publishing`) o quedó `failed`. */
export const PUBLISH_ATTEMPT_RESULTS = ["published", "retry", "failed"] as const;
export type PublishAttemptResult = (typeof PUBLISH_ATTEMPT_RESULTS)[number];

/**
 * `payload` del evento `publish_attempt` (spec F3 §4.3, F3-T11): uno por intento, salvo un corte
 * por apagado. `attempt` = `publications.attempts` (veces que se pidió publicar) y `retry` = el
 * reintento de la cola; `sent` falta si el intento falló antes de armar lo que se envía. Lo usan
 * quien escribe (el intento) y quien lee (API, CLI y panel).
 */
export const publishAttemptPayloadSchema = z.object({
  mode: z.enum(PUBLISH_MODES),
  attempt: z.number().int().nonnegative(),
  retry: z.number().int().nonnegative(),
  result: z.enum(PUBLISH_ATTEMPT_RESULTS),
  error: publicationErrorSchema.optional(),
  sent: publishAttemptRecordSchema.optional(),
  /**
   * Advertencias que no bloquearon (F4-T13): las de `preflight` en `dry-run` o las de crear el ítem
   * en `live`, limpias (`scrubMessage`) y como mucho 20.
   */
  notes: z.array(z.string()).optional(),
});
export type PublishAttemptPayload = z.infer<typeof publishAttemptPayloadSchema>;
