import type { PostMediaItem } from "@agentsales/api/contracts";
import {
  CAROUSEL_MAX_ITEMS,
  DISCORD_MAX_FILES,
  type PostKind,
  type PostPlatform,
  X_MAX_IMAGES,
} from "@agentsales/core";

// Lo que comparten las vistas previas por red (F9.5-T07, D5): cómo se corta el texto, qué medios
// lleva cada red y los tipos de las fotos y videos. Funciones puras, en un `.ts` aparte porque un
// archivo de componente solo exporta componentes.

/** Un texto como se enviará (título solo en Portal y Marketplace); también el borrador del editor. */
export type PreviewText = {
  title: string | null;
  body: string;
  hashtags: readonly string[];
};

/** Una foto de la vista previa; `src` en `null` si todavía no tiene imagen que mostrar. */
export type PreviewImage = { id: string; src: string | null };

/** Un video: `src` lo deja reproducir (el reel de un aviso); sin él, se ve su miniatura. */
export type PreviewVideo = { id: string; src: string | null; poster: string | null };

/** Dónde corta una red el texto antes de «más»: por caracteres visibles y por líneas. */
export type TextCut = { chars: number; lines: number };

/** Instagram muestra unos 125 caracteres o dos líneas del caption antes de «… más». */
export const INSTAGRAM_CUT: TextCut = { chars: 125, lines: 2 };

/** LinkedIn muestra unos 210 caracteres o tres líneas antes de «…ver más». */
export const LINKEDIN_CUT: TextCut = { chars: 210, lines: 3 };

/**
 * El comienzo de un texto como lo muestra la red antes de «más», con `…` al final, o `null` si
 * cabe entero. Corta primero por líneas y después por caracteres visibles: un emoji no queda
 * partido por la mitad.
 */
export function cutText(text: string, cut: TextCut): string | null {
  let shown = text;
  let cutOff = false;
  const lines = shown.split("\n");
  if (lines.length > cut.lines) {
    shown = lines.slice(0, cut.lines).join("\n");
    cutOff = true;
  }
  const chars = Array.from(shown);
  if (chars.length > cut.chars) {
    shown = chars.slice(0, cut.chars).join("");
    cutOff = true;
  }
  return cutOff ? `${shown.trimEnd()}…` : null;
}

/**
 * Los medios de un post que van a una red, como los elige el publisher (`postPublicationPlan`):
 * un texto solo, ninguno; un video (y siempre en TikTok), el primer video; las imágenes, en orden,
 * hasta lo que admite la red (Instagram una sola en un post de imagen y hasta 10 en un carrusel,
 * X hasta 4, Discord hasta 10). La foto que se ve es la miniatura del medio.
 */
export function postPreviewMedia(
  platform: PostPlatform,
  kind: PostKind,
  media: readonly PostMediaItem[],
): { images: PreviewImage[]; video: PreviewVideo | null } {
  if (kind === "text") return { images: [], video: null };
  if (kind === "video" || platform === "tiktok") {
    const video = media.find((item) => item.kind === "video");
    return {
      images: [],
      video: video === undefined ? null : { id: video.id, src: null, poster: video.thumbUrl },
    };
  }
  const images = media
    .filter((item) => item.kind === "image")
    .map((item) => ({ id: item.id, src: item.thumbUrl }));
  const max =
    platform === "instagram"
      ? kind === "image"
        ? 1
        : CAROUSEL_MAX_ITEMS
      : platform === "x"
        ? X_MAX_IMAGES
        : platform === "discord"
          ? DISCORD_MAX_FILES
          : images.length;
  return { images: images.slice(0, max), video: null };
}
