import { type AbortSignalLike, isAppError } from "@agentsales/core";
import { networkCodeOf, PRE_CONNECT_ERROR_CODES, X_ERRORS, xHttpError } from "./errors.js";

/** Opciones de cada llamada a X. */
export type XCallOptions = { signal?: AbortSignalLike };

export type XRequestSpec = {
  method: "GET" | "POST";
  /** `Bearer <token>` o `Basic <par de la app>`. Nunca va a un error. */
  authorization: string;
  body?: FormData | string | URLSearchParams;
  /** `null` en `multipart`: el separador lo pone `fetch`. */
  contentType?: string | null;
  /** Una respuesta sin cuerpo (como la de `append`, 2xx vacío) es válida. */
  allowEmpty?: boolean;
};

/**
 * Hace una llamada a X y devuelve el JSON (o `null` con `allowEmpty`), o lanza el `AppError` que
 * corresponde (`xHttpError`, y los de `X_ERRORS` sin respuesta). Ningún error lleva la URL con sus
 * datos, la autorización, la causa de `fetch` ni el mensaje de X. No sigue redirecciones.
 */
export async function xRequest(
  call: string,
  target: URL,
  init: XRequestSpec,
  { signal, timeoutMs, now }: XCallOptions & { timeoutMs: number; now?: () => Date },
): Promise<unknown> {
  if (signal?.aborted) throw X_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: init.authorization,
  };
  if (init.contentType != null) headers["Content-Type"] = init.contentType;
  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch (failure) {
      if (caller.signal.aborted) throw X_ERRORS.aborted();
      if (timeout.aborted) throw X_ERRORS.unavailable(call, "timeout");
      const code = networkCodeOf(failure);
      if (code !== null && PRE_CONNECT_ERROR_CODES.has(code)) throw X_ERRORS.unreachable(call);
      throw X_ERRORS.unavailable(call, "network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (caller.signal.aborted) throw X_ERRORS.aborted();
      throw X_ERRORS.unavailable(call, timeout.aborted ? "timeout" : "network");
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Un cuerpo que no es JSON: lo decide el status.
    }
    if (!response.ok) {
      throw xHttpError({
        call,
        httpStatus: response.status,
        body,
        headers: response.headers,
        ...(now === undefined ? {} : { now: now() }),
      });
    }
    if (body === null && init.allowEmpty !== true) throw X_ERRORS.unexpectedResponse(call);
    return body;
  } catch (failure) {
    if (isAppError(failure)) throw failure;
    throw X_ERRORS.unexpectedResponse(call);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
