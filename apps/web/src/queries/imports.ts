import { importRunListResponseSchema, importRunResponseSchema } from "@agentsales/api/contracts";
import { isTerminalImportRun } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { brokerKeys } from "./brokers.js";
import { listingKeys } from "./listings.js";

/** Cada 2 s, como la CLI (spec F1 §4.4), y solo mientras la carga está en cola o corriendo. */
export const IMPORT_POLL_MS = 2_000;

/** Si a los 20 s la carga sigue en cola, se avisa que revise el worker (spec F1 §4.6). */
export const QUEUED_WARNING_MS = 20_000;

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
 * `GET /imports/:id`, sondeado cada 2 s solo mientras la carga no termina (spec F1 §4.7). Al verla
 * terminada invalida las propiedades, los corredores y la lista de cargas: si no, Propiedades
 * seguiría mostrando su caché sin lo recién cargado.
 */
export function useImportRun(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: importKeys.detail(id),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.imports[":id"].$get({ param: { id } }, { init: { signal } }),
          importRunResponseSchema,
        )
      ).importRun,
    refetchInterval: (current) => {
      const status = current.state.data?.status;
      return status === undefined || isTerminalImportRun(status) ? false : IMPORT_POLL_MS;
    },
  });
  const terminal = query.data !== undefined && isTerminalImportRun(query.data.status);
  useEffect(() => {
    if (!terminal) return;
    void queryClient.invalidateQueries({ queryKey: listingKeys.all });
    void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
    void queryClient.invalidateQueries({ queryKey: importKeys.lists() });
  }, [terminal, queryClient]);
  return query;
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
