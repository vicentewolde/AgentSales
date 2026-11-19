import {
  type CardStylePreviewBody,
  cardStyleResponseSchema,
  errorBodySchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

// El estilo de las imágenes de la marca (spec F9.7 B4, ADR-0043) y su lámina de muestra.

export const cardStyleKeys = {
  all: ["card-style"] as const,
  style: (brokerId: string) => [...cardStyleKeys.all, brokerId] as const,
};

export function useCardStyle(brokerId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: cardStyleKeys.style(brokerId),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.brokers[":id"]["card-style"].$get(
            { param: { id: brokerId } },
            { init: { signal } },
          ),
          cardStyleResponseSchema,
        )
      ).cardStyle,
  });
}

export function useSaveCardStyle(brokerId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (style: unknown) =>
      unwrap(
        client.brokers[":id"]["card-style"].$put({ param: { id: brokerId }, json: { style } }),
        cardStyleResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cardStyleKeys.style(brokerId) });
    },
  });
}

/** La lámina de muestra: un PNG como `blob:` para el `<img>` (quien lo usa lo libera). */
export function useCardStylePreview(brokerId: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (json: CardStylePreviewBody) => {
      const response = await client.brokers[":id"]["card-style"].preview.$post({
        param: { id: brokerId },
        json,
      });
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(await response.json().catch(() => undefined));
        throw parsed.success
          ? new ApiError(
              `${parsed.data.error.code}: ${parsed.data.error.message}`,
              parsed.data.error.code,
              response.status,
            )
          : new ApiError(`La API respondió ${response.status}`, undefined, response.status);
      }
      return URL.createObjectURL(await response.blob());
    },
  });
}
