import { type AbortSignalLike, type AppError, isAppError } from "@agentsales/core";
import {
  LINKEDIN_ERRORS,
  linkedinHttpError,
  networkCodeOf,
  PRE_CONNECT_ERROR_CODES,
} from "./errors.js";

/** Una llamada a LinkedIn. `call` nombra la llamada en los errores (nunca la URL). */
export type LinkedInRequest = {
  call: string;
  url: URL;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams;
  timeoutMs: number;
  signal?: AbortSignalLike | undefined;
  /** Cómo convertir una respuesta de error; por defecto `linkedinHttpError`. */
  onError?: (response: { httpStatus: number; body: unknown }) => AppError;
};

/** Una respuesta 2xx: el status, las cabeceras y el cuerpo JSON (`null` sin cuerpo o si no es JSON). */
export type LinkedInResponse = { status: number; headers: Headers; body: unknown };

/**
 * Hace una llamada y devuelve la respuesta 2xx, o lanza el `AppError` que corresponde: el de la
 * respuesta (`linkedinHttpError`, o `onError`) o uno de `LINKEDIN_ERRORS` sin respuesta. Ningún
 * error lleva la URL, las cabeceras (el token), el cuerpo enviado, la causa de `fetch` ni el
 * mensaje de LinkedIn. No sigue redirecciones (reenviarían el token o los bytes a otro lado). No
 * escribe logs.
 */
export async function linkedinFetch(request: LinkedInRequest): Promise<LinkedInResponse> {
  const { call, signal } = request;
  if (signal?.aborted) throw LINKEDIN_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(request.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers ?? {},
        ...(request.body === undefined
          ? {}
          : {
              body:
                request.body instanceof Uint8Array
                  ? (request.body as Uint8Array<ArrayBuffer>)
                  : request.body,
            }),
        redirect: "manual",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch (failure) {
      if (caller.signal.aborted) throw LINKEDIN_ERRORS.aborted();
      if (timeout.aborted) throw LINKEDIN_ERRORS.unavailable(call, "timeout");
      const code = networkCodeOf(failure);
      if (code !== null && PRE_CONNECT_ERROR_CODES.has(code)) {
        throw LINKEDIN_ERRORS.unreachable(call);
      }
      throw LINKEDIN_ERRORS.unavailable(call, "network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (caller.signal.aborted) throw LINKEDIN_ERRORS.aborted();
      throw LINKEDIN_ERRORS.unavailable(call, timeout.aborted ? "timeout" : "network");
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Un cuerpo que no es JSON: lo decide el status.
    }
    if (response.status < 200 || response.status >= 300) {
      const httpStatus = response.status;
      throw (
        request.onError?.({ httpStatus, body }) ??
        linkedinHttpError({
          httpStatus,
          body,
          call,
          retryAfterHeader: response.headers.get("retry-after"),
        })
      );
    }
    return { status: response.status, headers: response.headers, body };
  } catch (failure) {
    if (isAppError(failure)) throw failure;
    throw LINKEDIN_ERRORS.unexpectedResponse(call);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
