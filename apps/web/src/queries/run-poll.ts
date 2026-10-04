import { type ImportRunStatus, isTerminalImportRun, RUN_WAIT } from "@agentsales/core";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

export type PollStop = "failures" | "max-wait";

/** Lo que el sondeo mira de una corrida: una carga o una preparación de contenido. */
export type PolledRun = { status: ImportRunStatus; createdAt: Date };

/**
 * Por qué se deja de consultar una corrida que sigue en curso (`RUN_WAIT`, igual que la CLI): tras
 * 3 fallas seguidas (contando el reintento de cada consulta) o a las 2 h de creada, así una corrida
 * atascada no mantiene Neon despierto con la pestaña abierta. `checkedAt` es la hora de la última
 * respuesta; `createdAt` lo pone la base (Neon), con un desfase de reloj despreciable. Cargas y
 * preparaciones tienen los mismos estados (`queued`, `running`, `succeeded`, `failed`).
 */
export function pollStop(run: PolledRun, failures: number, checkedAt: number): PollStop | null {
  if (isTerminalImportRun(run.status)) return null;
  if (failures >= RUN_WAIT.maxPollFailures) return "failures";
  if (checkedAt - run.createdAt.getTime() >= RUN_WAIT.maxWaitMs) return "max-wait";
  return null;
}

/** ¿Lleva más de 20 s en cola? Se mide con la hora de cada respuesta (`dataUpdatedAt`). */
export const stuckInQueue = (run: PolledRun | undefined, checkedAt: number) =>
  run?.status === "queued" && checkedAt - run.createdAt.getTime() >= RUN_WAIT.queuedWarningMs;

/**
 * Una corrida sondeada cada 2 s mientras no termina y sin pasar los topes de `pollStop` (spec F1
 * §4.7 y F2 §4.9). Una corrida terminada no cambia más: no se vuelve a pedir. Devuelve la consulta,
 * si se dejó de consultar una corrida en curso (`stopped`) y si terminó mientras se miraba
 * (`finishedHere`: abrir una que ya estaba terminada no cuenta).
 */
export function usePolledRun<R extends PolledRun>(options: {
  queryKey: QueryKey;
  fetch: (signal: AbortSignal) => Promise<R>;
  enabled?: boolean;
}) {
  // Fallas seguidas (con los reintentos): TanStack reinicia `fetchFailureCount` en cada consulta,
  // así que no sirve para contar consultas seguidas que fallan.
  const failures = useRef(0);
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
      if (data === undefined || isTerminalImportRun(data.status)) return false;
      return pollStop(data, failures.current, dataUpdatedAt) === null ? RUN_WAIT.pollMs : false;
    },
    staleTime: (current) => {
      const status = current.state.data?.status;
      return status !== undefined && isTerminalImportRun(status) ? Number.POSITIVE_INFINITY : 0;
    },
  });
  const terminal = query.data !== undefined && isTerminalImportRun(query.data.status);
  // ¿Se vio la corrida en curso en esta página? Solo entonces su final trae algo nuevo.
  const sawInProgress = useRef(false);
  if (query.data !== undefined && !terminal) sawInProgress.current = true;
  const stopped =
    query.data === undefined ? null : pollStop(query.data, failures.current, query.dataUpdatedAt);
  return { query, stopped, finishedHere: terminal && sawInProgress.current };
}
