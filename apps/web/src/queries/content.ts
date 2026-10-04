import {
  type ContentRunRequestBody,
  contentRunRequestResponseSchema,
  contentRunResponseSchema,
  listingContentResponseSchema,
} from "@agentsales/api/contracts";
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
  const polled = usePolledRun({
    queryKey: contentKeys.run(runId ?? "ninguna"),
    enabled: runId !== null,
    fetch: async (signal) =>
      (
        await unwrap(
          client["content-runs"][":id"].$get({ param: { id: runId ?? "" } }, { init: { signal } }),
          contentRunResponseSchema,
        )
      ).contentRun,
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
