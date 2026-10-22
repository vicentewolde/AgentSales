// Discord (spec F9 §4.4 a §4.6, F9-T14; `docs/integraciones/discord.md`). Las cifras salen de la
// doc oficial (DOC en la nota); lo marcado NO VERIFICADO lo confirma la prueba S5 del operador antes
// de publicar de verdad.

import { DISCORD_FILE_MAX_BYTES } from "@agentsales/core";

/** El host de la API. Los tests lo dejan igual: msw intercepta `discord.com`. */
export const DISCORD_API_ORIGIN = "https://discord.com";

/**
 * Versión explícita: sin número, la API usa la v6 deprecada (`discord.md` §3). Que Execute Webhook
 * la acepte en la ruta es INFERENCIA de la doc: lo confirma S5 (`discord.md` §8, prueba 1).
 */
export const DISCORD_API_VERSION = "v10";

const MIB = 1024 * 1024;

/** Los límites de un mensaje de webhook (`discord.md` §1 y §5.2). */
export const DISCORD_LIMITS = {
  /** `content`: 2.000 caracteres (se cuentan unidades UTF-16, como `checkPostContent`). */
  contentChars: 2000,
  /** Archivos por mensaje: la doc leída no lo fija; se usa 10 (NO VERIFICADO, `discord.md` §5.2). */
  files: 10,
  /**
   * Por archivo: 20 MiB para webhooks desde el 2026-09-03 (DOC). La cifra vive en core: `post.media`
   * la usa para decidir si arma el video liviano para Discord (F9.5 D8).
   */
  fileBytes: DISCORD_FILE_MAX_BYTES,
  /**
   * La solicitud completa: 25 MiB (DOC, Create Message). Se deja 1 MiB para el `payload_json` y
   * los separadores del `multipart`.
   */
  requestBytes: 24 * MIB,
} as const;

/** Tope de cada llamada a Discord: un `multipart` de 20 MiB tiene que alcanzar a subir. */
export const DISCORD_REQUEST_TIMEOUT_MS = 120_000;

/** Tope de la descarga de cada medio desde R2 (con su URL firmada de 1 hora). */
export const DISCORD_MEDIA_TIMEOUT_MS = 120_000;

/**
 * Un 429 con una espera corta se espera dentro del intento (sin gastar un reintento de la cola),
 * hasta estas veces y hasta estos segundos; uno más largo reprograma la publicación (`waitMinutes`).
 * El código no fija cuántos mensajes admite un webhook: obedece `retry_after` (`discord.md` §6.1).
 */
export const DISCORD_RATE_LIMIT_INLINE = { maxWaitS: 10, retries: 2 } as const;
