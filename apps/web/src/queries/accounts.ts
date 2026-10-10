import {
  accountListResponseSchema,
  accountResponseSchema,
  marketplaceLoginResponseSchema,
} from "@agentsales/api/contracts";
import {
  MARKETPLACE_LOGIN_CLIENT_WAIT_MS,
  MARKETPLACE_WAIT_MAX_POLL_FAILURES,
  type MarketplaceLoginOutcome,
  marketplaceLoginOutcome,
  RUN_WAIT,
} from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
 * `POST /accounts/:id/disconnect`: la cuenta queda desconectada y sin credenciales. `confirmed`
 * dice que el operador ya contestó la pregunta de la tarjeta (`accountDisconnectText`: en
 * Marketplace, que se borra el perfil); Marketplace lo exige.
 */
export function useDisconnectAccount() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, confirmed }: { accountId: string; confirmed: boolean }) =>
      unwrap(
        client.accounts[":id"].disconnect.$post({
          param: { id: accountId },
          json: { confirmed },
        }),
        accountResponseSchema,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.all }),
  });
}

/** Un inicio de sesión de Marketplace pedido: de qué corredor, cuándo (la API) y desde cuándo se espera. */
export type MarketplaceLoginRequest = { brokerId: string; requestedAt: Date; startedAt: number };

/**
 * `POST /accounts/marketplace/login` (spec F5 §4.2): encola el inicio de sesión; el worker abre la
 * ventana de Chromium (en cualquier modo: no publica).
 */
export function useMarketplaceLogin() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async ({
      broker,
      label,
    }: {
      broker: string;
      label?: string;
    }): Promise<MarketplaceLoginRequest> => {
      const { brokerId, requestedAt } = await unwrap(
        client.accounts.marketplace.login.$post({
          json: { broker, ...(label === undefined ? {} : { label }) },
        }),
        marketplaceLoginResponseSchema,
      );
      return { brokerId, requestedAt, startedAt: Date.now() };
    },
  });
}

/** En qué quedó la espera: el resultado del inicio de sesión, o que se dejó de esperar. */
export type MarketplaceLoginWait =
  | MarketplaceLoginOutcome
  | { outcome: "timeout" }
  | { outcome: "unreachable" };

/**
 * La espera del inicio de sesión (spec F5 §4.2 y §4.12): mira `GET /accounts` cada 2 s hasta que
 * `marketplaceLoginOutcome` (core, la misma regla que la CLI) diga conectada o fallida, o hasta el
 * tope (`MARKETPLACE_LOGIN_CLIENT_WAIT_MS`); aguanta `MARKETPLACE_WAIT_MAX_POLL_FAILURES` consultas
 * fallidas seguidas. Al terminar, vuelve a pedir las cuentas de la página.
 */
export function useMarketplaceLoginWait(request: MarketplaceLoginRequest | null) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const failures = useRef(0);
  const query = useQuery({
    queryKey: [...accountKeys.all, "login", request?.brokerId, request?.requestedAt.getTime()],
    enabled: request !== null,
    queryFn: async ({ signal }): Promise<MarketplaceLoginWait> => {
      if (request === null) return { outcome: "pending" };
      try {
        const { accounts } = await unwrap(
          client.accounts.$get(undefined, { init: { signal } }),
          accountListResponseSchema,
        );
        failures.current = 0;
        const result = marketplaceLoginOutcome(accounts, request);
        if (result.outcome !== "pending") return result;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        failures.current += 1;
        if (failures.current >= MARKETPLACE_WAIT_MAX_POLL_FAILURES)
          return { outcome: "unreachable" };
      }
      return Date.now() - request.startedAt >= MARKETPLACE_LOGIN_CLIENT_WAIT_MS
        ? { outcome: "timeout" }
        : { outcome: "pending" };
    },
    refetchInterval: (current) =>
      current.state.data?.outcome === "pending" ? RUN_WAIT.pollMs : false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const outcome = query.data?.outcome;
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con el cambio de resultado.
  useEffect(() => {
    if (outcome !== undefined && outcome !== "pending") {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all, exact: true });
    }
  }, [outcome]);
  return query.data ?? (request === null ? null : { outcome: "pending" as const });
}
