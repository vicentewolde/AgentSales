import { createHash, randomBytes } from "node:crypto";
import {
  type AbortSignalLike,
  AppError,
  isAppError,
  X_OAUTH_SCOPES,
  type XAuth,
  type XCodeExchange,
  type XUser,
} from "@agentsales/core";
import { z } from "zod";
import {
  X_API_ORIGIN,
  X_AUTHORIZE_URL,
  X_REQUEST_TIMEOUT_MS,
  X_TOKEN_TIMEOUT_MS,
} from "./constants.js";
import { X_ERRORS } from "./errors.js";
import { xRequest } from "./http.js";

// OAuth 2.0 con PKCE de X (spec F9 §4.6 y §4.7, F9-T16; `x.md` §3.1): cliente confidencial (Web
// App) con el par de la app en `Authorization: Basic`. Lo que es NO VERIFICADO (el esquema exacto
// de la autenticación del cliente, si el refresh token rota y la forma del error con uno usado) lo
// confirma la prueba S4 antes de publicar de verdad.

export type XAuthOptions = {
  clientId: string;
  clientSecret: string;
  /** `X_REDIRECT_URI`: igual, letra por letra, a una registrada en la app (`x.md` §3.1). */
  redirectUri: string;
  /** Por defecto `https://api.x.com`. */
  origin?: string;
  /** Tope del canje y del refresco; por defecto 10 s (`X_TOKEN_TIMEOUT_MS`). */
  tokenTimeoutMs?: number;
  /** Tope de `GET /2/users/me`; por defecto 30 s. */
  timeoutMs?: number;
  now?: () => Date;
};

/** Un verificador de PKCE y su desafío S256 (RFC 7636): 32 bytes al azar en base64url. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** El desafío S256 de un verificador: `base64url(sha256(verificador))`. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

/** Un token de X: texto sin espacios de largo razonable (nunca se valida más ni se muestra). */
const tokenSchema = z.string().regex(/^\S{10,4096}$/);

const tokenResponseSchema = z.looseObject({
  access_token: tokenSchema,
  refresh_token: tokenSchema.nullish(),
  expires_in: z.number().int().positive().nullish(),
  scope: z.string().nullish(),
});

const meSchema = z.looseObject({
  data: z.looseObject({
    id: z.union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative()]).transform(String),
    username: z.string().regex(/^\w{1,50}$/),
    name: z.string().nullish(),
  }),
});

/** Sin `expires_in`, el access token se supone de 1 h (conservador: X dice 2 h, `x.md` §3.1). */
const DEFAULT_EXPIRES_IN_S = 60 * 60;

/**
 * El cliente del OAuth de X (`XAuth`, también `PlatformTokenRefresher`). Ningún error lleva el
 * código, el verificador, los tokens ni el par de la app.
 * - `exchangeCode`: `POST /2/oauth2/token` con `grant_type=authorization_code`, el código, la
 *   dirección de retorno y el verificador. Sin `refresh_token` (falta `offline.access`),
 *   `X_PERMISSION_MISSING`.
 * - `refresh`: con `grant_type=refresh_token`, con su propio tope de 10 s. Si X devuelve un
 *   refresh token nuevo, ese es el que vale (supone rotación, `x.md` §3.1); si no devuelve uno, se
 *   conserva el anterior (no rotó).
 * - `isRejected`: **solo** `invalid_grant` (el refresh token venció, se revocó o ya se usó) deja la
 *   cuenta vencida; la red, un 5xx, un 429 o el par de la app suben sin cambiarla.
 */
export function createXAuth(options: XAuthOptions): XAuth {
  const origin = options.origin ?? X_API_ORIGIN;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? X_TOKEN_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? X_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const basic = `Basic ${Buffer.from(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
  ).toString("base64")}`;

  const tokenCall = async (
    call: "exchangeCode" | "refresh",
    form: Record<string, string>,
    signal: AbortSignalLike | undefined,
  ) => {
    const body = await xRequest(
      call,
      new URL("/2/oauth2/token", origin),
      {
        method: "POST",
        authorization: basic,
        body: new URLSearchParams({ ...form, client_id: options.clientId }).toString(),
        contentType: "application/x-www-form-urlencoded",
      },
      { ...(signal === undefined ? {} : { signal }), timeoutMs: tokenTimeoutMs, now },
    );
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw X_ERRORS.unexpectedResponse(call);
    return parsed.data;
  };

  return {
    authorizeUrl(state, codeChallenge) {
      const url = new URL(X_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("scope", X_OAUTH_SCOPES.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async exchangeCode(code, codeVerifier, { signal } = {}): Promise<XCodeExchange> {
      const issuedAt = now();
      const tokens = await tokenCall(
        "exchangeCode",
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          code_verifier: codeVerifier,
        },
        signal,
      );
      if (tokens.refresh_token == null) {
        throw new AppError(
          "X_PERMISSION_MISSING",
          "X no entregó el permiso para seguir conectado (offline.access): vuelve a conectar y acéptalo",
          { details: { missing: ["offline.access"] } },
        );
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: new Date(
          issuedAt.getTime() + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000,
        ),
        refreshTokenExpiresAt: null,
        scopes: (tokens.scope ?? "").split(/\s+/).filter((scope) => scope !== ""),
      };
    },

    async refresh(refreshToken, { signal } = {}) {
      const issuedAt = now();
      const tokens = await tokenCall(
        "refresh",
        { grant_type: "refresh_token", refresh_token: refreshToken },
        signal,
      );
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? refreshToken,
        accessTokenExpiresAt: new Date(
          issuedAt.getTime() + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000,
        ),
        refreshTokenExpiresAt: null,
      };
    },

    isRejected(error) {
      return (
        isAppError(error) &&
        error.code === "X_AUTH_INVALID" &&
        (error.details as { oauthError?: unknown } | undefined)?.oauthError === "invalid_grant"
      );
    },

    async me(accessToken, { signal } = {}): Promise<XUser> {
      const body = await xRequest(
        "me",
        new URL("/2/users/me", origin),
        { method: "GET", authorization: `Bearer ${accessToken}` },
        { ...(signal === undefined ? {} : { signal }), timeoutMs, now },
      );
      const parsed = meSchema.safeParse(body);
      if (!parsed.success) throw X_ERRORS.unexpectedResponse("me");
      return {
        id: parsed.data.data.id,
        username: parsed.data.data.username,
        name: parsed.data.data.name?.trim() || parsed.data.data.username,
      };
    },
  };
}
