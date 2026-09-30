import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { fetchHealth, type HealthFetcher } from "./api.js";

/** Cada sondeo despierta Neon (ADR-0007): 30 s, solo en la página Estado y con la pestaña visible. */
export const HEALTH_REFETCH_MS = 30_000;

/** Permite inyectar un `/health` simulado en los tests. */
export const HealthFetcherContext = createContext<HealthFetcher>(fetchHealth);

/**
 * `/health` compartido por el banner y la página Estado (misma `queryKey`). Solo quien pasa
 * `poll` sondea; el resto se actualiza al montar y al volver a la pestaña.
 */
export function useHealth({ poll = false }: { poll?: boolean } = {}) {
  const fetcher = useContext(HealthFetcherContext);
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetcher(signal),
    refetchInterval: poll ? HEALTH_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}
