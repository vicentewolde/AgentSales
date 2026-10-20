// LinkedIn, perfil personal (spec F9 §4.4 a §4.7, F9-T15; `docs/integraciones/linkedin.md`). Las
// cifras salen de la doc oficial (DOC en la nota); lo marcado NO VERIFICADO lo confirman S2 y S3
// del operador **antes de cualquier publicación real** (decisión del operador, 2026-10-20).

/** El host de la API REST (Posts, Images, Videos) y de `/v2/userinfo`. msw lo intercepta en los tests. */
export const LINKEDIN_API_ORIGIN = "https://api.linkedin.com";

/** El host del OAuth (autorización y canje del código, `linkedin.md` §3.1). */
export const LINKEDIN_OAUTH_ORIGIN = "https://www.linkedin.com";

/**
 * `Linkedin-Version: AAAAMM`, obligatoria en `/rest/*` (`linkedin.md` §4.1): 202610 vence el
 * 2027-10-15. Con una versión cerrada, LinkedIn responde 426 (`LINKEDIN_VERSION_DEPRECATED`) y hay
 * que subir esta constante y revisar el changelog de cada recurso.
 */
export const LINKEDIN_API_VERSION = "202610";

/** Cuándo vence `LINKEDIN_API_VERSION` (un test avisa antes, para revisarla a tiempo). */
export const LINKEDIN_API_VERSION_SUNSET = "2027-10-15";

/** `X-Restli-Protocol-Version`, también obligatoria (`linkedin.md` §4). */
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0";

/**
 * Los permisos que pide el OAuth: `openid profile` (Sign in with LinkedIn, para leer el `sub` del
 * miembro) y `w_member_social` (Share on LinkedIn, publicar). Que este token sirva en `/rest/posts`
 * es la prueba S2.
 */
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"] as const;

const MB = 1000 * 1000;

/** Los límites de un post orgánico (`linkedin.md` §4.3, §5.1 y §5.3). */
export const LINKEDIN_LIMITS = {
  /** `commentary`: 3.000 caracteres, medidos con los escapes (si cuenta los escapes: NO VERIFICADO). */
  commentaryChars: 3000,
  /** Varias imágenes (`multiImage`): de 2 a 20. */
  images: 20,
  /** Una imagen: menos de 36.152.320 píxeles. */
  imagePixels: 36_152_320,
  /** El peso de una imagen no figura en la doc: un tope propio para no bajar algo absurdo. */
  imageBytes: 50 * MB,
  /** Video MP4: de 75 KB a 500 MB y de 3 s a 30 min. */
  videoMinBytes: 75 * 1000,
  videoMaxBytes: 500 * MB,
  videoMinS: 3,
  videoMaxS: 30 * 60,
} as const;

/** Los tipos de imagen que acepta (`linkedin.md` §5.1: JPG, PNG y GIF). */
export const LINKEDIN_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
]);

/** Las partes de una subida de video (`linkedin.md` §4.3): 4.194.304 bytes, las da LinkedIn. */
export const LINKEDIN_VIDEO_PART_BYTES = 4_194_304;

/** Tope de cada llamada a la API (las de subida tienen el suyo). */
export const LINKEDIN_REQUEST_TIMEOUT_MS = 30_000;

/** Tope de cada subida de bytes (una imagen o una parte de video) y de cada lectura de R2. */
export const LINKEDIN_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * La espera de un video recién subido hasta `AVAILABLE` (`linkedin.md` §5.2): una consulta cada
 * 5 s, hasta 5 minutos. Si no alcanza, o si el token no puede leer el video (403, NO VERIFICADO),
 * se intenta el post igual: LinkedIn responde `MEDIA_ASSET_WAITING_UPLOAD` y la cola reintenta sin
 * subirlo de nuevo.
 */
export const LINKEDIN_VIDEO_POLL = { intervalMs: 5000, attempts: 60 } as const;

/**
 * Un 429 sin `Retry-After` (`linkedin.md` §6 y §7): si es la cuota del día, se libera a medianoche
 * UTC; se reprograma en una hora (`waitMinutes`, ADR-0018).
 */
export const LINKEDIN_RATE_LIMIT_WAIT_MINUTES = 60;
