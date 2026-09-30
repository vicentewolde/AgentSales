import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { fetchHealth, type HealthFetcher } from "./api.js";

/** Cada sondeo despierta Neon (ADR-0007): 30 s y solo con la pestaña visible. */
export const HEALTH_REFETCH_MS = 30_000;

/** Permite inyectar un `/health` simulado en los tests. */
export const HealthFetcherContext = createContext<HealthFetcher>(fetchHealth);

export function useHealth() {
  const fetcher = useContext(HealthFetcherContext);
  return useQuery({
    queryKey: ["health"],
    queryFn: fetcher,
    refetchInterval: HEALTH_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}
