import { instagramCaption } from "@agentsales/core";
import { cutText, INSTAGRAM_CUT, type PreviewText } from "../preview/preview.js";

/** Lo que Instagram muestra del caption antes de "más" (unos 125 caracteres). */
export const CAPTION_PREVIEW_LENGTH = INSTAGRAM_CUT.chars;

/**
 * El caption que se publica (`instagramCaption`, con los hashtags) y su comienzo para la vista
 * previa (`cutText`: hasta dos líneas o 125 caracteres visibles; un emoji no queda partido por la
 * mitad).
 */
export function captionPreview(content: Pick<PreviewText, "body" | "hashtags">): {
  full: string;
  preview: string | null;
} {
  const full = instagramCaption({ body: content.body, hashtags: [...content.hashtags] });
  return { full, preview: cutText(full, INSTAGRAM_CUT) };
}
