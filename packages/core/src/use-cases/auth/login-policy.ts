// El bloqueo por usuario (spec F7 §4.2, ADR-0021): lo comparten la contraseña, el segundo paso y
// desactivar el doble factor (F8-T15). En su propio módulo para que `sessions.ts` y `totp.ts` lo
// usen sin depender uno del otro.

const MINUTE = 60_000;

/** Tras 10 fallos seguidos, 15 min de bloqueo. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MS = 15 * MINUTE;
