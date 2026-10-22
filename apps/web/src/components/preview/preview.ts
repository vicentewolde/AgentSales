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

/**
 * Una foto de la vista previa; `src` en `null` si todavía no tiene imagen que mostrar, y
 * `processing` si le falta la versión que publica la red (se ve «procesando…»).
 */
export type PreviewImage = { id: string; src: string | null; processing?: boolean };

/**
 * Un video: `src` lo deja reproducir (el reel de un aviso); sin él, se ve su miniatura.
 * `processing` si le falta la versión que publica la red.
 */
export type PreviewVideo = {
  id: string;
  src: string | null;
  poster: string | null;
  processing?: boolean;
};

/**
 * Si el borrador del editor es distinto del texto guardado (el cuerpo, el título si lo tiene, o
 * los hashtags): solo entonces la vista previa dice «con tu borrador, sin guardar».
 */
export function draftDiffers(draft: PreviewText | null, saved: PreviewText | null): boolean {
  if (draft === null) return false;
  if (saved === null) return true;
  return (
    draft.body !== saved.body ||
    (draft.title ?? "") !== (saved.title ?? "") ||
    draft.hashtags.join(" ") !== saved.hashtags.join(" ")
  );
}

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
 * El mínimo de un carrusel de Instagram (`CAROUSEL_MIN_ITEMS` de `core/content/compose.ts`, que el
 * índice de core no reexporta; no se toca aquí porque es un archivo compartido entre tareas).
 */
const CAROUSEL_MIN_ITEMS = 2;

/** Los originales de un tipo, en el orden del publisher: `sortOrder` y después el id. */
const originalsOf = (media: readonly PostMediaItem[], kind: PostMediaItem["kind"]) =>
  media
    .filter((item) => item.kind === kind)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));

/**
 * Las versiones del video que publica cada red (`postPublicationPlan`): X, el video reducido
 * (`x_video`); Discord, la más liviana entre `x_video` y `ig_reel` (cualquiera de las dos sirve);
 * las demás, el `ig_reel`.
 */
const VIDEO_VARIANTS: Readonly<Record<PostPlatform, readonly PostMediaItem["variants"][number][]>> =
  {
    instagram: ["ig_reel"],
    x: ["x_video"],
    linkedin: ["ig_reel"],
    discord: ["x_video", "ig_reel"],
    tiktok: ["ig_reel"],
  };

/** Lo que el publisher rechazaría por los medios del post, dicho en la vista previa. */
export type PreviewMediaProblem = string | null;

/**
 * Los medios de un post que van a una red, como los elige el publisher (`postPublicationPlan`):
 * un texto solo, ninguno; un video, el primer video original con la versión de esa red; las
 * imágenes originales en su orden (`sortOrder` y el id) con su `ig_4x5`, hasta lo que admite la red
 * (Instagram una sola en un post de imagen y hasta 10 en un carrusel, X hasta 4, Discord hasta 10).
 * Un medio al que le falta su versión queda con `processing` («procesando…»). La foto que se ve es
 * la miniatura del medio. `problem` dice lo que el publisher rechazaría: un carrusel de Instagram
 * con menos de 2 imágenes, TikTok sin un post de video, Instagram con solo texto.
 */
export function postPreviewMedia(
  platform: PostPlatform,
  kind: PostKind,
  media: readonly PostMediaItem[],
): { images: PreviewImage[]; video: PreviewVideo | null; problem: PreviewMediaProblem } {
  const none = { images: [], video: null };
  if (platform === "tiktok" && kind !== "video") {
    return { ...none, problem: "TikTok publica solo video: cambia el tipo del post y súbelo." };
  }
  if (kind === "text") {
    return {
      ...none,
      problem: platform === "instagram" ? "Instagram necesita una imagen o un video." : null,
    };
  }
  if (kind === "video") {
    const [first] = originalsOf(media, "video");
    if (first === undefined) return { ...none, problem: null };
    const ready = VIDEO_VARIANTS[platform].some((variant) => first.variants.includes(variant));
    return {
      images: [],
      video: { id: first.id, src: null, poster: first.thumbUrl, processing: !ready },
      problem: null,
    };
  }
  const images = originalsOf(media, "image").map((item) => ({
    id: item.id,
    src: item.thumbUrl,
    processing: !item.variants.includes("ig_4x5"),
  }));
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
  const problem =
    platform === "instagram" && kind === "carousel" && images.length < CAROUSEL_MIN_ITEMS
      ? `Un carrusel lleva de ${CAROUSEL_MIN_ITEMS} a ${CAROUSEL_MAX_ITEMS} imágenes y este post tiene ${images.length}.`
      : null;
  return { images: images.slice(0, max), video: null, problem };
}
