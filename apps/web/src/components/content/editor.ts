import {
  INSTAGRAM_CAPTION_MAX_LENGTH,
  instagramCaption,
  LISTING_TITLE_MAX_LENGTH,
  normalizeHashtag,
} from "@agentsales/core";

/**
 * Los hashtags que escribe el operador (separados por espacios, comas o saltos de línea), como los
 * guardará la API: normalizados (`normalizeHashtag`), sin vacíos ni repetidos.
 */
export function parseHashtags(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .map(normalizeHashtag)
    .filter((tag): tag is string => tag !== null);
  return [...new Set(tags)];
}

/** Un contador de caracteres contra su tope (`over` si se pasa). */
export type Counter = { length: number; max: number; over: boolean };

const counter = (length: number, max: number): Counter => ({ length, max, over: length > max });

/**
 * El largo que mide la revisión (`TOO_LONG`): en Instagram el caption que se publica, con los
 * hashtags (`instagramCaption`); en los demás canales, el título. Se cuenta igual que en core.
 */
export function captionCounter(body: string, hashtags: readonly string[]): Counter {
  return counter(
    instagramCaption({ body, hashtags: [...hashtags] }).length,
    INSTAGRAM_CAPTION_MAX_LENGTH,
  );
}

export function titleCounter(title: string): Counter {
  return counter(title.length, LISTING_TITLE_MAX_LENGTH);
}
