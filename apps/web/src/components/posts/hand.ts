import type { Platform } from "@agentsales/core";
import { type LinkedInOpenTarget, linkedinOpenTarget } from "./linkedin.js";

// Publicar a mano en LinkedIn, X e Instagram (F9.5 y F9.6, ADR-0041): lo puro del asistente — qué
// redes lo tienen, el enlace que abre el editor con el texto puesto (donde la red lo permite) y qué
// dice cada una. Todo es un enlace normal y el portapapeles: AgentSales no automatiza el navegador.

/** Las redes que se publican a mano con el asistente de copiar. */
export const HAND_PLATFORMS = ["linkedin", "x", "instagram"] as const satisfies readonly Platform[];
export type HandPlatform = (typeof HAND_PLATFORMS)[number];

export const isHandPlatform = (platform: string): platform is HandPlatform =>
  (HAND_PLATFORMS as readonly string[]).includes(platform);

/** Cómo se llama cada red en los textos del asistente. */
export const HAND_LABEL: Readonly<Record<HandPlatform, string>> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
};

/**
 * El editor de publicación de X, vacío. **NO VERIFICADO** (`docs/integraciones/x.md`): el «Web
 * Intent» de publicar con el texto puesto (`?text=`) es el de la documentación pública de X, pero
 * no se probó en esta cuenta; el portapapeles es el respaldo.
 */
export const X_COMPOSE_URL = "https://x.com/intent/post";

/** El largo máximo del enlace entero (con el texto codificado), como el de LinkedIn. */
export const X_SHARE_URL_MAX = 1800;

/**
 * El enlace del botón y si lleva el texto (`withText`). `href: null` = la red no deja abrir el
 * editor con algo puesto (Instagram): solo se copia el texto.
 */
export type HandOpenTarget = { href: string | null; withText: boolean };

/**
 * El enlace de «Copiar texto y abrir <red>»: LinkedIn y X abren su editor con el texto ya puesto; si
 * el enlace pasa del largo máximo, el editor se abre vacío y el texto va solo por el portapapeles
 * (`withText: false`). Instagram no tiene enlace.
 */
export function handOpenTarget(platform: HandPlatform, text: string): HandOpenTarget {
  if (platform === "linkedin") {
    const target: LinkedInOpenTarget = linkedinOpenTarget(text);
    return target;
  }
  if (platform === "x") {
    const href = `${X_COMPOSE_URL}?text=${encodeURIComponent(text)}`;
    return href.length <= X_SHARE_URL_MAX
      ? { href, withText: true }
      : { href: X_COMPOSE_URL, withText: false };
  }
  return { href: null, withText: false };
}

/** Los tres pasos, en simple, de cada red. */
export function handSteps(platform: HandPlatform): string {
  const label = HAND_LABEL[platform];
  if (platform === "instagram") {
    return "1. Toca «Copiar texto» y baja las imágenes a tu teléfono. 2. Abre Instagram, crea la publicación con esas imágenes y pega el texto. 3. Vuelve y toca «Ya lo publiqué».";
  }
  return `1. Toca «Copiar texto y abrir ${label}»: se abre el editor con el texto puesto. 2. Aprieta «Publicar» en ${label} (con las imágenes del post, si tiene). 3. Vuelve y toca «Ya lo publiqué».`;
}
