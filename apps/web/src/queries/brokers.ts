import { brokerListResponseSchema, brokerResponseSchema } from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { healthKeys } from "./health.js";
import { trackingKeys } from "./tracking.js";

export const brokerKeys = { all: ["brokers"] as const };

/** Los corredores, para el selector de Importar y Cuentas. */
export function useBrokers() {
  const client = useApiClient();
  return useQuery({
    queryKey: brokerKeys.all,
    queryFn: async ({ signal }) =>
      (await unwrap(client.brokers.$get(undefined, { init: { signal } }), brokerListResponseSchema))
        .brokers,
  });
}

/**
 * `PATCH /brokers/:id { autoPublish }` (spec F6 §4.10). Al terminar se vuelven a pedir los
 * corredores, `/health` (el aviso en rojo de `auto_publish` en vivo) y la agenda.
 */
export function useSetAutoPublish() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, autoPublish }: { id: string; autoPublish: boolean }) =>
      (
        await unwrap(
          client.brokers[":id"].$patch({ param: { id }, json: { autoPublish } }),
          brokerResponseSchema,
        )
      ).broker,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
      void queryClient.invalidateQueries({ queryKey: healthKeys.all });
      void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
    },
  });
}
