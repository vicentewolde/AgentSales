// Redacción de secretos en texto: función pura, sin dependencias, para que la usen tanto el logger
// de `@agentsales/config` como la API (sin arrastrar pino ni tipos de Node a quien importa AppType).

export const REDACTED = "[REDACTED]";

/** Credenciales dentro de una URL: `postgresql://usuario:clave@host` → `postgresql://[REDACTED]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/**
 * Parámetros sensibles de una URL o de un cuerpo de formulario (`a=b&c=d`, también al inicio del
 * texto o tras un espacio): `?access_token=…`, `X-Amz-Signature=…`, `api_key=…`, `client_secret=…`
 * y el `code` de un OAuth (solo con ese nombre exacto: `error_code=190` queda; spec F3 §4.6).
 */
const SENSITIVE_PARAM =
  /((?:^|[?&\s])(?:[^=&#\s]*(?:token|secret|password|key|signature|credential)[^=&#\s]*|code)=)[^&#\s]+/gi;

/** Oculta credenciales y parámetros sensibles de URLs y formularios dentro de un texto. */
export function redactText(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(SENSITIVE_PARAM, `$1${REDACTED}`);
}
