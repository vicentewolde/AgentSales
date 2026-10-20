import type { AbortSignalLike } from "@agentsales/core";
import type { z } from "zod";
import { TIKTOK_ERRORS, tiktokApiError, tiktokFetchFailure, tiktokOAuthError } from "./errors.js";

/** Opciones de cada llamada. */
export type TikTokCallOptions = { signal?: AbortSignalLike };

/**
 * Un pedido a la API de TikTok, con tope y la señal de quien llama. `style` dice cómo vienen los
 * errores: `oauth` (`{ "error": "invalid_grant" }`, el token) o `api` (`{ "error": { "code" } }`,
 * todo lo demás; éxito con `code: "ok"`). Devuelve el cuerpo JSON; ningún error lleva el token ni el
 * cuerpo enviado.
 */
export async function tiktokRequest(
  call: string,
  url: URL,
  request: {
    method: "GET" | "POST";
    style: "oauth" | "api";
    accessToken?: string;
    json?: unknown;
    form?: Record<string, string>;
  },
  { signal, timeoutMs }: { signal?: AbortSignalLike | undefined; timeoutMs: number },
): Promise<unknown> {
  if (signal?.aborted) throw TIKTOK_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = {};
  if (request.accessToken !== undefined) headers.authorization = `Bearer ${request.accessToken}`;
  let body: string | undefined;
  if (request.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  } else if (request.json !== undefined) {
    headers["content-type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(request.json);
  }
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch (caught) {
      throw tiktokFetchFailure(call, caught, {
        aborted: caller.signal.aborted,
        timedOut: timeout.aborted,
      });
    }
    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text === "" ? null : (JSON.parse(text) as unknown);
    } catch (caught) {
      if (caller.signal.aborted || timeout.aborted) {
        throw tiktokFetchFailure(call, caught, {
          aborted: caller.signal.aborted,
          timedOut: timeout.aborted,
        });
      }
      // Un cuerpo que no es JSON: un 5xx de un proxy, o una respuesta rota.
      if (response.status >= 500) throw TIKTOK_ERRORS.unavailable(call, "server", response.status);
      if (!response.ok) throw tiktokApiError(call, response.status, null);
      throw TIKTOK_ERRORS.unexpectedResponse(call);
    }
    if (request.style === "oauth") {
      const hasError =
        typeof (parsed as { error?: unknown } | null)?.error === "string" &&
        (parsed as { error: string }).error !== "";
      if (!response.ok || hasError) throw tiktokOAuthError(call, response.status, parsed);
      return parsed;
    }
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    if (!response.ok || (code !== undefined && code !== "ok")) {
      throw tiktokApiError(call, response.status, parsed);
    }
    return parsed;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Lee el cuerpo con su esquema; si no calza, `TIKTOK_UNEXPECTED_RESPONSE` (sin el cuerpo). */
export function parseTikTokBody<S extends z.ZodType>(
  call: string,
  schema: S,
  body: unknown,
): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw TIKTOK_ERRORS.unexpectedResponse(call);
  return parsed.data;
}
