import {
  type ImportRunView,
  importRunListResponseSchema,
  importRunResponseSchema,
} from "@agentsales/api/contracts";
import { isTerminalImportRun, RUN_WAIT } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { brokerKeys } from "./brokers.js";
import { listingKeys } from "./listings.js";

export type PollStop = "failures" | "max-wait";

/**
 * Por qué se deja de consultar una carga que sigue en curso (`RUN_WAIT`, igual que la CLI): tras
 * 3 fallas seguidas (contando el reintento de cada consulta) o a las 2 h de creada, así una carga
 * atascada no mantiene Neon despierto con la pestaña abierta. `checkedAt` es la hora de la última
 * respuesta; `createdAt` lo pone la base (Neon), con un desfase de reloj despreciable.
 */
export function pollStop(
  run: Pick<ImportRunView, "status" | "createdAt">,
  failures: number,
  checkedAt: number,
): PollStop | null {
  if (isTerminalImportRun(run.status)) return null;
  if (failures >= RUN_WAIT.maxPollFailures) return "failures";
  if (checkedAt - run.createdAt.getTime() >= RUN_WAIT.maxWaitMs) return "max-wait";
  return null;
}

export const importKeys = {
  all: ["imports"] as const,
  lists: () => [...importKeys.all, "list"] as const,
  detail: (id: string) => [...importKeys.all, "detail", id] as const,
};

/** `GET /imports`: las últimas cargas, sin reporte. */
export function useImportRuns() {
  const client = useApiClient();
  return useQuery({
    queryKey: importKeys.lists(),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.imports.$get(undefined, { init: { signal } }),
          importRunListResponseSchema,
        )
      ).importRuns,
  });
}

/**
 * `GET /imports/:id`, sondeado cada 2 s solo mientras la carga no termina y sin pasar los topes de
 * `pollStop` (spec F1 §4.7). Una carga terminada no cambia más: no se vuelve a pedir.
 *
 * Si la carga termina mientras se mira, invalida las propiedades, los corredores y la lista de
 * cargas: si no, Propiedades seguiría mostrando su caché sin lo recién cargado. Abrir una carga que
 * ya estaba terminada no invalida nada.
 *
 * Devuelve la consulta y, si se dejó de consultar una carga en curso, por qué (`stopped`).
 */
export function useImportRun(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  // Fallas seguidas (con los reintentos): TanStack reinicia `fetchFailureCount` en cada consulta,
  // así que no sirve para contar consultas seguidas que fallan.
  const failures = useRef(0);
  const query = useQuery({
    queryKey: importKeys.detail(id),
    queryFn: async ({ signal }) => {
      try {
        const { importRun } = await unwrap(
          client.imports[":id"].$get({ param: { id } }, { init: { signal } }),
          importRunResponseSchema,
        );
        failures.current = 0;
        return importRun;
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
  // ¿Se vio la carga en curso en esta página? Solo entonces su final trae algo nuevo.
  const sawInProgress = useRef(false);
  if (query.data !== undefined && !terminal) sawInProgress.current = true;
  useEffect(() => {
    if (!terminal || !sawInProgress.current) return;
    void queryClient.invalidateQueries({ queryKey: listingKeys.all });
    void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
    void queryClient.invalidateQueries({ queryKey: importKeys.lists() });
  }, [terminal, queryClient]);
  const stopped =
    query.data === undefined ? null : pollStop(query.data, failures.current, query.dataUpdatedAt);
  return { run: query, stopped };
}

export type ImportForm = {
  file: File;
  media?: File;
  broker?: string;
  dryRun: boolean;
};

/** `POST /imports` (multipart): la API guarda los archivos, crea la carga y la encola (`202`). */
export function useStartImport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, media, broker, dryRun }: ImportForm) =>
      (
        await unwrap(
          client.imports.$post({
            form: {
              file,
              ...(media ? { media } : {}),
              ...(broker ? { broker } : {}),
              dryRun: dryRun ? "true" : "false",
            },
          }),
          importRunResponseSchema,
        )
      ).importRun,
    onSuccess: async (run) => {
      queryClient.setQueryData(importKeys.detail(run.id), run);
      await queryClient.invalidateQueries({ queryKey: importKeys.lists() });
    },
  });
}
