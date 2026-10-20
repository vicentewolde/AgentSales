// TikTok (spec F9 §4.6, D16, F9-T26; `docs/integraciones/tiktok.md`). Las cifras salen de la doc
// oficial (DOC en la nota); lo marcado NO VERIFICADO lo confirma la prueba S6 del operador antes de
// publicar de verdad.

/** La API (Content Posting, OAuth y usuario). Los tests la dejan igual: msw intercepta el host. */
export const TIKTOK_API_ORIGIN = "https://open.tiktokapis.com";

/** La autorización de Login Kit web (`tiktok.md` §4). */
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

/** Las rutas de la API (`tiktok.md` §2, §4 y §6). */
export const TIKTOK_PATHS = {
  token: "/v2/oauth/token/",
  userInfo: "/v2/user/info/",
  /** *Upload*: el video va a la bandeja del creador (`video.upload`). */
  inboxVideoInit: "/v2/post/publish/inbox/video/init/",
  status: "/v2/post/publish/status/fetch/",
} as const;

const MB = 1024 * 1024;

/** Los límites del video por `FILE_UPLOAD` (`tiktok.md` §5 y §6). */
export const TIKTOK_LIMITS = {
  /** Hasta 4 GB. */
  videoBytes: 4 * 1024 * MB,
  /** El techo de la API (10 min); el de cada creador suele ser 3 min (NO VERIFICADO sin `creator_info`). */
  videoSeconds: 600,
  /** El texto (`title`) de un video: 2.200 unidades UTF-16. En *Upload* no se envía: lo pega el operador. */
  captionChars: 2200,
  /** De 1 a 1.000 trozos. */
  maxChunks: 1000,
  /** Envíos a la bandeja pendientes por 24 h (`spam_risk_too_many_pending_share`). */
  pendingShares: 5,
} as const;

/**
 * El tamaño de cada trozo: entre 5 y 64 MB (DOC). Un video de hasta este tamaño va en un solo trozo
 * (la doc exige uno solo bajo 5 MB); uno mayor, en `floor(tamaño / trozo)` trozos, y el último se
 * lleva el resto (queda bajo 20 MiB, lejos de los 128 MB que admite el último).
 */
export const TIKTOK_CHUNK_BYTES = 10 * MB;

/** Los videos que acepta: MP4 (recomendado), MOV y WebM. */
export const TIKTOK_VIDEO_MIMES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

/** Tope de cada llamada a la API (init, estado, usuario). */
export const TIKTOK_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Tope de la renovación del token: corre dentro del candado de credenciales de la cuenta
 * (ADR-0029 punto 11), así que es corto, como el de Mercado Libre.
 */
export const TIKTOK_REFRESH_TIMEOUT_MS = 10_000;

/** Tope de cada trozo: bajarlo de R2 y subirlo a TikTok (hasta ~20 MiB cada uno). */
export const TIKTOK_CHUNK_TIMEOUT_MS = 120_000;

/**
 * La consulta del estado después de subir (`tiktok.md` §6; sin webhooks: necesitarían una ruta
 * pública y la verificación de su firma, y el intento ya espera aquí). Esperas crecientes hasta el
 * tope; si sigue procesando, el intento se reprograma (`TIKTOK_STILL_PROCESSING`) y vuelve a mirar
 * sin subir otra vez. El tope por token es 30 consultas por minuto (DOC).
 */
export const TIKTOK_STATUS_POLL = {
  delaysMs: [2_000, 3_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 20_000, 20_000],
  /** Cuántos minutos esperar si al final sigue procesando. */
  retryMinutes: 5,
} as const;

/** Cuánto esperar ante el tope de envíos pendientes antes de volver a intentar. */
export const TIKTOK_PENDING_LIMIT_WAIT_MINUTES = 60;
