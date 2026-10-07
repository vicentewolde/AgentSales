import {
  type AbortSignalLike,
  AppError,
  isAppError,
  type MercadoLibreAuth,
} from "@agentsales/core";
import { z } from "zod";
import {
  MERCADOLIBRE_API_ORIGIN,
  MERCADOLIBRE_AUTHORIZE_URL,
  MERCADOLIBRE_FALLBACK_EXPIRES_IN_S,
  MERCADOLIBRE_MAX_EXPIRES_IN_S,
  MERCADOLIBRE_REFRESH_TIMEOUT_MS,
  MERCADOLIBRE_REQUEST_TIMEOUT_MS,
  MERCADOLIBRE_TOKEN_PATH,
} from "./constants.js";
import { MERCADOLIBRE_ERRORS } from "./errors.js";
import {
  idSchema,
  isWellFormedToken,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
  parseBody,
} from "./http.js";

export type MercadoLibreAuthOptions = MercadoLibreHttpOptions & {
  /** `ML_APP_ID`. */
  appId: string;
  /** `ML_CLIENT_SECRET`: solo viaja a Mercado Libre en el cuerpo, nunca a un error. */
  clientSecret: string;
  /** `ML_REDIRECT_URI`: igual, letra por letra, a la registrada en la app (nota §3.1). */
  redirectUri: string;
  /**
   * Tope del refresco: el menor entre este y `timeoutMs`. Por defecto
   * `MERCADOLIBRE_REFRESH_TIMEOUT_MS` (10 s, dentro del candado de la cuenta, ADR-0015).
   */
  refreshTimeoutMs?: number;
  /** Para calcular el vencimiento del `access_token`; por defecto, la hora actual. */
  now?: () => Date;
};

/** Un token de la respuesta: si no cabe en una cabecera, no sirve guardarlo. */
const tokenSchema = z.string().refine(isWellFormedToken);
/** Segundos de vida del `access_token`: entero positivo, como número o texto con dígitos. */
const expiresInSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().positive().max(MERCADOLIBRE_MAX_EXPIRES_IN_S));
const scopeSchema = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => (value ?? "").split(/[\s,]+/).filter((scope) => scope !== ""));

/** La respuesta del canje (nota §3.1): todo lo que T06 guarda al conectar. */
const exchangeResponseSchema = z.object({
  access_token: tokenSchema,
  expires_in: expiresInSchema,
  scope: scopeSchema,
  user_id: idSchema,
  refresh_token: tokenSchema.nullish().transform((value) => value ?? null),
});

/**
 * La respuesta del refresco (nota §3.2): solo exige el par, porque Mercado Libre ya invalidó el
 * `refresh_token` anterior y descartar la respuesta obligaría a reconectar (ADR-0015). Lo demás,
 * si no viene o no se entiende, queda sin valor (`expires_in`: el conservador de 1 h).
 */
const refreshResponseSchema = z.object({
  access_token: tokenSchema,
  refresh_token: tokenSchema,
  expires_in: expiresInSchema.optional().catch(undefined),
  scope: scopeSchema,
  user_id: idSchema.optional().catch(undefined),
});

/** `GET /users/me` (nota §3.2): solo lo que se guarda en la cuenta. */
const userSchema = z.object({
  id: idSchema,
  nickname: z.string().min(1),
  site_id: z.string().min(1),
  user_type: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  tags: z
    .array(z.string())
    .optional()
    .catch(undefined)
    .transform((value) => value ?? []),
});

/**
 * OAuth y usuario de Mercado Libre (puerto `MercadoLibreAuth` de core, spec F4 §4.2): autorización
 * en `auth.mercadolibre.cl` sin PKCE (D3), canje y refresco en `POST /oauth/token` con los
 * parámetros en el cuerpo (nunca en la URL) y `GET /users/me` con la cabecera `Bearer`. Ningún error
 * lleva el secret, el código ni los tokens; no escribe logs.
 */
export function createMercadoLibreAuth(options: MercadoLibreAuthOptions): MercadoLibreAuth {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;
  const refreshTimeoutMs = Math.min(
    timeoutMs,
    options.refreshTimeoutMs ?? MERCADOLIBRE_REFRESH_TIMEOUT_MS,
  );
  const now = options.now ?? (() => new Date());
  const expiresAt = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  return {
    authorizeUrl(state) {
      const url = new URL(MERCADOLIBRE_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.appId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, { signal } = {}) {
      let body: unknown;
      try {
        body = await tokenRequest(
          "exchangeCode",
          {
            grant_type: "authorization_code",
            client_id: options.appId,
            client_secret: options.clientSecret,
            code: code.trim(),
            redirect_uri: options.redirectUri,
          },
          signal,
          timeoutMs,
        );
      } catch (error) {
        // `invalid_grant` en el canje es un problema del código o de la cuenta del vendedor (nota
        // §3.2), no de una cuenta conectada: se resuelve conectando de nuevo.
        if (isAppError(error) && error.code === "ML_AUTH_INVALID") {
          throw new AppError(
            "ML_AUTH_INVALID",
            "Mercado Libre no aceptó el código de conexión (venció, ya se usó, la dirección de retorno no coincide o la cuenta tiene datos pendientes de validar): conecta de nuevo",
            { details: error.details },
          );
        }
        throw error;
      }
      const tokens = parseBody("exchangeCode", exchangeResponseSchema, body);
      return {
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiresAt(tokens.expires_in),
        scopes: tokens.scope,
        userId: tokens.user_id,
        refreshToken: tokens.refresh_token,
      };
    },

    async refresh(refreshToken, { signal } = {}) {
      if (!isWellFormedToken(refreshToken)) throw MERCADOLIBRE_ERRORS.malformedToken();
      const body = await tokenRequest(
        "refresh",
        {
          grant_type: "refresh_token",
          client_id: options.appId,
          client_secret: options.clientSecret,
          refresh_token: refreshToken,
        },
        signal,
        refreshTimeoutMs,
      );
      // Sin el par nuevo (el anterior ya no sirve), `ML_UNEXPECTED_RESPONSE`.
      const tokens = parseBody("refresh", refreshResponseSchema, body);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: expiresAt(tokens.expires_in ?? MERCADOLIBRE_FALLBACK_EXPIRES_IN_S),
        scopes: tokens.scope,
        userId: tokens.user_id ?? null,
      };
    },

    async me(accessToken, { signal } = {}) {
      const body = await mercadoLibreRequest(
        "me",
        new URL("/users/me", origin),
        { method: "GET", accessToken },
        { signal, timeoutMs },
      );
      const user = parseBody("me", userSchema, body);
      return {
        userId: user.id,
        nickname: user.nickname,
        siteId: user.site_id,
        userType: user.user_type,
        tags: user.tags,
      };
    },
  };

  function tokenRequest(
    call: string,
    form: Record<string, string>,
    signal: AbortSignalLike | undefined,
    callTimeoutMs: number,
  ): Promise<unknown> {
    return mercadoLibreRequest(
      call,
      new URL(MERCADOLIBRE_TOKEN_PATH, origin),
      { method: "POST", body: { form } },
      { signal, timeoutMs: callTimeoutMs },
    );
  }
}
