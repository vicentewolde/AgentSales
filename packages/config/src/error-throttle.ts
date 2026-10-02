import type { Logger } from "pino";

export type ErrorThrottleOptions = {
  /** Cada cuánto se resume una falla que sigue ocurriendo. */
  summaryEveryMs?: number;
  /** Sin errores durante este tiempo se da la falla por superada. */
  recoveredAfterMs?: number;
};

/**
 * Evita inundar el log cuando una falla se repite (por ejemplo, sin internet pg-boss reintenta cada
 * 1–2 s y cada intento emite un error). Registra el primer error completo, luego un resumen
 * periódico con la cantidad de fallas, y avisa cuando pasan `recoveredAfterMs` sin errores.
 */
export function createErrorThrottle(
  logger: Logger,
  message: string,
  { summaryEveryMs = 30_000, recoveredAfterMs = 10_000 }: ErrorThrottleOptions = {},
) {
  let outageStartedAt: number | null = null;
  let lastSummaryAt = 0;
  let sinceSummary = 0;
  let total = 0;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;

  function recovered(): void {
    if (outageStartedAt === null) return;
    logger.info(
      { fallos: total, duracionS: Math.round((Date.now() - outageStartedAt) / 1000) },
      `${message}: se recuperó`,
    );
    outageStartedAt = null;
    sinceSummary = 0;
    total = 0;
  }

  return {
    report(error: unknown): void {
      const now = Date.now();
      total++;
      if (outageStartedAt === null) {
        outageStartedAt = now;
        lastSummaryAt = now;
        sinceSummary = 0;
        logger.error({ err: error }, `${message} (se resumirá mientras siga ocurriendo)`);
      } else {
        sinceSummary++;
        if (now - lastSummaryAt >= summaryEveryMs) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.warn(
            {
              fallos: sinceSummary,
              desdeHaceS: Math.round((now - outageStartedAt) / 1000),
              ultimo: detail,
            },
            `${message}: sigue ocurriendo`,
          );
          lastSummaryAt = now;
          sinceSummary = 0;
        }
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(recovered, recoveredAfterMs);
      quietTimer.unref();
    },
    /** Cancela el temporizador (apagado). */
    dispose(): void {
      clearTimeout(quietTimer);
    },
  };
}
