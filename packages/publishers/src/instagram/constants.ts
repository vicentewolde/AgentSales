import {
  CAROUSEL_MAX_ITEMS,
  INSTAGRAM_CAPTION_MAX_LENGTH,
  INSTAGRAM_PUBLISH_SCOPE,
} from "@agentsales/core";

// Constantes de la plataforma (spec F3 §4.5, nota `docs/integraciones/instagram.md`): un solo
// archivo, para revisarlas juntas cuando Meta cambie algo.

/** Versión fija de la Graph API (nota §4): se cambia a propósito, con la prueba de la nota §8. */
export const INSTAGRAM_GRAPH_VERSION = "v25.0";
/** Host de la API con Instagram Login (no `graph.facebook.com`). */
export const INSTAGRAM_GRAPH_ORIGIN = "https://graph.instagram.com";
/** Pantalla de permisos del OAuth (nota §3.1). */
export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
/** Canje del código por el token corto (nota §3.2): otro host, sin versión. */
export const INSTAGRAM_CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
/** Permisos que pide F3 (nota §2): leer la cuenta y publicar (este, de core). */
export const INSTAGRAM_SCOPES = ["instagram_business_basic", INSTAGRAM_PUBLISH_SCOPE] as const;

/** Tope de cada llamada: después, `IG_UNAVAILABLE` (reintentable). */
export const INSTAGRAM_REQUEST_TIMEOUT_MS = 30_000;

/** Límites del contenido (nota §5 y §6). El caption reutiliza el tope de core. */
export const INSTAGRAM_LIMITS = {
  /** Un carrusel tiene de 2 a 10 ítems; con 1 se publica como imagen suelta. */
  carouselMinItems: 2,
  carouselMaxItems: CAROUSEL_MAX_ITEMS,
  captionMaxLength: INSTAGRAM_CAPTION_MAX_LENGTH,
  hashtagsMax: 30,
  mentionsMax: 20,
  /** Imágenes JPEG de menos de 8 MiB. */
  imageMaxBytes: 8 * 1024 * 1024,
} as const;

/**
 * Ritmo del sondeo de un contenedor (nota §11.8): a los 5, 10, 20 y 30 s, y después cada 60 s hasta
 * los 5 min; si no termina, `IG_CONTAINER_TIMEOUT`.
 */
export const INSTAGRAM_POLL = {
  firstDelaysMs: [5_000, 10_000, 20_000, 30_000],
  intervalMs: 60_000,
  maxWaitMs: 5 * 60_000,
} as const;

/** Cuadro del reel que se usa de portada: el segundo 1, con el texto del reel (spec F3, D12). */
export const INSTAGRAM_REEL_THUMB_OFFSET_MS = 1_000;
