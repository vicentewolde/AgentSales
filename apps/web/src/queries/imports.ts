import {
  type ImportRunView,
  importRunListResponseSchema,
  importRunResponseSchema,
} from "@agentsales/api/contracts";
import { isTerminalImportRun } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { brokerKeys } from "./brokers.js";
import { listingKeys } from "./listings.js";
import { usePolledRun } from "./run-poll.js";

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
  const { query, stopped, finishedHere } = usePolledRun<ImportRunView>({
    queryKey: importKeys.detail(id),
    fetch: async (signal) =>
      (
        await unwrap(
          client.imports[":id"].$get({ param: { id } }, { init: { signal } }),
          importRunResponseSchema,
        )
      ).importRun,
    isTerminal: isTerminalImportRun,
  });
  useEffect(() => {
    if (!finishedHere) return;
    void queryClient.invalidateQueries({ queryKey: listingKeys.all });
    void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
    void queryClient.invalidateQueries({ queryKey: importKeys.lists() });
  }, [finishedHere, queryClient]);
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
