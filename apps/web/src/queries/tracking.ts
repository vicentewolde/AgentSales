import {
  type AgendaResponse,
  agendaResponseSchema,
  type TrackingResponse,
  trackingResponseSchema,
} from "@agentsales/api/contracts";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

/**
 * La página Seguimiento relee cada 60 s, solo con la pestaña a la vista (spec F6 §4.9, ADR-0007:
 * cada lectura despierta Neon).
 */
export const TRACKING_REFETCH_MS = 60_000;

export const trackingKeys = {
  all: ["tracking"] as const,
  agenda: () => [...trackingKeys.all, "agenda"] as const,
  matrix: (archived: boolean) => [...trackingKeys.all, "matrix", archived] as const,
};

/** `GET /agenda`. */
export function useAgenda() {
  const client = useApiClient();
  return useQuery({
    queryKey: trackingKeys.agenda(),
    queryFn: async ({ signal }): Promise<AgendaResponse["items"]> =>
      (await unwrap(client.agenda.$get({ query: {} }, { init: { signal } }), agendaResponseSchema))
        .items,
    refetchInterval: TRACKING_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * `GET /tracking`. `staleTime` de 30 s: cada lectura firma una portada por fila, y volver a la
 * pestaña no debe repetirlo si recién se leyó.
 */
export function useTracking(archived: boolean) {
  const client = useApiClient();
  return useQuery({
    queryKey: trackingKeys.matrix(archived),
    queryFn: async ({ signal }): Promise<TrackingResponse["rows"]> =>
      (
        await unwrap(
          client.tracking.$get({ query: archived ? { archived: "1" } : {} }, { init: { signal } }),
          trackingResponseSchema,
        )
      ).rows,
    refetchInterval: TRACKING_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: TRACKING_REFETCH_MS / 2,
  });
}
