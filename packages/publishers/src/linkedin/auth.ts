import { AppError, LINKEDIN_TOKEN_DAYS, type LinkedInAuth } from "@agentsales/core";
import { z } from "zod";
import {
  LINKEDIN_API_ORIGIN,
  LINKEDIN_OAUTH_ORIGIN,
  LINKEDIN_REQUEST_TIMEOUT_MS,
  LINKEDIN_SCOPES,
} from "./constants.js";
import { LINKEDIN_ERRORS, linkedinHttpError } from "./errors.js";
import { linkedinFetch } from "./http.js";

export type LinkedInAuthOptions = {
  /** `LINKEDIN_CLIENT_ID` (pestaña Auth de la app en linkedin.com/developers). */
  clientId: string;
  /** `LINKEDIN_CLIENT_SECRET`: solo viaja a LinkedIn en el canje, nunca a un error. */
  clientSecret: string;
  /** Igual a una de las «Authorized redirect URLs» de la app (`LINKEDIN_REDIRECT_URI`). */
  redirectUri: string;
  /** Por defecto `https://www.linkedin.com` (autorización y canje). */
  oauthOrigin?: string;
  /** Por defecto `https://api.linkedin.com` (`/v2/userinfo`). */
  apiOrigin?: string;
  timeoutMs?: number;
  /** Para el vencimiento del token; por defecto, la hora actual. */
  now?: () => Date;
};

/** El canje (`linkedin.md` §3.1, paso 4): `scope` separado por comas o espacios; sin refresco. */
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
});

/** `GET /v2/userinfo` (OpenID Connect): `sub` y el nombre. */
const userinfoSchema = z.looseObject({
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
});

/** El error del canje (`{ error, error_description }`), sin copiar la descripción. */
function exchangeError({ httpStatus, body }: { httpStatus: number; body: unknown }): AppError {
  const code = (body as { error?: unknown } | null)?.error;
  const info = {
    call: "exchangeCode",
    httpStatus,
    ...(typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? { oauthError: code } : {}),
  };
  if (code === "invalid_client" || httpStatus === 401) {
    return new AppError(
      "LINKEDIN_APP_CREDENTIALS_INVALID",
      "LinkedIn no reconoce el par de la app: revisa LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET",
      { details: info },
    );
  }
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    // Un código vencido (30 min), usado o de otra dirección de retorno: se conecta de nuevo.
    return new AppError(
      "LINKEDIN_AUTH_INVALID",
      "LinkedIn no aceptó la autorización (venció, ya se usó o la dirección de retorno no coincide): conecta de nuevo",
      { details: info },
    );
  }
  return linkedinHttpError({ httpStatus, body, call: "exchangeCode" });
}

/**
 * OAuth del perfil personal de LinkedIn (puerto `LinkedInAuth` de core; spec F9 §4.7, F9-T15;
 * `linkedin.md` §3): la URL de autorización con `openid profile w_member_social` y el `state`, el
 * canje del código (con el secret, en el servidor, como formulario) y `/v2/userinfo` con `Bearer`.
 * El token dura 60 días y no trae refresco (app self-serve): si el canje no dice `expires_in`, se
 * supone 60 días. Ningún error lleva el código, el token ni el secret.
 */
export function createLinkedInAuth(options: LinkedInAuthOptions): LinkedInAuth {
  const oauthOrigin = options.oauthOrigin ?? LINKEDIN_OAUTH_ORIGIN;
  const apiOrigin = options.apiOrigin ?? LINKEDIN_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? LINKEDIN_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    authorizeUrl(state) {
      const url = new URL(`${oauthOrigin}/oauth/v2/authorization`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, { signal } = {}) {
      const { body } = await linkedinFetch({
        call: "exchangeCode",
        url: new URL(`${oauthOrigin}/oauth/v2/accessToken`),
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code.trim(),
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: options.redirectUri,
        }),
        timeoutMs,
        signal,
        onError: exchangeError,
      });
      const parsed = tokenSchema.safeParse(body);
      if (!parsed.success) throw LINKEDIN_ERRORS.unexpectedResponse("exchangeCode");
      const seconds = parsed.data.expires_in ?? LINKEDIN_TOKEN_DAYS * 24 * 60 * 60;
      const scopes =
        parsed.data.scope === undefined
          ? null
          : parsed.data.scope
              .split(/[\s,]+/)
              .map((scope) => scope.trim())
              .filter((scope) => scope !== "");
      return {
        accessToken: parsed.data.access_token,
        expiresAt: new Date(now().getTime() + seconds * 1000),
        scopes,
      };
    },

    async me(accessToken, { signal } = {}) {
      const { body } = await linkedinFetch({
        call: "userinfo",
        url: new URL(`${apiOrigin}/v2/userinfo`),
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        timeoutMs,
        signal,
      });
      const parsed = userinfoSchema.safeParse(body);
      if (!parsed.success) throw LINKEDIN_ERRORS.unexpectedResponse("userinfo");
      const { sub, name, given_name: given, family_name: family } = parsed.data;
      const full = name?.trim() || [given, family].filter(Boolean).join(" ").trim();
      return { memberId: sub, name: full };
    },
  };
}
