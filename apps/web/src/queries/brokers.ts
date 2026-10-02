import { brokerListResponseSchema } from "@agentsales/api/contracts";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

export const brokerKeys = { all: ["brokers"] as const };

/** Los corredores, para el selector de Importar. */
export function useBrokers() {
  const client = useApiClient();
  return useQuery({
    queryKey: brokerKeys.all,
    queryFn: async ({ signal }) =>
      (await unwrap(client.brokers.$get(undefined, { init: { signal } }), brokerListResponseSchema))
        .brokers,
  });
}
