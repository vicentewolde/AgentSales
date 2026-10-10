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
 * Un paso de la espera del inicio de sesión (pura, para probarla sin relojes): con lo que dijo la
 * consulta (`null` si falló), las fallas seguidas y el tiempo esperado, en qué quedó. Una consulta
 * buena reinicia las fallas; `MARKETPLACE_WAIT_MAX_POLL_FAILURES` seguidas es `unreachable`; pasado
 * `MARKETPLACE_LOGIN_CLIENT_WAIT_MS` sin resultado, `timeout`.
 */
export function loginWaitStep({
  result,
  failures,
  elapsedMs,
}: {
  result: MarketplaceLoginOutcome | null;
  failures: number;
  elapsedMs: number;
}): { wait: MarketplaceLoginWait; failures: number } {
  if (result !== null && result.outcome !== "pending") return { wait: result, failures: 0 };
  const next = result === null ? failures + 1 : 0;
  if (next >= MARKETPLACE_WAIT_MAX_POLL_FAILURES) {
    return { wait: { outcome: "unreachable" }, failures: next };
  }
  return {
    wait:
      elapsedMs >= MARKETPLACE_LOGIN_CLIENT_WAIT_MS
        ? { outcome: "timeout" }
        : { outcome: "pending" },
    failures: next,
  };
}

/** La clave de la espera: fuera de `accountKeys.all`, así otra invalidación no la reinicia. */
const loginWaitKey = (request: MarketplaceLoginRequest | null) =>
  ["marketplace-login", request?.brokerId, request?.requestedAt.getTime()] as const;

/**
 * La espera del inicio de sesión (spec F5 §4.2 y §4.12): mira `GET /accounts` cada 2 s
 * (`refetchInterval`: se pausa con la pestaña oculta) hasta que `marketplaceLoginOutcome` (core, la
 * misma regla que la CLI) diga conectada o fallida, o hasta `loginWaitStep` diga que se deja de
 * esperar. Con un resultado final deja de consultar y vuelve a pedir las cuentas de la página.
 */
export function useMarketplaceLoginWait(request: MarketplaceLoginRequest | null) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const failures = useRef(0);
  const key = loginWaitKey(request);
  const lastKey = useRef(JSON.stringify(key));
  if (lastKey.current !== JSON.stringify(key)) {
    lastKey.current = JSON.stringify(key);
    failures.current = 0;
  }
  const finished = (data: MarketplaceLoginWait | undefined) =>
    data !== undefined && data.outcome !== "pending";
  const cached = queryClient.getQueryData<MarketplaceLoginWait>(key);
  const query = useQuery({
    queryKey: key,
    enabled: request !== null && !finished(cached),
    queryFn: async ({ signal }): Promise<MarketplaceLoginWait> => {
      if (request === null) return { outcome: "pending" };
      let result: MarketplaceLoginOutcome | null = null;
      try {
        const { accounts } = await unwrap(
          client.accounts.$get(undefined, { init: { signal } }),
          accountListResponseSchema,
        );
        result = marketplaceLoginOutcome(accounts, request);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
      }
      const step = loginWaitStep({
        result,
        failures: failures.current,
        elapsedMs: Date.now() - request.startedAt,
      });
      failures.current = step.failures;
      return step.wait;
    },
    refetchInterval: (current) => (finished(current.state.data) ? false : RUN_WAIT.pollMs),
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
