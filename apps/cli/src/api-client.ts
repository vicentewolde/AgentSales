import type { AppType, HealthReport } from "@agentsales/api";
import { hc } from "hono/client";

/** Mayor que el peor caso de `/health` (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 30_000;

/** La API solo escucha en IPv4 local (spec F0 §4.5). */
export const apiUrl = (port: number) => `http://127.0.0.1:${port}`;

export type HealthFetcher = () => Promise<HealthReport>;

/** Cliente RPC tipado (`hc<AppType>`) para `/health`, con timeout. */
export function createHealthFetcher(port: number, timeoutMs = API_TIMEOUT_MS): HealthFetcher {
  const client = hc<AppType>(apiUrl(port), {
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  return async () => {
    const response = await client.health.$get();
    if (!response.ok) {
      throw new Error(`la API respondió ${response.status}`);
    }
    return response.json();
  };
}
