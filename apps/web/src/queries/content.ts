import {
  type ContentEditBody,
  type ContentRunRequestBody,
  type ContentRunView,
  type ContentView,
  contentEditResponseSchema,
  contentRunRequestResponseSchema,
  contentRunResponseSchema,
  type ListingContentResponse,
  listingContentResponseSchema,
} from "@agentsales/api/contracts";
import { isTerminalContentRun } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { LISTINGS_GC_MS, LISTINGS_STALE_MS, listingKeys } from "./listings.js";
import { usePolledRun } from "./run-poll.js";

export const contentKeys = {
  all: ["content"] as const,
  listing: (listingId: string) => [...contentKeys.all, "listing", listingId] as const,
  run: (runId: string) => [...contentKeys.all, "run", runId] as const,
};

/**
 * `GET /listings/:id/content`: los textos vigentes con su revisión, los medios por canal y la
 * última corrida. Trae URLs firmadas: se cachea como el detalle (`LISTINGS_STALE_MS`).
 */
export function useListingContent(listingId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: contentKeys.listing(listingId),
    queryFn: ({ signal }) =>
      unwrap(
        client.listings[":id"].content.$get({ param: { id: listingId } }, { init: { signal } }),
        listingContentResponseSchema,
      ),
    staleTime: LISTINGS_STALE_MS,
    gcTime: LISTINGS_GC_MS,
  });
}

/**
 * `GET /content-runs/:id`, sondeado mientras la corrida no termina (`RUN_WAIT`, como una carga). Si
 * termina mientras se mira, vuelve a pedir el contenido y el detalle (miniaturas y medidas nuevas).
 */
export function useContentRun(listingId: string, runId: string | null) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const polled = usePolledRun<ContentRunView>({
    queryKey: contentKeys.run(runId ?? "ninguna"),
    enabled: runId !== null,
    fetch: async (signal) =>
      (
        await unwrap(
          client["content-runs"][":id"].$get({ param: { id: runId ?? "" } }, { init: { signal } }),
          contentRunResponseSchema,
        )
      ).contentRun,
    isTerminal: isTerminalContentRun,
    // Una corrida nace en cola: la espera cuenta desde que se pidió.
    startedAt: (run) => run.createdAt,
  });
  useEffect(() => {
    if (!polled.finishedHere) return;
    void queryClient.invalidateQueries({ queryKey: contentKeys.listing(listingId) });
    void queryClient.invalidateQueries({ queryKey: listingKeys.detail(listingId) });
    void queryClient.invalidateQueries({ queryKey: listingKeys.lists() });
  }, [polled.finishedHere, queryClient, listingId]);
  return polled;
}

/** `POST /listings/:id/content-runs`: pide la preparación (o devuelve la que ya estaba en curso). */
export function useRequestContentRun(listingId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContentRunRequestBody) =>
      unwrap(
        client.listings[":id"]["content-runs"].$post({ param: { id: listingId }, json: body }),
        contentRunRequestResponseSchema,
      ),
    onSuccess: ({ contentRun }) => {
      queryClient.setQueryData(contentKeys.run(contentRun.id), contentRun);
    },
  });
}

/**
 * `PATCH /contents/:id`: guarda una edición a mano. La respuesta trae el texto con su revisión
 * nueva, que reemplaza al de la caché: el panel nunca revisa por su cuenta (necesitaría lo privado
 * del aviso). Conserva la hora de la carga del contenido, porque sus URLs firmadas son de entonces.
 */
export function useEditContent(listingId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edit }: { id: string; edit: ContentEditBody }) =>
      (
        await unwrap(
          client.contents[":id"].$patch({ param: { id }, json: edit }),
          contentEditResponseSchema,
        )
      ).content,
    onSuccess: (saved: ContentView) => {
      const key = contentKeys.listing(listingId);
      queryClient.setQueryData<ListingContentResponse>(
        key,
        (current) =>
          current && {
            ...current,
            contents: current.contents.map((item) => (item.id === saved.id ? saved : item)),
          },
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
    },
  });
}
