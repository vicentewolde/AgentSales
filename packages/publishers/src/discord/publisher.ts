import {
  type AbortSignalLike,
  checkPublishInput,
  type DirectPublisher,
  discordAccountMetaSchema,
  discordMessageUrl,
  discordWebhookParts,
  neutralizeDiscordMentions,
  type PublishContext,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishValidation,
  pendingSend,
  sendOnce,
} from "@agentsales/core";
import {
  DISCORD_LIMITS,
  DISCORD_MEDIA_TIMEOUT_MS,
  DISCORD_RATE_LIMIT_INLINE,
} from "./constants.js";
import { DISCORD_ERRORS, isDiscordNotSent } from "./errors.js";
import {
  createDiscordWebhooks,
  type DiscordFile,
  type DiscordMessage,
  type DiscordWebhookClient,
} from "./webhook.js";

/** Lo que pasa en un intento y va al log del worker: solo códigos y cifras, nunca la URL. */
export type DiscordPublishNote = { publicationId: string } & (
  | { kind: "rate_limited_wait"; retryAfterS: number; attempt: number }
  | { kind: "video_not_attached"; mediaId: string; bytes: number }
);

export type DiscordPublisherOptions = {
  /** Por defecto `createDiscordWebhooks()`. */
  client?: DiscordWebhookClient;
  /**
   * Baja un medio de R2 por su URL firmada (de 1 hora, recién creada en el intento); por defecto con
   * `fetch` y un tope. Nunca pone la URL en un error.
   */
  download?: (item: PublishMediaItem, options: { signal?: AbortSignalLike }) => Promise<Uint8Array>;
  /** La espera de un 429 corto (para los tests). */
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  onNote?: (note: DiscordPublishNote) => void;
};

/**
 * `@everyone` y `@here` neutralizados (`neutralizeDiscordMentions` de core, la misma que mide la
 * revisión del texto). Además, cada envío lleva `allowed_mentions: { parse: [] }`
 * (`DISCORD_ALLOWED_MENTIONS`): ninguna mención avisa a nadie.
 */
export const neutralizeMassMentions = neutralizeDiscordMentions;

/** La nota (bitácora) de un video que no cabe en Discord y no se adjunta (D8). */
export const DISCORD_VIDEO_NOT_ATTACHED_NOTE =
  "El video pesa más de los 20 MiB que acepta Discord: se publica solo el texto, sin enlace al video (no hay un enlace estable que no exponga una URL firmada); súbelo a mano al canal si hace falta";

/**
 * Qué medios van adjuntos (spec F9 §4.5, D8): las imágenes siempre (si una no cabe, `validate` lo
 * rechaza); el video, solo si pesa hasta 20 MiB y la solicitud completa no pasa de su tope. Si no
 * cabe, no se adjunta y `videoLeftOut` lo dice: hoy no hay un enlace al video que se pueda publicar
 * sin exponer una URL firmada de larga vida (R2 no tiene un dominio público), así que se publica el
 * texto solo, con la nota en la bitácora (`DISCORD_VIDEO_NOT_ATTACHED_NOTE`).
 */
export function discordAttachments(input: Pick<PublishInput, "media">): {
  files: PublishMediaItem[];
  videoLeftOut: PublishMediaItem | null;
} {
  const images = input.media.filter((item) => item.kind !== "video");
  const imageBytes = images.reduce((sum, item) => sum + item.bytes, 0);
  const files = [...images];
  let videoLeftOut: PublishMediaItem | null = null;
  let total = imageBytes;
  for (const video of input.media.filter((item) => item.kind === "video")) {
    if (
      video.bytes <= DISCORD_LIMITS.fileBytes &&
      total + video.bytes <= DISCORD_LIMITS.requestBytes &&
      files.length < DISCORD_LIMITS.files
    ) {
      files.push(video);
      total += video.bytes;
    } else {
      videoLeftOut ??= video;
    }
  }
  // En el orden en que se fijaron.
  files.sort((a, b) => input.media.indexOf(a) - input.media.indexOf(b));
  return { files, videoLeftOut };
}

/**
 * Lo que Discord no aceptaría (pura, sin red; la usa también `withDryRun`): el texto ya neutralizado
 * hasta 2.000 caracteres, hasta 10 archivos, cada imagen hasta 20 MiB y todas juntas bajo el tope
 * de la solicitud, y que el mensaje no quede vacío (sin texto y sin nada que adjuntar). Un video que
 * no cabe no es un problema: se deja fuera (`discordAttachments`).
 */
