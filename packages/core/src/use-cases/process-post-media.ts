import type { AbortSignalLike } from "../abort.js";
import { videosOf } from "../content/compose.js";
import { postVariantPath, postVideoPath } from "../content/media-keys.js";
import type { ProcessedMediaVariant, VideoMediaVariant } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { Media } from "../media.js";
import {
  DISCORD_FILE_MAX_BYTES,
  DISCORD_VIDEO_MAX_BYTES,
  discordVideoBitrateKbps,
  REEL_MIN_DURATION_S,
} from "../media-checks.js";
import { resolveReelMusic } from "../music/reel-music.js";
import type {
  ImageOutput,
  ImageVariant,
  MediaProcessor,
  VideoOutput,
} from "../ports/media-processor.js";
import type { MediaRepository, NewDerivative } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostRepository } from "../ports/post-repository.js";
import { postPublishesOn } from "../social/post-networks.js";
import { postSubject } from "../subject.js";

// Las variantes de los medios de un post (spec F9 §4.5, F9-T10), con el procesador de siempre
// (`MediaProcessor`): de una foto, `thumb` e `ig_4x5`; de un video, `thumb`, el reel 9:16 (sin
// texto encima y hasta 90 s; desde 3 s) y el video reducido para X (`x_video`). Sin `pi_4x3`: un
// post no va a Portal ni a Marketplace. Lo vigente es lo de la clave de la versión actual del
// procesador: una vuelta solo arma lo que falta, así reintentar o encolar dos veces no repite.
// Desde F9.5 (D8), si el post va a Discord y el video más liviano (`x_video` o `ig_reel`) de su
// primer video no cabe en sus 20 MiB, además el video liviano para Discord (`discord_video`, bajo
// 19 MiB). Desde F9.5-T19, la música elegida del post va en todos esos videos (todas las redes) y
// en su clave: cambiarla los rehace; sin música, las claves de siempre.

/** Las variantes JPEG de una foto de un post. */
export const POST_PHOTO_VARIANTS = ["thumb", "ig_4x5"] as const satisfies readonly ImageVariant[];

export type ProcessPostMediaDeps = {
  posts: Pick<PostRepository, "get">;
  media: Pick<
    MediaRepository,
    "listBySubject" | "updateMeasurements" | "upsertDerivative" | "deleteDerivative"
  >;
  storage: Pick<MediaStorage, "get" | "getStream" | "head" | "put" | "putStream" | "delete">;
  /** El procesador del intento, con su directorio temporal (el worker lo borra al terminar). */
  processor: MediaProcessor;
  /** Un objeto viejo que no se pudo borrar de R2 (queda sin uso); solo para el log. */
  onCleanupFailed?: (objectPath: string, error: unknown) => void;
  /**
   * Los topes del video para Discord (D8 de F9.5): desde cuánto pesa el video más liviano para que
   * haga falta (`fileMaxBytes`) y bajo cuánto debe quedar (`videoMaxBytes`). Por defecto, los de
   * Discord (`DISCORD_FILE_MAX_BYTES` y `DISCORD_VIDEO_MAX_BYTES`); los tests los achican.
   */
  discordLimits?: { fileMaxBytes: number; videoMaxBytes: number };
  /**
   * El primer video no quedó con su video para Discord aunque hacía falta: `too_long` (por su
   * duración, el bitrate quedaría bajo el mínimo; no se leyó), `not_fitting` (el procesador no
   * pudo dejarlo bajo el tope) o `failed` (la pasada falló; el original no queda como ilegible).
   * Solo para el log.
   */
  onDiscordVideoMissing?: (
    mediaId: string,
    reason: "too_long" | "not_fitting" | "failed",
    error?: unknown,
  ) => void;
};

export type ProcessPostMediaResult =
  | { outcome: "skipped"; reason: "not_found" | "archived" }
  | {
      outcome: "processed";
      /** Originales a los que se les armó algo, que ya estaban al día y que no se pudieron leer. */
      media: { processed: number; existing: number; failed: number };
      /** Los originales que no se pudieron leer (formato no válido o archivo dañado). */
      failedMediaIds: string[];
      /**
       * Avisos para el operador (F9.5-T19): la música elegida no está en la biblioteca o no se
       * subió a R2, y los videos quedaron sin música. El job los deja en el log.
       */
      warnings: string[];
    };

const isDecodeFailed = (error: unknown) =>
  isAppError(error) && error.code === "MEDIA_DECODE_FAILED";

const variantOf = (all: readonly Media[], parentId: string, variant: ProcessedMediaVariant) =>
  all.find(
    (item) =>
      item.role === "processed" && item.parentMediaId === parentId && item.variant === variant,
  ) ?? null;

/**
 * Arma las variantes que le faltan a cada original del post. Un original ilegible queda en
 * `failedMediaIds` y los demás siguen; un error de R2 o de la base sube (el job reintenta). Un post
 * que no existe o está archivado no se procesa. `MEDIA_ABORTED` (el apagado) sube reintentable.
 */
