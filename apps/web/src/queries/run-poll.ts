import { RUN_WAIT } from "@agentsales/core";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

export type PollStop = "failures" | "max-wait";

/**
 * Lo que el sondeo mira: una carga, una preparación de contenido o una publicación. El inicio de la
 * espera lo da quien sondea (`startedAt`): `createdAt` para una corrida, que nace en cola; para una
 * publicación, el más reciente entre `updatedAt` y la hora del clic (puede llevar días aprobada).
 */
export type PolledRun = { status: string };

/** La regla de "terminada" de cada tipo de corrida (`isTerminalImportRun`, `isTerminalContentRun`). */
export type IsTerminal<R extends PolledRun> = (status: R["status"]) => boolean;

/**
 * Por qué se deja de consultar algo que sigue en curso (`RUN_WAIT`, igual que la CLI): tras 3 fallas
 * seguidas (contando el reintento de cada consulta) o a las 2 h de empezada la espera
 * (`startedAt`), así algo atascado no mantiene Neon despierto con la pestaña abierta. `checkedAt` es
 * la hora de la última respuesta; las fechas las pone la base (Neon), con un desfase despreciable.
 */
export function pollStop<R extends PolledRun>(
  run: R,
  isTerminal: IsTerminal<R>,
  failures: number,
  checkedAt: number,
  startedAt: Date,
): PollStop | null {
  if (isTerminal(run.status)) return null;
  if (failures >= RUN_WAIT.maxPollFailures) return "failures";
  if (checkedAt - startedAt.getTime() >= RUN_WAIT.maxWaitMs) return "max-wait";
  return null;
}

/** ¿Una corrida lleva más de 20 s en cola? Se mide con la hora de cada respuesta (`dataUpdatedAt`). */
export const stuckInQueue = (
  run: { status: string; createdAt: Date } | undefined,
  checkedAt: number,
) => run?.status === "queued" && checkedAt - run.createdAt.getTime() >= RUN_WAIT.queuedWarningMs;

/**
 * Una corrida sondeada cada 2 s mientras no termina y sin pasar los topes de `pollStop` (spec F1
 * §4.7 y F2 §4.9). Una corrida terminada no cambia más: no se vuelve a pedir. Devuelve la consulta,
 * si se dejó de consultar una corrida en curso (`stopped`) y si terminó mientras se miraba
 * (`finishedHere`: abrir una que ya estaba terminada no cuenta).
 */
export function usePolledRun<R extends PolledRun>(options: {
  queryKey: QueryKey;
  fetch: (signal: AbortSignal) => Promise<R>;
  isTerminal: IsTerminal<R>;
  /** Desde cuándo cuenta el tope de 2 h (ver `PolledRun`). */
  startedAt: (run: R) => Date;
  enabled?: boolean;
}) {
  const { isTerminal, startedAt } = options;
  // Fallas seguidas (con los reintentos): TanStack reinicia `fetchFailureCount` en cada consulta,
  // así que no sirve para contar consultas seguidas que fallan.
  const failures = useRef(0);
  // Cada consulta cuenta sus fallas: si cambia la clave (otra corrida, otra versión), se reinicia.
  const key = JSON.stringify(options.queryKey);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    failures.current = 0;
  }
  const query = useQuery({
    queryKey: options.queryKey,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }) => {
      try {
        const run = await options.fetch(signal);
        failures.current = 0;
        return run;
      } catch (error) {
        // Una cancelación (al salir de la página) no es una falla de la API.
        if (!(error instanceof Error && error.name === "AbortError")) failures.current += 1;
        throw error;
      }
    },
    refetchInterval: (current) => {
      const { data, dataUpdatedAt } = current.state;
      if (data === undefined || isTerminal(data.status)) return false;
      return pollStop(data, isTerminal, failures.current, dataUpdatedAt, startedAt(data)) === null
        ? RUN_WAIT.pollMs
        : false;
    },
    staleTime: (current) => {
      const status = current.state.data?.status;
      return status !== undefined && isTerminal(status) ? Number.POSITIVE_INFINITY : 0;
    },
  });
  const terminal = query.data !== undefined && isTerminal(query.data.status);
  // ¿Se vio la corrida en curso en esta página? Solo entonces su final trae algo nuevo.
  const sawInProgress = useRef(false);
  if (query.data !== undefined && !terminal) sawInProgress.current = true;
  const stopped =
    query.data === undefined
      ? null
      : pollStop(
          query.data,
          isTerminal,
          failures.current,
          query.dataUpdatedAt,
          startedAt(query.data),
        );
  return { query, stopped, finishedHere: terminal && sawInProgress.current };
}
