import { contentLength, normalizeHashtags, type Platform } from "@agentsales/core";

/**
 * Los hashtags que escribe el operador (separados por espacios, comas o saltos de línea), como los
 * guardará la API (`normalizeHashtags`, la misma de `editContent`).
 */
export const parseHashtags = (text: string): string[] => normalizeHashtags(text.split(/[\s,]+/));

/** Un contador de caracteres contra su tope (`over` si se pasa). */
export type Counter = { length: number; max: number; over: boolean };

/**
 * Lo que mide la revisión (`TOO_LONG`), con la misma función de core (`contentLength`): en
 * Instagram el caption con los hashtags; en los demás canales, el título. El cuerpo va recortado,
 * como lo guarda la API.
 */
export function textCounter(
  platform: Platform,
  text: { title: string | null; body: string; hashtags: readonly string[] },
): Counter {
  const { length, max } = contentLength(platform, {
    title: text.title,
    body: text.body.trim(),
    hashtags: [...text.hashtags],
  });
  return { length, max, over: length > max };
}
