import type { AppType } from "@agentsales/api";
import { type HealthReport, healthReportSchema } from "@agentsales/core";
import { hc } from "hono/client";
import { z } from "zod";

/** Mayor que el peor caso de `/health` en la API (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 35_000;

/** Error de la API o de llegar a ella; `code` es el de su `ErrorBody`, si lo trae. */
export class ApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export type HealthFetcher = (signal?: AbortSignal) => Promise<HealthReport>;

// Pendiente de ADR-0011 (F1): dónde viven los contratos HTTP compartidos (cuerpo de error y otros).
const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Cliente RPC tipado a través del proxy de Vite (`/api` → API, spec F0 §4.5). */
const client = hc<AppType>("/api");

export const fetchHealth: HealthFetcher = async (signal) => {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof client.health.$get>>;
  try {
    response = await client.health.$get(undefined, {
      init: { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ApiError(`La API no respondió en ${API_TIMEOUT_MS / 1000} s`, "TIMEOUT");
    }
    throw new ApiError("La API no responde", "UNREACHABLE");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    throw parsed.success
      ? new ApiError(
          `${parsed.data.error.code}: ${parsed.data.error.message}`,
          parsed.data.error.code,
        )
      : // El proxy de Vite responde 5xx sin JSON cuando la API está apagada.
        new ApiError(`La API no responde (HTTP ${response.status})`, "UNREACHABLE");
  }
  const parsed = healthReportSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      "Respuesta inesperada de /health: ¿otro servicio en el puerto?",
      "UNEXPECTED_RESPONSE",
    );
  }
  return parsed.data;
};
