import {
  type CalendarEntryView,
  calendarResponseSchema,
  publicationResponseSchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { postKeys } from "./posts.js";
import { publicationKeys } from "./publications.js";
import { TRACKING_REFETCH_MS, trackingKeys } from "./tracking.js";

// El calendario (F9-T18): lo programado y lo publicado de avisos y posts en un rango, y mover la
// fecha de una programada. La llave cuelga de `trackingKeys`: lo que cambia una publicación
// (publicar, programar, descartar, en Propiedades o en Contenido) ya invalida `trackingKeys.all`.

export const calendarKeys = {
  all: [...trackingKeys.all, "calendar"] as const,
  range: (from: Date, to: Date, broker?: string) =>
    [...calendarKeys.all, from.toISOString(), to.toISOString(), broker ?? null] as const,
};

/**
 * `GET /calendar` del rango, con el corredor del selector. Se relee cada 60 s solo con la pestaña a
 * la vista, como Seguimiento (ADR-0007: cada lectura despierta Neon).
 */
export function useCalendar(range: { from: Date; to: Date }, broker?: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: calendarKeys.range(range.from, range.to, broker),
    queryFn: async ({ signal }): Promise<CalendarEntryView[]> =>
      (
        await unwrap(
          client.calendar.$get(
            {
              query: {
                from: range.from.toISOString(),
                to: range.to.toISOString(),
                ...(broker === undefined ? {} : { broker }),
              },
            },
            { init: { signal } },
          ),
          calendarResponseSchema,
        )
      ).entries,
    refetchInterval: TRACKING_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * Mover la fecha de una programada: `POST /publications/:id/schedule`, el mismo caso de uso de F6
 * (`schedulePublication`) que reprograma desde la propiedad, el post o la CLI. El modo lo pone la
 * API. Al terminar se vuelve a pedir el calendario, la agenda, las publicaciones y los posts.
 */
export function useMovePublication() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, at }: { id: string; at: string }) =>
      (
        await unwrap(
          client.publications[":id"].schedule.$post({ param: { id }, json: { at } }),
          publicationResponseSchema,
        )
      ).publication,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
      void queryClient.invalidateQueries({ queryKey: publicationKeys.all });
      void queryClient.invalidateQueries({ queryKey: postKeys.all });
    },
  });
}
