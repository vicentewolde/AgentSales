// Redacción de secretos en texto: función pura, sin dependencias, para que la usen tanto el logger
// de `@agentsales/config` como la API (sin arrastrar pino ni tipos de Node a quien importa AppType).

export const REDACTED = "[REDACTED]";

/** Credenciales dentro de una URL: `postgresql://usuario:clave@host` → `postgresql://[REDACTED]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** Parámetros sensibles de una URL: `?access_token=…`, `X-Amz-Signature=…`, `api_key=…`. */
const SENSITIVE_QUERY =
  /([?&][^=&#\s]*(?:token|secret|password|key|signature|credential)[^=&#\s]*=)[^&#\s]+/gi;

/** Oculta credenciales y parámetros sensibles de URLs dentro de un texto. */
export function redactText(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(SENSITIVE_QUERY, `$1${REDACTED}`);
}
