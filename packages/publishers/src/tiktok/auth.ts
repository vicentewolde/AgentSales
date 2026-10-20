import { TIKTOK_SCOPES, type TikTokAuth } from "@agentsales/core";
import { z } from "zod";
import {
  TIKTOK_API_ORIGIN,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_PATHS,
  TIKTOK_REFRESH_TIMEOUT_MS,
  TIKTOK_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { isTikTokRefreshRejected } from "./errors.js";
import { parseTikTokBody, tiktokRequest } from "./http.js";

export type TikTokAuthOptions = {
  /** `TIKTOK_CLIENT_KEY` (va en la URL de autorización: no es secreto). */
  clientKey: string;
  /** `TIKTOK_CLIENT_SECRET`: solo viaja a TikTok en el cuerpo, nunca a un error. */
  clientSecret: string;
  /** `TIKTOK_REDIRECT_URI`: igual, letra por letra, a la registrada en la app. */
  redirectUri: string;
  /** Por defecto `https://open.tiktokapis.com`. */
  origin?: string;
  /** Tope del canje y del usuario; por defecto `TIKTOK_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Tope de la renovación: el menor entre este y `timeoutMs`. Por defecto
   * `TIKTOK_REFRESH_TIMEOUT_MS` (10 s: corre dentro del candado de la cuenta, ADR-0029 punto 11).
   */
  refreshTimeoutMs?: number;
  now?: () => Date;
};

/** Un token: sin espacios y de un largo que cabe en una cabecera. */
const tokenSchema = z.string().regex(/^[\x21-\x7e]{1,2048}$/);
/** Segundos de vida: entero positivo (como número o texto con dígitos), hasta 2 años. */
const secondsSchema = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(
  z
    .number()
    .int()
    .positive()
    .max(2 * 366 * 24 * 60 * 60),
);
const scopeSchema = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => (value ?? "").split(/[\s,]+/).filter((scope) => scope !== ""));

/** La respuesta del canje y de la renovación (`tiktok.md` §4). */
const tokenResponseSchema = z.object({
  access_token: tokenSchema,
  refresh_token: tokenSchema,
  open_id: z.string().min(1).max(200),
  expires_in: secondsSchema,
  refresh_expires_in: secondsSchema.optional().catch(undefined),
  scope: scopeSchema,
});

const userResponseSchema = z.object({
  data: z.object({
    user: z.object({
      open_id: z.string().min(1).max(200),
      display_name: z.string().max(200).nullish(),
    }),
  }),
});

/**
 * OAuth de TikTok (Login Kit web; puerto `TikTokAuth` de core, spec F9 §4.7, F9-T26): autorización
 * en `www.tiktok.com/v2/auth/authorize/` con `client_key`, los permisos separados por comas y el
 * `state` firmado (sin PKCE: la web no lo usa, `tiktok.md` §4); canje y renovación en
 * `POST /v2/oauth/token/` con los datos en el cuerpo (nunca en la URL), y la cuenta en
 * `GET /v2/user/info/` con `Bearer`. La renovación tiene su propio tope de 10 s y entrega el par
 * que pudo rotar (`refresh_token` nuevo); solo `invalid_grant` es un rechazo (`isRejected`). Ningún
 * error lleva el secret, el código ni los tokens; no escribe logs.
 */
export function createTikTokAuth(options: TikTokAuthOptions): TikTokAuth {
  const origin = options.origin ?? TIKTOK_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? TIKTOK_REQUEST_TIMEOUT_MS;
  const refreshTimeoutMs = Math.min(
    timeoutMs,
    options.refreshTimeoutMs ?? TIKTOK_REFRESH_TIMEOUT_MS,
  );
  const now = options.now ?? (() => new Date());
  const after = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  return {
    authorizeUrl(state) {
      const url = new URL(TIKTOK_AUTHORIZE_URL);
      url.searchParams.set("client_key", options.clientKey);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, { signal } = {}) {
      const body = await tiktokRequest(
        "exchangeCode",
        new URL(TIKTOK_PATHS.token, origin),
        {
          method: "POST",
          style: "oauth",
          form: {
            client_key: options.clientKey,
            client_secret: options.clientSecret,
            code: code.trim(),
            grant_type: "authorization_code",
            redirect_uri: options.redirectUri,
          },
        },
        { signal, timeoutMs },
      );
      const tokens = parseTikTokBody("exchangeCode", tokenResponseSchema, body);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        openId: tokens.open_id,
        scopes: tokens.scope,
        accessTokenExpiresAt: after(tokens.expires_in),
        refreshTokenExpiresAt:
          tokens.refresh_expires_in === undefined ? null : after(tokens.refresh_expires_in),
      };
    },

    async refresh(refreshToken, { signal } = {}) {
      const body = await tiktokRequest(
        "refresh",
        new URL(TIKTOK_PATHS.token, origin),
        {
          method: "POST",
          style: "oauth",
          form: {
            client_key: options.clientKey,
            client_secret: options.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          },
        },
        { signal, timeoutMs: refreshTimeoutMs },
      );
      // Sin el par (el anterior pudo dejar de servir), `TIKTOK_UNEXPECTED_RESPONSE`.
      const tokens = parseTikTokBody("refresh", tokenResponseSchema, body);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: after(tokens.expires_in),
        refreshTokenExpiresAt:
          tokens.refresh_expires_in === undefined ? null : after(tokens.refresh_expires_in),
      };
    },

    isRejected: isTikTokRefreshRejected,

    async user(accessToken, { signal } = {}) {
      const url = new URL(TIKTOK_PATHS.userInfo, origin);
      url.searchParams.set("fields", "open_id,display_name");
      const body = await tiktokRequest(
        "user",
        url,
        { method: "GET", style: "api", accessToken },
        { signal, timeoutMs },
      );
      const { user } = parseTikTokBody("user", userResponseSchema, body).data;
      return { openId: user.open_id, displayName: user.display_name ?? "" };
    },
  };
}
