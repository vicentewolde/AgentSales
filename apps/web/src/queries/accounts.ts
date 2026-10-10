import { accountListResponseSchema, accountResponseSchema } from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

export const accountKeys = { all: ["accounts"] as const };

/** `GET /accounts`: las cuentas conectadas y cómo se conecta cada plataforma (spec F3 §4.9). */
export function useAccounts() {
  const client = useApiClient();
  return useQuery({
    queryKey: accountKeys.all,
    queryFn: ({ signal }) =>
      unwrap(client.accounts.$get(undefined, { init: { signal } }), accountListResponseSchema),
  });
}

/**
 * `POST /accounts/:id/disconnect`: la cuenta queda desconectada y sin credenciales. El panel ya
 * pregunta antes de llamar, así que va confirmado (Marketplace lo exige: borra el perfil).
 */
export function useDisconnectAccount() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      unwrap(
        client.accounts[":id"].disconnect.$post({
          param: { id: accountId },
          json: { confirmed: true },
        }),
        accountResponseSchema,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.all }),
  });
}
