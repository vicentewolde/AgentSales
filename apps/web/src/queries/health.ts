import type { PublishMode } from "@agentsales/core";
import { healthReportSchema } from "@agentsales/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

/** Cada sondeo despierta Neon (ADR-0007): 30 s, solo en la página Estado y con la pestaña visible. */
export const HEALTH_REFETCH_MS = 30_000;

export const healthKeys = { all: ["health"] as const };

/**
 * `/health` compartido por el banner y la página Estado (misma `queryKey`). Solo quien pasa
 * `poll` sondea; el resto se actualiza al montar y al volver a la pestaña.
 */
export function useHealth({ poll = false }: { poll?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: healthKeys.all,
    queryFn: ({ signal }) =>
      unwrap(client.health.$get(undefined, { init: { signal } }), healthReportSchema),
    refetchInterval: poll ? HEALTH_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Pide `/health` de nuevo (sin caché) y devuelve el modo de la API: lo usa el panel justo antes de
 * publicar, para no confiar en un modo leído al abrir la página (D11). Un pedido por clic.
 */
export function useFreshPublishMode() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return async (): Promise<PublishMode> =>
    (
      await queryClient.fetchQuery({
        queryKey: healthKeys.all,
        queryFn: ({ signal }) =>
          unwrap(client.health.$get(undefined, { init: { signal } }), healthReportSchema),
        staleTime: 0,
      })
    ).publishMode;
}