export function validateDiscordInput(input: PublishInput): PublishValidation {
  const issues: PublishIssue[] = [];
  const content = neutralizeMassMentions(input.caption);
  if (content.length > DISCORD_LIMITS.contentChars) {
    issues.push({
      code: "DISCORD_TEXT_TOO_LONG",
      message: `El texto pasa de los ${DISCORD_LIMITS.contentChars.toLocaleString("es-CL")} caracteres de Discord`,
    });
  }
  if (input.media.length > DISCORD_LIMITS.files) {
    issues.push({
      code: "DISCORD_TOO_MANY_FILES",
      message: `Discord admite hasta ${DISCORD_LIMITS.files} archivos por mensaje`,
    });
  }
  const images = input.media.filter((item) => item.kind !== "video");
  if (images.some((item) => item.bytes > DISCORD_LIMITS.fileBytes)) {
    issues.push({
      code: "DISCORD_FILE_TOO_LARGE",
      message: "Una imagen pesa más de los 20 MiB que acepta Discord",
    });
  } else if (images.reduce((sum, item) => sum + item.bytes, 0) > DISCORD_LIMITS.requestBytes) {
    issues.push({
      code: "DISCORD_REQUEST_TOO_LARGE",
      message: "Las imágenes juntas pesan más de lo que acepta un mensaje de Discord",
    });
  }
  if (content.trim() === "" && discordAttachments(input).files.length === 0) {
    issues.push({
      code: "DISCORD_EMPTY_MESSAGE",
      message: "El mensaje quedaría vacío: falta el texto (el video no cabe en Discord)",
    });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** El nombre de un adjunto: neutro (sin la ruta de R2) y con la extensión de su tipo. */
function filenameOf(item: PublishMediaItem, index: number): string {
  const extension =
    item.mime === "image/png"
      ? "png"
      : item.mime === "image/webp"
        ? "webp"
        : item.mime === "video/mp4"
          ? "mp4"
          : item.mime === "video/quicktime"
            ? "mov"
            : "jpg";
  return `${item.kind === "video" ? "video" : "imagen"}-${index + 1}.${extension}`;
}

/**
 * Baja un medio por su URL firmada, con tope de tiempo y de tamaño (20 MiB: lo que no cabe ya quedó
 * fuera). Ningún error lleva la URL: `DISCORD_MEDIA_UNAVAILABLE` (reintentable; no se envió nada).
 */
export async function downloadMedia(
  item: PublishMediaItem,
  { signal }: { signal?: AbortSignalLike } = {},
): Promise<Uint8Array> {
  if (signal?.aborted) throw DISCORD_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(DISCORD_MEDIA_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(item.url, {
        redirect: "error",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch {
      if (caller.signal.aborted) throw DISCORD_ERRORS.aborted();
      throw DISCORD_ERRORS.mediaUnavailable(item.mediaId, timeout.aborted ? "timeout" : "network");
    }
    if (!response.ok) {
      throw DISCORD_ERRORS.mediaUnavailable(item.mediaId, `http_${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > DISCORD_LIMITS.fileBytes) {
      throw DISCORD_ERRORS.mediaUnavailable(item.mediaId, "too_large");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      if (caller.signal.aborted) throw DISCORD_ERRORS.aborted();
      throw DISCORD_ERRORS.mediaUnavailable(item.mediaId, "network");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > DISCORD_LIMITS.fileBytes) {
      throw DISCORD_ERRORS.mediaUnavailable(item.mediaId, "size");
    }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Espera `ms` o corta con la señal (`DISCORD_ABORTED`). */
function abortableSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(DISCORD_ERRORS.aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(DISCORD_ERRORS.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** El servidor del mensaje: el que trae la respuesta o el que se guardó al conectar. */
function guildIdOf(message: DiscordMessage, ctx: Pick<PublishContext, "account">): string | null {
  if (message.guildId !== null) return message.guildId;
  const meta = discordAccountMetaSchema.safeParse(ctx.account.meta);
  return meta.success ? meta.data.guildId : null;
}

/**
 * Publisher de Discord por webhook de canal (spec F9 §4.4 a §4.6, D7 y D8; F9-T14):
 * 1. revisa el input (`validateDiscordInput`) y lee la URL del webhook de las credenciales
 *    (`{ webhookUrl }`; si falta o no es de un webhook, `CREDENTIALS_INVALID`);
 * 2. si el progreso no tiene un envío anterior, baja de R2 los medios que caben
 *    (`discordAttachments`), **antes** de marcar "enviando": un fallo al bajarlos no deja nada dudoso;
 * 3. publica **una vez** con `sendOnce` (ADR-0029 punto 8): Execute Webhook con `?wait=true`, el
 *    texto con `@everyone`/`@here` neutralizados, `allowed_mentions: { parse: [] }` y los archivos
 *    en `multipart`. Un 429 con una espera corta se espera y se repite dentro del mismo envío (no
 *    creó nada); uno largo sube como `DISCORD_RATE_LIMITED` con `waitMinutes` (core reprograma).
 *    Los errores que prueban que no salió (`DISCORD_NOT_SENT_CODES`: 4xx, o no se llegó a conectar)
 *    quitan el "enviando"; cualquier otro (corte, tope de tiempo, 5xx, una respuesta sin el mensaje)
 *    es `OUTCOME_UNKNOWN` y la publicación queda `outcome_unknown`, sin reenviar;
 * 4. devuelve el id del mensaje (`external_id`, el mismo que lee `parseDiscordMessageUrl` del
 *    enlace) y su enlace `https://discord.com/channels/<servidor>/<canal>/<mensaje>` (o `null` sin
 *    servidor conocido). Un video que no cabe deja la nota en la bitácora.
 * Ningún error, nota ni progreso lleva la URL del webhook.
 */
export function createDiscordPublisher(options: DiscordPublisherOptions = {}): DirectPublisher {
  let client = options.client;
  const download = options.download ?? downloadMedia;
  const sleep = options.sleep ?? abortableSleep;

  /** Execute Webhook, repitiendo solo ante un 429 corto (no creó el mensaje). */
  const execute = async (
    publicationId: string,
    webhookUrl: string,
    content: string,
    files: readonly DiscordFile[],
    signal?: AbortSignalLike,
  ): Promise<DiscordMessage> => {
    client ??= createDiscordWebhooks();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.execute(
          webhookUrl,
          { content, files },
          signal === undefined ? {} : { signal },
        );
      } catch (error) {
        const retryAfterS = (error as { details?: { retryAfterS?: unknown } }).details?.retryAfterS;
        const short =
          (error as { code?: unknown }).code === "DISCORD_RATE_LIMITED" &&
          typeof retryAfterS === "number" &&
          retryAfterS <= DISCORD_RATE_LIMIT_INLINE.maxWaitS &&
          attempt < DISCORD_RATE_LIMIT_INLINE.retries;
        if (!short) throw error;
        options.onNote?.({
          publicationId,
          kind: "rate_limited_wait",
          retryAfterS,
          attempt: attempt + 1,
        });
        // Cortado mientras espera: el 429 ya probó que no salió, así que sube ese (no es dudoso).
        await sleep(Math.ceil(retryAfterS * 1000), signal).catch(() => {
          throw error;
        });
      }
    }
  };

  const publisher: DirectPublisher = {
    platform: "discord",
    formats: ["post"],
    validate: validateDiscordInput,
    // Sin red (Discord no tiene un "validar" que no publique): en `dry-run`, deja en la bitácora la
    // nota del video que no cabría.
    async preflight(input) {
      const validation = validateDiscordInput(input);
      if (!validation.ok) return validation;
      return discordAttachments(input).videoLeftOut === null
        ? { ok: true }
        : { ok: true, notes: [DISCORD_VIDEO_NOT_ATTACHED_NOTE] };
    },
    async publish(input, ctx) {
      checkPublishInput(publisher, input);
      if (ctx.signal?.aborted) throw DISCORD_ERRORS.aborted();
      const webhookUrl = ctx.credentials?.webhookUrl;
      // Antes de "enviando": una URL guardada que no es la de un webhook no llega a `send` (ahí
      // quedaría dudosa sin haber salido nada).
      if (typeof webhookUrl !== "string") throw DISCORD_ERRORS.webhookMissing();
      try {
        discordWebhookParts(webhookUrl);
      } catch {
        throw DISCORD_ERRORS.webhookMissing();
      }
      const content = neutralizeMassMentions(input.caption);
      const { files: attached, videoLeftOut } = discordAttachments(input);

      // Con un envío anterior (dudoso o ya hecho), `sendOnce` decide sin llamar: no se baja nada.
      const fresh = pendingSend(ctx.progress).kind === "none";
      const files: DiscordFile[] = [];
      if (fresh) {
        for (const [index, item] of attached.entries()) {
          files.push({
            filename: filenameOf(item, index),
            mime: item.mime,
            bytes: await download(item, ctx.signal === undefined ? {} : { signal: ctx.signal }),
          });
        }
      }
      const sent = await sendOnce(ctx, {
        notSent: isDiscordNotSent,
        send: async () => {
          const message = await execute(
            input.publicationId,
            webhookUrl,
            content,
            files,
            ctx.signal,
          );
          const guildId = guildIdOf(message, ctx);
          return {
            externalId: message.id,
            externalUrl:
              guildId === null ? null : discordMessageUrl(guildId, message.channelId, message.id),
          };
        },
      });
      if (videoLeftOut !== null) {
        options.onNote?.({
          publicationId: input.publicationId,
          kind: "video_not_attached",
          mediaId: videoLeftOut.mediaId,
          bytes: videoLeftOut.bytes,
        });
      }
      return {
        ...sent,
        simulated: false,
        ...(videoLeftOut === null ? {} : { notes: [DISCORD_VIDEO_NOT_ATTACHED_NOTE] }),
      };
    },
  };
  return publisher;
}
