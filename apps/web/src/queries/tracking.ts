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
  agenda: (broker?: string) => [...trackingKeys.all, "agenda", broker ?? null] as const,
  matrix: (archived: boolean, broker?: string) =>
    [...trackingKeys.all, "matrix", archived, broker ?? null] as const,
};

/** `GET /agenda`, con el corredor del selector (F7-T17). */
export function useAgenda(broker?: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: trackingKeys.agenda(broker),
    queryFn: async ({ signal }): Promise<AgendaResponse["items"]> =>
      (
        await unwrap(
          client.agenda.$get(
            { query: broker === undefined ? {} : { broker } },
            { init: { signal } },
          ),
          agendaResponseSchema,
        )
      ).items,
    refetchInterval: TRACKING_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * `GET /tracking`: las filas de avisos (`rows`) y de posts (`posts`). `staleTime` de 30 s: cada
 * lectura firma una portada por fila, y volver a la pestaña (o pasar de Hoy a Seguimiento, que
 * comparten la llave) no debe repetirlo si recién se leyó.
 */
export function useTracking(archived: boolean, broker?: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: trackingKeys.matrix(archived, broker),
    queryFn: async ({ signal }): Promise<TrackingResponse> =>
      unwrap(
        client.tracking.$get(
          {
            query: {
              ...(archived ? { archived: "1" as const } : {}),
              ...(broker === undefined ? {} : { broker }),
            },
          },
          { init: { signal } },
        ),
        trackingResponseSchema,
      ),
    refetchInterval: TRACKING_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: TRACKING_REFETCH_MS / 2,
  });
}