export async function processPostMedia(
  deps: ProcessPostMediaDeps,
  { postId, signal }: { postId: string; signal?: AbortSignalLike },
): Promise<ProcessPostMediaResult> {
  const post = await deps.posts.get(postId);
  if (post === null) return { outcome: "skipped", reason: "not_found" };
  if (post.status === "archived") return { outcome: "skipped", reason: "archived" };
  const version = deps.processor.version;
  const all = await deps.media.listBySubject(postSubject(postId));
  const originals = all
    .filter((item) => item.role === "original")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const counts = { processed: 0, existing: 0, failed: 0 };
  const failedMediaIds: string[] = [];
  const discordLimits = deps.discordLimits ?? {
    fileMaxBytes: DISCORD_FILE_MAX_BYTES,
    videoMaxBytes: DISCORD_VIDEO_MAX_BYTES,
  };
  const forDiscord = postPublishesOn(post, "discord");
  // La música de sus videos (F9.5-T19), solo si tiene videos: si no se puede usar, sin música y un
  // aviso. Va en la clave de cada video derivado (sin música, la clave de siempre).
  const warnings: string[] = [];
  const resolved = originals.some((item) => item.kind === "video")
    ? await resolveReelMusic(deps.storage, post.musicTrackId)
    : { music: null, warning: null };
  if (resolved.warning !== null) warnings.push(resolved.warning);
  const music = resolved.music;
  const musicId = music?.track.id ?? null;
  const musicOption = async () => (music === null ? {} : { music: await music.input() });

  /** Sube un derivado, lo registra y borra el objeto anterior si la clave cambió. */
  const save = async (upload: () => Promise<void>, derivative: NewDerivative) => {
    await upload();
    const { previousPath } = await deps.media.upsertDerivative(derivative);
    if (previousPath !== null && previousPath !== derivative.storagePath) {
      await deps.storage
        .delete(previousPath)
        .catch((error: unknown) => deps.onCleanupFailed?.(previousPath, error));
    }
  };
  const base = (original: Media) => ({
    role: "processed" as const,
    parentMediaId: original.id,
    postId,
    brokerId: original.brokerId,
  });
  const saveImage = (original: Media, output: ImageOutput) => {
    const storagePath = postVariantPath(postId, output.variant, original.checksum, version);
    return save(() => deps.storage.put(storagePath, output.bytes, output.mime), {
      ...base(original),
      variant: output.variant,
      kind: "image",
      storagePath,
      mime: output.mime,
      bytes: output.bytes.length,
      checksum: output.sha256,
      width: output.width,
      height: output.height,
      durationS: null,
    });
  };
  const saveVideo = (original: Media, variant: VideoMediaVariant, output: VideoOutput) => {
    const storagePath = postVideoPath(postId, variant, original.checksum, version, musicId);
    return save(
      () =>
        deps.storage.putStream(storagePath, output.open(), {
          contentType: "video/mp4",
          contentLength: output.size,
          sha256: output.sha256,
        }),
      {
        ...base(original),
        variant,
        kind: "video",
        storagePath,
        mime: "video/mp4",
        bytes: output.size,
        checksum: output.sha256,
        width: output.width,
        height: output.height,
        durationS: output.durationS,
      },
    );
  };
  /** Borra un derivado que ya no corresponde (un reel de un video de menos de 3 s). */
  const drop = async (media: Media | null) => {
    if (media === null) return;
    const path = await deps.media.deleteDerivative(media.id);
    if (path !== null) {
      await deps.storage
        .delete(path)
        .catch((error: unknown) => deps.onCleanupFailed?.(path, error));
    }
  };

  /**
   * El video liviano para Discord (D8 de F9.5), solo del primer video del post (el único que usa
   * Discord): si el post va a Discord, el más liviano entre `x_video` e `ig_reel` no cabe y no está
   * ya armado. Se pide aparte (otra lectura del original) porque el peso de los demás se sabe recién
   * después de armarlos; no se lee si por su duración ya se sabe que el bitrate quedaría bajo el
   * mínimo legible. Si no se puede, o la pasada falla (salvo el apagado), no queda variante y
   * Discord publica el texto solo. Devuelve si leyó el original.
   */
  const discordPass = async (
    original: Media,
    lightest: number | null,
    durationS: number | null,
  ): Promise<boolean> => {
    const path = postVideoPath(postId, "discord_video", original.checksum, version, musicId);
    if (!forDiscord || variantOf(all, original.id, "discord_video")?.storagePath === path) {
      return false;
    }
    if (lightest === null || lightest <= discordLimits.fileMaxBytes) return false;
    // Sin saber si tiene audio, se mira el caso más holgado (sin audio): solo se salta lo imposible.
    if (
      durationS !== null &&
      discordVideoBitrateKbps({
        durationS,
        hasAudio: false,
        maxBytes: discordLimits.videoMaxBytes,
      }) === null
    ) {
      deps.onDiscordVideoMissing?.(original.id, "too_long");
      return false;
    }
    try {
      const stream = await deps.storage.getStream(
        original.storagePath,
        signal === undefined ? {} : { signal },
      );
      const result = await deps.processor.processVideo(
        stream,
        {
          reel: null,
          xVideo: false,
          discordVideo: { maxBytes: discordLimits.videoMaxBytes },
          ...(await musicOption()),
        },
        signal,
      );
      if (result.discordVideo === null) {
        deps.onDiscordVideoMissing?.(original.id, "not_fitting");
      } else {
        await saveVideo(original, "discord_video", result.discordVideo);
      }
    } catch (error) {
      if (isAppError(error) && error.code === "MEDIA_ABORTED") throw error;
      deps.onDiscordVideoMissing?.(original.id, "failed", error);
    }
    return true;
  };
  const firstVideoId = videosOf(all)[0]?.id ?? null;

  for (const original of originals) {
    if (signal?.aborted) {
      throw new AppError("MEDIA_ABORTED", "Se cortó el procesamiento de medios", {
        retriable: true,
      });
    }
    const current = (variant: ProcessedMediaVariant, path: string) =>
      variantOf(all, original.id, variant)?.storagePath === path;
    let video: { worked: boolean; durationS: number | null; lightest: number | null };
    try {
      if (original.kind === "image") {
        const missing = POST_PHOTO_VARIANTS.filter(
          (variant) =>
            !current(variant, postVariantPath(postId, variant, original.checksum, version)),
        );
        if (missing.length === 0 && original.width !== null) {
          counts.existing += 1;
          continue;
        }
        const bytes = await deps.storage.get(original.storagePath);
        const result = await deps.processor.processImage(
          bytes,
          { mime: original.mime, variants: missing },
          signal,
        );
        await deps.media.updateMeasurements(original.id, result.measurements);
        for (const output of result.outputs) await saveImage(original, output);
        counts.processed += 1;
        continue;
      }

      // Un video ya medido y de menos de 3 s no da reel (como el de un aviso).
      const tooShort = original.durationS !== null && original.durationS < REEL_MIN_DURATION_S;
      const reelPath = postVideoPath(postId, "ig_reel", original.checksum, version, musicId);
      const xPath = postVideoPath(postId, "x_video", original.checksum, version, musicId);
      const thumbOk = current(
        "thumb",
        postVariantPath(postId, "thumb", original.checksum, version),
      );
      const reelOk = tooShort || current("ig_reel", reelPath);
      const xOk = current("x_video", xPath);
      // El peso de los videos vigentes (`x_video` e `ig_reel`): el más liviano decide si hace falta
      // el de Discord. Los que se arman en esta vuelta lo actualizan.
      const sizes = new Map<VideoMediaVariant, number>();
      for (const [variant, path] of [
        ["ig_reel", reelPath],
        ["x_video", xPath],
      ] as const) {
        const existing = variantOf(all, original.id, variant);
        if (existing?.storagePath === path) sizes.set(variant, existing.bytes);
      }
      let worked = false;
      let durationS = original.durationS;
      if (thumbOk && reelOk && xOk && original.durationS !== null) {
        if (tooShort) {
          await drop(variantOf(all, original.id, "ig_reel"));
          sizes.delete("ig_reel");
        }
      } else {
        const stream = await deps.storage.getStream(
          original.storagePath,
          signal === undefined ? {} : { signal },
        );
        const result = await deps.processor.processVideo(
          stream,
          {
            reel: reelOk ? null : { overlayPng: null },
            xVideo: !xOk,
            ...(reelOk && xOk ? {} : await musicOption()),
          },
          signal,
        );
        await deps.media.updateMeasurements(original.id, result.measurements);
        durationS = result.measurements.durationS;
        if (!thumbOk) await saveImage(original, result.thumb);
        const reel = result.reel;
        if (reel !== null) {
          await saveVideo(original, "ig_reel", reel);
          sizes.set("ig_reel", reel.size);
        } else if (!reelOk) {
          await drop(variantOf(all, original.id, "ig_reel"));
          sizes.delete("ig_reel");
        }
        if (result.xVideo !== null) {
          await saveVideo(original, "x_video", result.xVideo);
          sizes.set("x_video", result.xVideo.size);
        }
        worked = true;
      }
      video = {
        worked,
        durationS,
        lightest: sizes.size === 0 ? null : Math.min(...sizes.values()),
      };
    } catch (error) {
      if (!isDecodeFailed(error)) throw error;
      counts.failed += 1;
      failedMediaIds.push(original.id);
      continue;
    }

    // Aparte del resto: un fallo de esta pasada no hace ilegible al original.
    const discordRead =
      original.id === firstVideoId &&
      (await discordPass(original, video.lightest, video.durationS));
    if (video.worked || discordRead) counts.processed += 1;
    else counts.existing += 1;
  }
  return { outcome: "processed", media: counts, failedMediaIds, warnings };
}
