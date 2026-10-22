// X (spec F9 §4.4 a §4.7 y §4.12, F9-T16; `docs/integraciones/x.md`). Las cifras salen de la doc
// oficial (DOC en la nota); lo marcado NO VERIFICADO lo confirma la prueba S4 del operador antes de
// publicar de verdad. Los precios y los límites de X cambian seguido (`x.md` §9): viven aquí y en
// `packages/core/src/social/networks.ts`, en un solo lugar cada uno.

/** El host de la API. Los tests lo dejan igual: msw intercepta `api.x.com`. */
export const X_API_ORIGIN = "https://api.x.com";

/** Donde el operador autoriza la app (`x.md` §3.1). */
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

const MB = 1024 * 1024;

/** Los límites de un post y de sus medios (`x.md` §5). */
export const X_LIMITS = {
  /** Hasta 4 imágenes, o 1 video (no se mezclan). */
  images: 4,
  videos: 1,
  /** Cada imagen: 5 MB (DOC). */
  imageBytes: 5 * MB,
  /**
   * El video: X acepta 8 GB en una cuenta normal, pero el worker lo baja a memoria. La variante
   * `x_video` (720p, F9-T10) queda muy por debajo; este tope evita bajar algo desmedido.
   */
  videoBytes: 512 * MB,
  /** Duración del video: de 0,5 s a 20 min en una cuenta normal (DOC; Premium, 125 min). */
  videoMinSeconds: 0.5,
  videoMaxSeconds: 20 * 60,
  /** Cada trozo de la subida por partes: la guía pide 5 MB o menos; los ejemplos usan 4 MB. */
  chunkBytes: 4 * MB,
} as const;

/** Los tipos de imagen que acepta X (`x.md` §5.2). */
export const X_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Tope del canje y del refresco del token: 10 s (ADR-0015 punto 11, como el de Mercado Libre). */
export const X_TOKEN_TIMEOUT_MS = 10_000;

/** Tope de cada llamada a la API (crear el post, leer el usuario, el estado de un medio). */
export const X_REQUEST_TIMEOUT_MS = 30_000;

/** Tope de cada subida de medios (una imagen o un trozo de 4 MB). */
export const X_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Tope por inactividad de la descarga de cada medio desde R2 (con su URL firmada de 1 hora): la
 * espera de la respuesta y la de cada trozo, no el total (el video se lee al ritmo de la subida).
 */
export const X_MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Cuánto se espera, como mucho, a que X procese un video después de `finalize`
 * (`processing_info`, `check_after_secs`). Pasado esto, el intento se reintenta (reutiliza el
 * medio ya subido si sigue vigente).
 */
export const X_MEDIA_PROCESSING_MAX_MS = 10 * 60_000;

/**
 * Un medio subido vence a las 24 h (`expires_after_secs`, `x.md` §5.1). Se reutiliza en un
 * reintento solo si le queda más que esto.
 */
export const X_MEDIA_REUSE_MARGIN_MS = 60 * 60_000;

/** Sin `x-rate-limit-reset`, la espera que se supone ante un 429: la ventana de 15 min de X. */
export const X_DEFAULT_RATE_LIMIT_WAIT_S = 15 * 60;
