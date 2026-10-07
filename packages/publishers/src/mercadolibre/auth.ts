import {
  type AbortSignalLike,
  AppError,
  isAppError,
  type MercadoLibreAuth,
  type MercadoLibreTokens,
} from "@agentsales/core";
import { z } from "zod";
import {
  MERCADOLIBRE_API_ORIGIN,
  MERCADOLIBRE_AUTHORIZE_URL,
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
  /** Para calcular el vencimiento del `access_token`; por defecto, la hora actual. */
  now?: () => Date;
};

/** Un token de la respuesta: si no cabe en una cabecera, no sirve guardarlo. */
const tokenSchema = z.string().refine(isWellFormedToken);

/** La respuesta del canje y del refresco (nota §3.1 y §3.2). */
const tokenResponseSchema = z.object({
  access_token: tokenSchema,
  expires_in: z.coerce.number().int().positive(),
  scope: z
    .string()
    .optional()
    .transform((value) => (value ?? "").split(/[\s,]+/).filter((scope) => scope !== "")),
  user_id: idSchema,
  refresh_token: tokenSchema.nullish().transform((value) => value ?? null),
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
  const now = options.now ?? (() => new Date());

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
      try {
        return await requestTokens(
          "exchangeCode",
          {
            grant_type: "authorization_code",
            client_id: options.appId,
            client_secret: options.clientSecret,
            code: code.trim(),
            redirect_uri: options.redirectUri,
          },
          signal,
        );
      } catch (error) {
        // `invalid_grant` en el canje es un problema del código (venció, ya se usó o la dirección
        // de retorno no coincide, nota §3.2), no de una cuenta: se resuelve conectando de nuevo.
        if (isAppError(error) && error.code === "ML_AUTH_INVALID") {
          throw new AppError(
            "ML_AUTH_INVALID",
            "Mercado Libre no aceptó el código de conexión (venció, ya se usó o la dirección de retorno no coincide): conecta de nuevo",
            { details: error.details },
          );
        }
        throw error;
      }
    },

    async refresh(refreshToken, { signal } = {}) {
      if (!isWellFormedToken(refreshToken)) throw MERCADOLIBRE_ERRORS.malformedToken();
      const tokens = await requestTokens(
        "refresh",
        {
          grant_type: "refresh_token",
          client_id: options.appId,
          client_secret: options.clientSecret,
          refresh_token: refreshToken,
        },
        signal,
      );
      // El anterior ya no sirve (uso único): sin el nuevo, la cuenta quedaría sin forma de refrescar.
      if (tokens.refreshToken === null) throw MERCADOLIBRE_ERRORS.unexpectedResponse("refresh");
      return { ...tokens, refreshToken: tokens.refreshToken };
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

  async function requestTokens(
    call: string,
    form: Record<string, string>,
    signal: AbortSignalLike | undefined,
  ): Promise<MercadoLibreTokens & { refreshToken: string | null }> {
    const body = await mercadoLibreRequest(
      call,
      new URL(MERCADOLIBRE_TOKEN_PATH, origin),
      { method: "POST", form },
      { signal, timeoutMs },
    );
    const tokens = parseBody(call, tokenResponseSchema, body);
    return {
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(now().getTime() + tokens.expires_in * 1000),
      scopes: tokens.scope,
      userId: tokens.user_id,
      refreshToken: tokens.refresh_token,
    };
  }
}
