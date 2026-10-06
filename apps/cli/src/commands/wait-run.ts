import { RUN_QUEUED_WARNING_TEXT, RUN_WAIT } from "@agentsales/core";
import { ApiCallError } from "../api-client.js";
import type { Io } from "../output.js";

export type WaitDeps = Io & {
  sleep: (ms: number) => Promise<void>;
  /** Reloj monótono en milisegundos (un cambio de hora no adelanta ni atrasa el tope). */
  now: () => number;
  wait?: Partial<typeof RUN_WAIT>;
};

export type WaitedRun = { status: string };

export type WaitOptions<R extends WaitedRun> = {
  /** La corrida recién pedida. */
  run: R;
  /** La vuelve a consultar en la API. */
  fetch: () => Promise<R>;
  isTerminal: (run: R) => boolean;
  /** Qué se muestra mientras avanza (`en cola`, `procesando`…); se imprime cuando cambia. */
  progress: (run: R) => string;
  /** Con qué la revisa el operador después (`agentsales imports <id>`). */
  laterCommand: string;
  /** Cómo se llama en los mensajes (`la carga`, `la preparación`). */
  noun: string;
  /**
   * Si todavía nadie la tomó, para avisar a los 20 s que el worker puede estar apagado. Por defecto,
   * `status === "queued"`; las publicaciones no tienen ese estado y pasan su propio criterio.
   */
  isQueued?: (run: R) => boolean;
};

/** Puede volver a consultar: la API no respondió, o respondió un error de su lado (503, 500). */
const isTransient = (error: unknown) =>
  error instanceof ApiCallError && (error.status === undefined || error.status >= 500);

/**
 * Espera una corrida como `import` y `prepare` (`RUN_WAIT`, spec F1 §4.4 y F2 §4.9): consulta cada
 * 2 s, imprime cada cambio de avance, avisa a los 20 s si sigue en cola y deja de esperar a las
 * 2 h (devuelve `null`) o tras 3 fallas seguidas de la API (relanza la última). La corrida sigue
 * en el worker, que no depende de la API.
 */
export async function waitForRun<R extends WaitedRun>(
  deps: WaitDeps,
  options: WaitOptions<R>,
): Promise<R | null> {
  const c = deps.colors;
  const timing = { ...RUN_WAIT, ...deps.wait };
  const started = deps.now();
  let run = options.run;
  let shown = options.progress(run);
  let warned = false;
  let failures = 0;
  const isQueued = options.isQueued ?? ((current: R) => current.status === "queued");
  while (!options.isTerminal(run)) {
    if (deps.now() - started >= timing.maxWaitMs) {
      deps.print(c.yellow(`Sigue en curso: revisa más tarde con ${options.laterCommand}`));
      return null;
    }
    await deps.sleep(timing.pollMs);
    try {
      run = await options.fetch();
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!isTransient(error)) throw error;
      if (failures >= timing.maxPollFailures) {
        deps.printError(
          c.yellow(`Dejé de esperar; revisa ${options.noun} más tarde con ${options.laterCommand}`),
        );
        throw error;
      }
      continue;
    }
    const progress = options.progress(run);
    if (progress !== shown && !options.isTerminal(run)) deps.print(`${progress}…`);
    shown = progress;
    if (isQueued(run) && !warned && deps.now() - started >= timing.queuedWarningMs) {
      warned = true;
      deps.print(c.yellow(RUN_QUEUED_WARNING_TEXT));
    }
  }
  return run;
}
