import {
  type LeadView,
  leadListResponseSchema,
  leadResponseSchema,
  leadWebhookSecretResponseSchema,
} from "@agentsales/api/contracts";
import type { LeadStatus } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

// Los leads de un corredor (F10-T06, ADR-0033): datos personales de terceros. Se piden solo a
// pedido del usuario que puede verlos y no se guardan fuera de la caché de la página.

export const leadKeys = {
  all: ["leads"] as const,
  list: (brokerId: string, status?: LeadStatus) =>
    [...leadKeys.all, brokerId, status ?? null] as const,
};

/** `GET /brokers/:id/leads`: los más nuevos primero, con el filtro de estado. */
export function useLeads(brokerId: string | undefined, status?: LeadStatus) {
  const client = useApiClient();
  return useQuery({
    queryKey: leadKeys.list(brokerId ?? "", status),
    enabled: brokerId !== undefined,
    queryFn: async ({ signal }): Promise<LeadView[]> =>
      (
        await unwrap(
          client.brokers[":id"].leads.$get(
            {
              param: { id: brokerId ?? "" },
              query: { limit: "200", ...(status === undefined ? {} : { status }) },
            },
            { init: { signal } },
          ),
          leadListResponseSchema,
        )
      ).leads,
  });
}

function useRefreshLeads() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: leadKeys.all });
}

export function useChangeLeadStatus() {
  const client = useApiClient();
  const refresh = useRefreshLeads();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) =>
      unwrap(
        client.leads[":id"].status.$post({ param: { id }, json: { status } }),
        leadResponseSchema,
      ),
    onSettled: refresh,
  });
}

export function useEraseLead() {
  const client = useApiClient();
  const refresh = useRefreshLeads();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(client.leads[":id"].erase.$post({ param: { id } }), leadResponseSchema),
    onSettled: refresh,
  });
}

/** Genera o rota el secreto del webhook. El resultado se muestra una vez y no se guarda en la caché. */
export function useRotateWebhookSecret(brokerId: string | undefined) {
  const client = useApiClient();
  return useMutation({
    gcTime: 0,
    mutationFn: () =>
      unwrap(
        client.brokers[":id"].leads["webhook-secret"].$post({ param: { id: brokerId ?? "" } }),
        leadWebhookSecretResponseSchema,
      ),
  });
}

/** `GET /brokers/:id/leads.csv`: el texto del CSV. */
export function useLeadsCsv(brokerId: string | undefined) {
  const client = useApiClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (): Promise<string> => {
      const response = await client.brokers[":id"]["leads.csv"].$get({
        param: { id: brokerId ?? "" },
      });
      if (!response.ok) throw new ApiError("No se pudo bajar la lista de leads", "EXPORT_FAILED");
      return response.text();
    },
  });
}
