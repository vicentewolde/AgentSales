import type { Logger } from "@agentsales/config";

/** Los pasos del apagado del worker, en el orden en que `stopWorker` los corre. */
export type ShutdownSteps = {
  /** Dispara el `AbortController` de los handlers: cortan sus procesos hijos y relanzan. */
  abortJobs(): void;
  /** pg-boss deja de tomar jobs y espera a que terminen los activos (con su tope). */
  stopBoss(): Promise<void>;
  /** Cierra el Chromium del renderizador: recién cuando ningún handler lo está usando. */
  closeRenderer(): Promise<void>;
  /**
   * Cierra las ventanas de Marketplace y anota `windowClosedAt` (spec F5 §4.5): necesita la base,
   * así que va **antes** de cerrarla.
   */
  closeMarketplaceWindows?(): Promise<void>;
  /** Deja de latir y anota el apagado (F8-T12): también necesita la base. */
  stopHeartbeat?(): Promise<void>;
  closeDatabase(): Promise<void>;
};

/** Por qué se apaga el worker: una señal (SIGTERM, SIGINT) o solo, sin trabajo (F9.5-T24). */
export type ShutdownReason = "signal" | "idle";

/** El tope de espera de pg-boss en un apagado por señal (Fly da 45 s, `kill_timeout`). */
export const GRACEFUL_STOP_MS = 30_000;

/**
 * Apagado solo (F9.5-T24): nadie lo apura, así que espera hasta 15 min a que terminen los jobs que
 * pg-boss haya tomado entre la última revisión y `stop`.
 */
export const IDLE_GRACEFUL_STOP_MS = 15 * 60_000;

/**
 * Cómo se apaga según el motivo. Con una señal, los handlers se cortan (`abortJobs`) y pg-boss espera
 * 30 s. **Solo, sin trabajo, no se corta nada**: un intento de publicar cortado podría quedar
 * `outcome_unknown`; pg-boss deja de tomar jobs y espera a los activos. Si llega una señal mientras
 * tanto, el worker corta igual (`worker.ts`).
 */
export function stopOptionsFor(reason: ShutdownReason): {
  abortJobs: boolean;
  gracefulStopMs: number;
} {
  return reason === "idle"
    ? { abortJobs: false, gracefulStopMs: IDLE_GRACEFUL_STOP_MS }
    : { abortJobs: true, gracefulStopMs: GRACEFUL_STOP_MS };
}

/**
 * Apaga el worker en orden (spec F2 §4.4, T11): primero corta los handlers (salvo con
 * `abortJobs: false`, el apagado solo de F9.5-T24), después espera a que
 * pg-boss los detenga y **recién entonces** cierra el renderizador (cerrarlo antes haría fallar un
 * render en curso con un error que no es el corte) y la base. El renderizador se cierra también si
 * detener pg-boss falla; un error al cerrarlo solo queda en el log. Un error de pg-boss o de la base
 * se propaga. Entre el corte y `stop`, pg-boss podría tomar un job más: sale de inmediato con el
 * `signal` ya disparado y gasta un intento, sin tocar la corrida.
 */
export async function stopWorker(
  steps: ShutdownSteps,
  logger: Logger,
  { abortJobs = true }: { abortJobs?: boolean } = {},
): Promise<void> {
  if (abortJobs) steps.abortJobs();
  try {
    await steps.stopBoss();
  } finally {
    await steps
      .closeRenderer()
      .catch((error: unknown) => logger.warn({ err: error }, "no se pudo cerrar el navegador"));
    // También si detener pg-boss falló: la base sigue abierta hasta aquí.
    await steps
      .closeMarketplaceWindows?.()
      .catch((error: unknown) =>
        logger.warn({ err: error }, "no se pudieron cerrar las ventanas de Marketplace"),
      );
    // El último antes de la base: el panel ve el worker apagado en cuanto termina de apagarse.
    await steps
      .stopHeartbeat?.()
      .catch((error: unknown) => logger.warn({ err: error }, "no se pudo anotar el apagado"));
  }
  await steps.closeDatabase();
}
