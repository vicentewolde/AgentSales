import type { AbortSignalLike } from "../abort.js";
import type { MediaKind, Platform, PublicationFormat } from "../enums.js";
import type { PlatformAccount, PlatformCredentials } from "../platform-account.js";

/**
 * Un medio tal como se envía a la plataforma (spec F3 §4.4): sus datos y una URL de lectura
 * firmada, recién creada para el intento. `url` es un secreto de corta vida: nunca va a un log ni
 * a la bitácora (el registro de `dry-run` lleva `storagePath`).
 */
export type PublishMediaItem = {
  mediaId: string;
  kind: MediaKind;
  mime: string;
  /** Ruta en R2: lo que registra la bitácora. */
  storagePath: string;
  /** URL firmada para que la plataforma descargue el archivo. */
  url: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Solo videos. */
  durationS: number | null;
};

/**
 * Lo que se publica en un intento (`buildPublishInput`): el texto aprobado y los medios fijados al
 * nacer la publicación, en orden.
 */
export type PublishInput = {
  publicationId: string;
  platform: Platform;
  format: PublicationFormat;
  /** Portal y Marketplace; `null` en Instagram. */
  title: string | null;
  /** Instagram: el cuerpo y los hashtags (`instagramCaption`); los demás canales: el cuerpo. */
  caption: string;
  media: PublishMediaItem[];
};

/** Un motivo por el que la plataforma no aceptaría el `PublishInput`, en español y sin datos del aviso. */
export type PublishIssue = { code: string; message: string };

export type PublishValidation = { ok: true } | { ok: false; issues: PublishIssue[] };

/** Lo que un intento necesita además del `PublishInput` (ADR-0014). */
export type PublishContext = {
  account: PlatformAccount;
  /** Ya descifradas: solo en memoria, nunca en un log, un error ni la bitácora. */
  credentials: PlatformCredentials;
  /** Lo que guardó un intento anterior (`publications.progress`), para retomar sin duplicar. */
  progress: unknown | null;
  /** Guarda el progreso **antes** del paso que publica (Instagram: antes de `media_publish`). */
  saveProgress(progress: unknown): Promise<void>;
  signal?: AbortSignalLike;
};

/** Resultado de un intento: el id y el enlace en la plataforma; `simulated` en `dry-run`. */
export type PublishResult = { externalId: string; externalUrl: string | null; simulated: boolean };

/**
 * Publica en una plataforma (ADR-0014, spec F3 §4.5). Lo implementan los adaptadores de
 * `packages/publishers`; en `dry-run`, `withDryRun` lo envuelve y nunca llama a `publish`.
 * - `validate` es pura (sin red ni cliente de la API): la usa también `withDryRun`.
 * - `publish` lanza `AppError` con `retriable` según la plataforma; puede llamar a `saveProgress`
 *   y retomar desde `ctx.progress`.
 * `unpublish` y `getStatus` se suman cuando un canal los use (F4 y F6).
 */
export interface Publisher {
  readonly platform: Platform;
  /** Formatos que publica (Instagram: `post` y `reel`). */
  readonly formats: readonly PublicationFormat[];
  validate(input: PublishInput): PublishValidation;
  publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
}
