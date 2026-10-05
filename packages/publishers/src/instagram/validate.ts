import {
  type PublishInput,
  type PublishIssue,
  type PublishValidation,
  REEL_MAX_DURATION_S,
  REEL_MIN_DURATION_S,
} from "@agentsales/core";
import { INSTAGRAM_LIMITS } from "./constants.js";

/** Proporción que Meta acepta en el feed (nota §5): de 4:5 a 1,91:1, con un margen de redondeo. */
const ASPECT_MIN = 4 / 5 - 0.01;
const ASPECT_MAX = 1.91 + 0.01;
/** El reel se corta en 90 s; el contenedor MP4 puede durar unas centésimas más. */
const REEL_DURATION_MARGIN_S = 0.5;

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const MENTION = /(?:^|[^\p{L}\p{N}_.@])@[\p{L}\p{N}_.]+/gu;

const issue = (code: string, message: string): PublishIssue => ({ code, message });

/**
 * Requisitos de Instagram antes de llamar (spec F3 §4.5, nota §5 y §11.10). Función pura, sin red
 * ni cliente: la usan el publisher y `withDryRun`. Un `post` es una imagen suelta (1) o un carrusel
 * (2 a 10) de JPEG de menos de 8 MB con proporción de 4:5 a 1,91:1; un `reel`, un MP4 de 3 a 90 s
 * (D7). El caption tiene tope de largo, de hashtags y de menciones. Los mensajes van en español y
 * sin datos del aviso.
 */
export function validateInstagramInput(input: PublishInput): PublishValidation {
  const issues = [
    ...(input.format === "reel" ? reelIssues(input) : postIssues(input)),
    ...captionIssues(input.caption),
  ];
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function postIssues({ media }: PublishInput): PublishIssue[] {
  if (media.length === 0) return [issue("NO_MEDIA", "La publicación no tiene imágenes")];
  const issues: PublishIssue[] = [];
  if (media.length > INSTAGRAM_LIMITS.carouselMaxItems) {
    issues.push(
      issue(
        "TOO_MANY_ITEMS",
        `El carrusel tiene más de ${INSTAGRAM_LIMITS.carouselMaxItems} imágenes`,
      ),
    );
  }
  if (media.some((item) => item.kind !== "image" || item.mime !== "image/jpeg")) {
    issues.push(issue("NOT_JPEG", "El carrusel solo admite imágenes JPEG"));
  }
  if (media.some((item) => item.bytes >= INSTAGRAM_LIMITS.imageMaxBytes)) {
    issues.push(issue("IMAGE_TOO_LARGE", "Una imagen pesa 8 MB o más"));
  }
  const outOfRange = media.some((item) => {
    if (item.width === null || item.height === null || item.height === 0) return false;
    const ratio = item.width / item.height;
    return ratio < ASPECT_MIN || ratio > ASPECT_MAX;
  });
  if (outOfRange) {
    issues.push(issue("BAD_ASPECT_RATIO", "Una imagen tiene una proporción fuera de 4:5 a 1,91:1"));
  }
  return issues;
}

function reelIssues({ media }: PublishInput): PublishIssue[] {
  const [video, ...rest] = media;
  if (video === undefined || rest.length > 0) {
    return [issue("REEL_NEEDS_ONE_VIDEO", "El reel debe tener exactamente un video")];
  }
  const issues: PublishIssue[] = [];
  if (video.kind !== "video" || video.mime !== "video/mp4") {
    issues.push(issue("NOT_MP4", "El reel debe ser un video MP4"));
  }
  if (video.durationS === null) {
    issues.push(issue("REEL_DURATION_UNKNOWN", "No se conoce la duración del reel"));
  } else if (video.durationS < REEL_MIN_DURATION_S) {
    issues.push(issue("REEL_TOO_SHORT", `El reel dura menos de ${REEL_MIN_DURATION_S} s`));
  } else if (video.durationS > REEL_MAX_DURATION_S + REEL_DURATION_MARGIN_S) {
    issues.push(issue("REEL_TOO_LONG", `El reel dura más de ${REEL_MAX_DURATION_S} s`));
  }
  return issues;
}

function captionIssues(caption: string): PublishIssue[] {
  const issues: PublishIssue[] = [];
  if (caption.length > INSTAGRAM_LIMITS.captionMaxLength) {
    issues.push(
      issue(
        "CAPTION_TOO_LONG",
        `El caption supera los ${INSTAGRAM_LIMITS.captionMaxLength.toLocaleString("es-CL")} caracteres`,
      ),
    );
  }
  if ((caption.match(HASHTAG) ?? []).length > INSTAGRAM_LIMITS.hashtagsMax) {
    issues.push(
      issue(
        "TOO_MANY_HASHTAGS",
        `El caption tiene más de ${INSTAGRAM_LIMITS.hashtagsMax} hashtags`,
      ),
    );
  }
  if ((caption.match(MENTION) ?? []).length > INSTAGRAM_LIMITS.mentionsMax) {
    issues.push(
      issue(
        "TOO_MANY_MENTIONS",
        `El caption menciona a más de ${INSTAGRAM_LIMITS.mentionsMax} cuentas`,
      ),
    );
  }
  return issues;
}
