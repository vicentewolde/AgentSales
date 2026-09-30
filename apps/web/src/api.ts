import type { AppType } from "@agentsales/api";
import { type HealthReport, healthReportSchema } from "@agentsales/core";
import { hc } from "hono/client";

/** Sin respuesta útil de la API: caída, proxy sin destino u otro servicio en el puerto. */
export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export type HealthFetcher = () => Promise<HealthReport>;

/** Cliente RPC tipado a través del proxy de Vite (`/api` → API, spec F0 §4.5). */
const client = hc<AppType>("/api");

export const fetchHealth: HealthFetcher = async () => {
  let response: Awaited<ReturnType<typeof client.health.$get>>;
  try {
    response = await client.health.$get();
  } catch {
    throw new ApiUnavailableError("La API no responde");
  }
  if (!response.ok) {
    // El proxy de Vite responde 5xx cuando la API está apagada.
    throw new ApiUnavailableError(`La API no responde (HTTP ${response.status})`);
  }
  const parsed = healthReportSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiUnavailableError("Respuesta inesperada de /health: ¿otro servicio en el puerto?");
  }
  return parsed.data;
};
