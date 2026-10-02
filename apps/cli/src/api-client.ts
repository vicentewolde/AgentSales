import type { AppType } from "@agentsales/api";
import { errorBodySchema } from "@agentsales/api/contracts";
import { type HealthReport, healthReportSchema } from "@agentsales/core";
import { hc } from "hono/client";
import type { z } from "zod";

/** Mayor que el peor caso de `/health` (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 30_000;

/** La API solo escucha en IPv4 local (spec F0 §4.5). */
export const apiUrl = (port: number) => `http://127.0.0.1:${port}`;

/**
 * Fallo al hablar con la API. `code` es el de su `ErrorBody` o el de la red (`ECONNREFUSED`,
 * `TIMEOUT`…); `status` falta si la API no llegó a responder.
 */
export class ApiCallError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.status = status;
  }
}

/** Mensaje legible de un fallo de red o de timeout de `fetch`. */
function describeFetchError(error: unknown, timeoutMs: number): ApiCallError {
  if (error instanceof Error && error.name === "TimeoutError") {
    const after = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
    return new ApiCallError(`sin respuesta en ${after}`, "TIMEOUT");
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

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  timeoutMs?: number;
  /** Solo para tests: la app en proceso (`app.request`), sin red. */
  fetch?: Fetch;
};

/**
 * Cliente RPC tipado (`hc<AppType>`) con toda la API. Cada petición tiene timeout, y un fallo de
 * red o de timeout llega como `ApiCallError`. La respuesta se lee con `unwrap`.
 */
export function createApiClient(port: number, options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  const send = options.fetch ?? fetch;
  return hc<AppType>(apiUrl(port), {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        return await send(input, { ...init, signal });
      } catch (error) {
        throw describeFetchError(error, timeoutMs);
      }
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

type ApiResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * Lee la respuesta: un error de la API (`ErrorBody`) se lanza como `CODE: mensaje`, y una
 * respuesta exitosa se valida con su esquema de `@agentsales/api/contracts`, porque viene de la
 * red (quizás de otro servicio en el mismo puerto).
 */
export async function unwrap<S extends z.ZodType>(
  response: ApiResponse | Promise<ApiResponse>,
  schema: S,
): Promise<z.output<S>> {
  const res = await response;
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = errorBodySchema.safeParse(body);
    throw parsed.success
      ? new ApiCallError(
          `${parsed.data.error.code}: ${parsed.data.error.message}`,
          parsed.data.error.code,
          res.status,
        )
      : new ApiCallError(`la API respondió ${res.status}`, undefined, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiCallError(
      "respuesta inesperada de la API: ¿hay otro servicio en ese puerto, o es de otra versión?",
      "UNEXPECTED_RESPONSE",
      res.status,
    );
  }
  return parsed.data;
}

export type HealthFetcher = () => Promise<HealthReport>;

/** `/health` validado, para `doctor` y `status`. */
export function createHealthFetcher(client: ApiClient): HealthFetcher {
  return () => unwrap(client.health.$get(), healthReportSchema);
}

/** Sugerencia según el motivo por el que la API no respondió. */
export function apiHint(error: unknown): string {
  if (error instanceof ApiCallError && error.code === "HOST_NOT_ALLOWED") {
    return "La API rechazó el Host: revisa que API_PORT coincida con el de la API";
  }
  if (error instanceof ApiCallError && error.code === "UNEXPECTED_RESPONSE") {
    return "Otro proceso usa el puerto: ciérralo o cambia API_PORT, y levanta pnpm dev";
  }
  return "Levántala con pnpm dev";
}
