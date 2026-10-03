import type { Logger } from "@agentsales/config";

/** Los pasos del apagado del worker, en el orden en que `stopWorker` los corre. */
export type ShutdownSteps = {
  /** Dispara el `AbortController` de los handlers: cortan sus procesos hijos y relanzan. */
  abortJobs(): void;
  /** pg-boss deja de tomar jobs y espera a que terminen los activos (con su tope). */
  stopBoss(): Promise<void>;
  /** Cierra el Chromium del renderizador: recién cuando ningún handler lo está usando. */
  closeRenderer(): Promise<void>;
  closeDatabase(): Promise<void>;
};

/**
 * Apaga el worker en orden (spec F2 §4.4, T11): primero corta los handlers, después espera a que
 * pg-boss los detenga y **recién entonces** cierra el renderizador (cerrarlo antes haría fallar un
 * render en curso con un error que no es el corte) y la base. El renderizador se cierra también si
 * detener pg-boss falla; un error al cerrarlo solo queda en el log. Un error de pg-boss o de la base
 * se propaga. Entre el corte y `stop`, pg-boss podría tomar un job más: sale de inmediato con el
 * `signal` ya disparado y gasta un intento, sin tocar la corrida.
 */
export async function stopWorker(steps: ShutdownSteps, logger: Logger): Promise<void> {
  steps.abortJobs();
  try {
    await steps.stopBoss();
  } finally {
    await steps
      .closeRenderer()
      .catch((error: unknown) => logger.warn({ err: error }, "no se pudo cerrar el navegador"));
  }
  await steps.closeDatabase();
}
