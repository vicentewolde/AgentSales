import { usageResponseSchema } from "@agentsales/api/contracts";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

export const usageKeys = { all: ["usage"] as const };

/** `GET /usage`: el gasto de IA del mes por corredor, con su tope (F7-T18; el corredor, el suyo). */
export function useUsage() {
  const client = useApiClient();
  return useQuery({
    queryKey: usageKeys.all,
    queryFn: async ({ signal }) =>
      unwrap(client.usage.$get({ query: {} }, { init: { signal } }), usageResponseSchema),
  });
}
