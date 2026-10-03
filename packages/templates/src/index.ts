import type { SlideTemplates } from "@agentsales/core";
import { interFontCss } from "./fonts.js";
import { coverHtml, reelOverlayHtml, specSheetHtml } from "./slides.js";

/**
 * Versión del diseño de las plantillas: entra en la clave de R2 de la portada, la ficha y el reel
 * (spec F2 §4.2). Cambiar el HTML o el CSS de forma visible la sube, y la siguiente corrida rehace
 * esas imágenes.
 */
export const TEMPLATES_VERSION = "1";

/**
 * Las plantillas de la portada, la ficha y el texto del reel (puerto `SlideTemplates`): HTML
 * autocontenido, con Inter incrustada. Lee la fuente una vez, al crearlas.
 */
export function createSlideTemplates(): SlideTemplates {
  const fontCss = interFontCss();
  return {
    version: TEMPLATES_VERSION,
    cover: (data) => coverHtml(data, fontCss),
    specSheet: (data) => specSheetHtml(data, fontCss),
    reelOverlay: (data) => reelOverlayHtml(data, fontCss),
  };
}
