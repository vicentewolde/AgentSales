import type { AppType } from "@agentsales/api";
import { errorBodySchema } from "@agentsales/api/contracts";
import { hc } from "hono/client";
import type { z } from "zod";

/** Mayor que el peor caso de `/health` en la API (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 35_000;

/**
 * Error de la API o de llegar a ella. `code` es el de su `ErrorBody`, o `UNREACHABLE`, `TIMEOUT` y
 * `UNEXPECTED_RESPONSE`; `status` falta si no hubo respuesta.
 */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  timeoutMs?: number;
  /** Solo para tests: la API en proceso (`app.request`), sin red. */
  fetch?: Fetch;
};

/**
 * Cliente RPC tipado (`hc<AppType>`) con toda la API, a través del proxy de Vite (`/api` → API,
 * spec F0 §4.5). Cada petición tiene timeout; no llegar a la API es `ApiError`. La respuesta se
 * lee con `unwrap`.
 */
export function createApiClient(baseUrl = "/api", options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  // `fetch` se busca al llamar (no al crear el cliente), así un test puede reemplazarlo.
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return hc<AppType>(baseUrl, {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        return await send(input, { ...init, signal });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new ApiError(`La API no respondió en ${timeoutMs / 1000} s`, "TIMEOUT");
        }
        // Una cancelación (TanStack Query al desmontar) sigue su curso: no es un fallo.
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ApiError("La API no responde", "UNREACHABLE");
      }
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

type ApiResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * Lee la respuesta: un error de la API (`ErrorBody`) se lanza como `CODE: mensaje`, y una
 * respuesta exitosa se valida con su esquema de `@agentsales/api/contracts`.
 */
export async function unwrap<S extends z.ZodType>(
  response: ApiResponse | Promise<ApiResponse>,
  schema: S,
): Promise<z.output<S>> {
  const res = await response;
  const body: unknown = await res.json().catch((error: unknown) => {
    // El timeout sigue corriendo mientras llega el cuerpo: un corte ahí no es "otra forma".
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ApiError("La API dejó de responder a mitad de la respuesta", "TIMEOUT", res.status);
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  });
  if (!res.ok) {
    const parsed = errorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message } = parsed.data.error;
      throw new ApiError(`${code}: ${message}`, code, res.status);
    }
    // El proxy de Vite responde 5xx sin JSON cuando la API está apagada.
    throw res.status >= 500
      ? new ApiError(`La API no responde (HTTP ${res.status})`, "UNREACHABLE", res.status)
      : new ApiError(`La API respondió ${res.status}`, undefined, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      "Respuesta inesperada de la API: ¿otro servicio en el puerto, o una versión distinta?",
      "UNEXPECTED_RESPONSE",
      res.status,
    );
  }
  return parsed.data;
}
