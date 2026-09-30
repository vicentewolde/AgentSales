import type { AppType, HealthReport } from "@agentsales/api";
import { PUBLISH_MODES } from "@agentsales/core";
import { hc } from "hono/client";
import { z } from "zod";

/** Mayor que el peor caso de `/health` (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 30_000;

/** La API solo escucha en IPv4 local (spec F0 §4.5). */
export const apiUrl = (port: number) => `http://127.0.0.1:${port}`;

/** Fallo al hablar con la API; `code` es el de su `ErrorBody` o el de la red (ECONNREFUSED…). */
export class ApiCallError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
  }
}

export type HealthFetcher = () => Promise<HealthReport>;

const checkSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
});

// La respuesta viene de la red (quizás de otro servicio en el mismo puerto): se valida.
const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  publishMode: z.enum(PUBLISH_MODES),
  checks: z.object({ db: checkSchema, storage: checkSchema, queue: checkSchema }),
  version: z.string(),
});

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Mensaje legible de un fallo de red o de timeout de `fetch`. */
function describeFetchError(error: unknown, timeoutMs: number): ApiCallError {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ApiCallError(`sin respuesta en ${Math.round(timeoutMs / 1000)} s`, "TIMEOUT");
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  if (code === "ECONNREFUSED") {
    return new ApiCallError("nadie escucha en ese puerto (ECONNREFUSED)", code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiCallError(code ? `${message} (${code})` : message, code);
}

/** Cliente RPC tipado (`hc<AppType>`) para `/health`, con timeout y respuesta validada. */
export function createHealthFetcher(port: number, timeoutMs = API_TIMEOUT_MS): HealthFetcher {
  const client = hc<AppType>(apiUrl(port), {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal });
    },
  });
  return async () => {
    let response: Awaited<ReturnType<typeof client.health.$get>>;
    try {
      response = await client.health.$get();
    } catch (error) {
      throw describeFetchError(error, timeoutMs);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(body);
      throw parsed.success
        ? new ApiCallError(
            `${parsed.data.error.code}: ${parsed.data.error.message}`,
            parsed.data.error.code,
          )
        : new ApiCallError(`la API respondió ${response.status}`);
    }
    const parsed = healthSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiCallError(
        "respuesta inesperada de /health: ¿hay otro servicio en ese puerto?",
        "UNEXPECTED_RESPONSE",
      );
    }
    return parsed.data;
  };
}
