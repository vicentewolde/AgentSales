import type { AbortSignalLike } from "../abort.js";
import type { Broker } from "../broker.js";
import type { MediaKind, Platform, PublicationFormat } from "../enums.js";
import type { Listing } from "../listing.js";
import type { PlatformAccount, PlatformCredentials } from "../platform-account.js";
import type { RemoteState } from "../publication.js";

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
 * Los datos del aviso que van en el input de las plataformas que publican el aviso, no solo el
 * texto (Portal; Marketplace en F5; spec F4 §4.6): tipo, operación, precio, ubicación y atributos.
 * **Nunca** `internal_notes`. La dirección y la unidad van aunque `showExactAddress = false`: la
 * plataforma las necesita para ubicar el aviso y las oculta ella (Mercado Libre:
 * `address_line_by_reference`).
 */
export type PublishListing = Pick<
  Listing,
  | "id"
  | "externalRef"
  | "operation"
  | "propertyType"
  | "region"
  | "comuna"
  | "address"
  | "unitNumber"
  | "showExactAddress"
  | "priceAmount"
  | "priceCurrency"
  | "attributes"
>;

/** El contacto del corredor que exige la plataforma en el aviso (Mercado Libre: `seller_contact`). */
export type PublishBrokerContact = Pick<Broker, "name" | "email" | "whatsapp">;

/**
 * Lo que se publica en un intento (`buildPublishInput`): el texto aprobado y los medios fijados al
 * nacer la publicación, en orden. Portal y Marketplace suman el aviso y el contacto del corredor
 * (`PUBLISH_LISTING_PLATFORMS`); Instagram no los recibe.
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
  /** Portal y Marketplace: el aviso, tal como se aprobó (`listing_source_hash`, spec F4 §4.6). */
  listing?: PublishListing;
  /** Portal y Marketplace. */
  brokerContact?: PublishBrokerContact;
};

/** Un motivo por el que la plataforma no aceptaría el `PublishInput`, en español y sin datos del aviso. */
export type PublishIssue = { code: string; message: string };

/**
 * `ok: true` puede traer `notes`: advertencias que no bloquean (Mercado Libre: `cause[]` de tipo
 * `warning` en `preflight`), que van a la bitácora.
 */
export type PublishValidation =
  | { ok: true; notes?: string[] }
  | { ok: false; issues: PublishIssue[] };

/**
 * Un token de la plataforma sin conocer repositorios (ADR-0015 punto 7): lo arma core
 * (`accessTokenProvider`, con `ensureAccessToken`, en Portal). Sin estado: después de un 401, quien
 * llama pasa el token rechazado (`rejectedToken`) y recibe uno nuevo.
 */
export type AccessTokenProvider = (options?: {
  rejectedToken?: string;
  signal?: AbortSignalLike;
}) => Promise<string>;

/** Lo que una llamada a la plataforma necesita (las operaciones, `preflight`, el sync). */
export type PlatformContext = {
  account: PlatformAccount;
  accessToken: AccessTokenProvider;
  signal?: AbortSignalLike;
};

/**
 * Lo que un intento necesita además del `PublishInput` (ADR-0014). `accessToken` es opcional para
 * que el contexto de Instagram (que usa `credentials`) no cambie: el intento siempre lo arma, y
 * `platformContextOf` usa el token de `credentials` si falta.
 */
export type PublishContext = Omit<PlatformContext, "accessToken"> & {
  accessToken?: AccessTokenProvider;
  /** Ya descifradas (Instagram): solo en memoria, nunca en un log, un error ni la bitácora. */
  credentials: PlatformCredentials;
  /** Lo que guardó un intento anterior (`publications.progress`), para retomar sin duplicar. */
  progress: unknown | null;
  /** Guarda el progreso **antes** del paso que publica (Instagram: antes de `media_publish`). */
  saveProgress(progress: unknown): Promise<void>;
};

/**
 * Resultado de un intento: el id y el enlace en la plataforma; `simulated` en `dry-run`. `notes`:
 * advertencias que no bloquearon (las de `preflight` en `dry-run`), para la bitácora.
 */
export type PublishResult = {
  externalId: string;
  externalUrl: string | null;
  simulated: boolean;
  notes?: string[];
};

/**
 * El `PlatformContext` de un intento (para `preflight` o el publisher de Portal): su `accessToken`
 * o, si no vino, uno que entrega el token de `credentials` (sin refrescar).
 */
export function platformContextOf(ctx: PublishContext): PlatformContext {
  return {
    account: ctx.account,
    accessToken: ctx.accessToken ?? (async () => ctx.credentials.accessToken),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
}

/** Lo publicado, para operar sobre ello: el id en la plataforma y el progreso guardado. */
export type PublishedRef = { externalId: string; progress: unknown | null };

/** Lo que informa la plataforma; core le suma `checkedAt` al guardarlo (`remote_state`). */
export type RemoteStatus = Omit<RemoteState, "checkedAt">;

/**
 * Publica en una plataforma (ADR-0014, spec F3 §4.5; ampliado en ADR-0015 punto 7 y spec F4 §4.8).
 * Lo implementan los adaptadores de `packages/publishers`; en `dry-run`, `withDryRun` lo envuelve
 * y nunca llama a `publish` ni a las operaciones.
 * - `validate` es pura (sin red ni cliente de la API): la usa también `withDryRun`.
 * - `publish` recibe un input que ya pasó `checkPublishInput` (el intento la corre antes en `live`,
 *   y `withDryRun` en `dry-run`); un adaptador puede volver a revisarlo, porque es barato.
 * - `publish` lanza `AppError` con `retriable` según la plataforma; puede llamar a `saveProgress`
 *   y retomar desde `ctx.progress`.
 * - Opcionales (Portal; Instagram no los implementa): `preflight` solo lee y valida contra la
 *   plataforma (ADR-0016: nunca sube fotos, crea ni cambia estados; lo llama `withDryRun`);
 *   `pause`, `resume` y `close` cambian el estado de lo publicado (`close` es irreversible y
 *   reemplaza el `unpublish` de ADR-0014), y `getStatus` lo lee.
 */
export interface Publisher {
  readonly platform: Platform;
  /** Formatos que publica (Instagram: `post` y `reel`). */
  readonly formats: readonly PublicationFormat[];
  validate(input: PublishInput): PublishValidation;
  publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
  preflight?(input: PublishInput, ctx: PlatformContext): Promise<PublishValidation>;
  pause?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
  resume?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
  close?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
  getStatus?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
}
