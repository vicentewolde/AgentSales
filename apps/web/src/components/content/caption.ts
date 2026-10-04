import type { ContentView } from "@agentsales/api/contracts";
import { instagramCaption } from "@agentsales/core";

/** Lo que Instagram muestra del caption antes de "más" (unos 125 caracteres). */
export const CAPTION_PREVIEW_LENGTH = 125;

/**
 * El caption que se publica (`instagramCaption`, con los hashtags) y su comienzo para la vista
 * previa, cortado por caracteres visibles: un emoji no queda partido por la mitad.
 */
export function captionPreview(content: Pick<ContentView, "body" | "hashtags">): {
  full: string;
  preview: string | null;
} {
  const full = instagramCaption(content);
  const chars = Array.from(full);
  if (chars.length <= CAPTION_PREVIEW_LENGTH) return { full, preview: null };
  return { full, preview: `${chars.slice(0, CAPTION_PREVIEW_LENGTH).join("").trimEnd()}…` };
}
