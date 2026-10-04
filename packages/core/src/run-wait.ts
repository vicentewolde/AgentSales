/**
 * Cómo esperan una corrida (una carga o una preparación de contenido) la CLI y el panel (spec F1
 * §4.4 y §4.7, F2 §4.9): consultan cada 2 s, avisan a los 20 s si sigue en cola, y dejan de
 * consultar a las 2 h o tras 3 fallas seguidas, para no mantener Neon despierto con una corrida
 * atascada (ADR-0007). Era `IMPORT_WAIT` hasta F2-T13.
 */
export const RUN_WAIT: Readonly<{
  pollMs: number;
  queuedWarningMs: number;
  maxWaitMs: number;
  maxPollFailures: number;
}> = {
  pollMs: 2_000,
  queuedWarningMs: 20_000,
  maxWaitMs: 2 * 60 * 60 * 1000,
  /** Consultas seguidas que pueden fallar (API reiniciándose, Neon despertando) antes de parar. */
  maxPollFailures: 3,
};
