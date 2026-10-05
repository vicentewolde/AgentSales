// Redacción de secretos en texto: función pura, sin dependencias, para que la usen tanto el logger
// de `@agentsales/config` como la API (sin arrastrar pino ni tipos de Node a quien importa AppType).

export const REDACTED = "[REDACTED]";

/** Credenciales dentro de una URL: `postgresql://usuario:clave@host` → `postgresql://[REDACTED]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/**
 * Parámetros sensibles de una URL o de un cuerpo de formulario (`a=b&c=d`, también al inicio del
 * texto o tras un espacio): `?access_token=…`, `X-Amz-Signature=…`, `api_key=…`, `client_secret=…`.
 * Ocultar de más aquí es seguro: son nombres de secretos.
 */
const SENSITIVE_PARAM =
  /((?:^|[?&#\s])[^=&#\s]*(?:token|secret|password|key|signature|credential)[^=&#\s]*=)[^&#\s]+/gi;
/**
 * El `code` de un OAuth (spec F3 §4.6): solo como parámetro (`?code=`, `&code=`, `#code=` o al inicio
 * de un formulario) y con ese nombre exacto. `error_code=190` y `status code=500` quedan visibles.
 */
const OAUTH_CODE_PARAM = /((?:^|[?&#])code=)[^&#\s]+/gi;
/** Valores sensibles en un JSON: `"access_token": "…"` (por ejemplo, la respuesta de un canje). */
const SENSITIVE_JSON_VALUE =
  /("[^"]*(?:token|secret|password|key|signature|credential)[^"]*"\s*:\s*")(?:[^"\\]|\\.)*"/gi;

/** Oculta credenciales y parámetros sensibles de URLs, formularios y JSON dentro de un texto. */
export function redactText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(SENSITIVE_PARAM, `$1${REDACTED}`)
    .replace(OAUTH_CODE_PARAM, `$1${REDACTED}`)
    .replace(SENSITIVE_JSON_VALUE, `$1${REDACTED}"`);
}
