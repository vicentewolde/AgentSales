import { type AbortSignalLike, AppError, type InstagramAuth, isAppError } from "@agentsales/core";
import { z } from "zod";
import {
  INSTAGRAM_AUTHORIZE_URL,
  INSTAGRAM_CODE_EXCHANGE_URL,
  INSTAGRAM_GRAPH_ORIGIN,
  INSTAGRAM_REQUEST_TIMEOUT_MS,
  INSTAGRAM_SCOPES,
} from "./constants.js";
import {
  createInstagramGraph,
  type InstagramGraphOptions,
  instagramRequest,
  parseSingle,
} from "./graph.js";

export type InstagramAuthOptions = InstagramGraphOptions & {
  /** El "Identificador de la aplicación de Instagram" (`INSTAGRAM_APP_ID`), no el general. */
  appId: string;
  /** `INSTAGRAM_APP_SECRET`: solo viaja a Instagram, nunca a un error. */
  appSecret: string;
  /** Igual a una de las URIs de redirección del panel de Meta (`INSTAGRAM_REDIRECT_URI`). */
  redirectUri: string;
  /** Para calcular el vencimiento del token; por defecto, la hora actual. */
  now?: () => Date;
};

/** El canje en `api.instagram.com` (nota §3.2): `permissions` llega como texto con comas o lista. */
const shortTokenSchema = z.object({
  access_token: z.string().min(1),
  permissions: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      (typeof value === "string" ? value.split(",") : (value ?? []))
        .map((permission) => permission.trim())
        .filter((permission) => permission !== ""),
    ),
});
/** El token largo, del canje o del refresco (nota §3.3 y §3.4). */
const longTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

/** El código que trae la redirección, sin el `#_` que agrega Instagram al final (nota §3.1). */
export function cleanAuthorizationCode(code: string): string {
  return code.trim().replace(/#_?$/, "");
}

/**
 * Instagram Login (puerto `InstagramAuth` de core, spec F3 §4.6). El canje del token corto por el
 * largo y el refresco llevan el secret y el token en la URL, como los documenta Meta (nota §3.3 y
 * §3.4): esa URL nunca sale en un error ni en un log. `/me` usa la cabecera `Bearer`.
 */
export function createInstagramAuth(options: InstagramAuthOptions): InstagramAuth {
  const graph = createInstagramGraph(options);
  const origin = options.origin ?? INSTAGRAM_GRAPH_ORIGIN;
  const timeoutMs = options.timeoutMs ?? INSTAGRAM_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const expiresAt = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  return {
    authorizeUrl(state) {
      const url = new URL(INSTAGRAM_AUTHORIZE_URL);
      url.searchParams.set("client_id", options.appId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, { signal } = {}) {
      let short: z.infer<typeof shortTokenSchema>;
      try {
        const body = await instagramRequest(
          "exchangeCode",
          new URL(INSTAGRAM_CODE_EXCHANGE_URL),
          {
            method: "POST",
            form: {
              client_id: options.appId,
              client_secret: options.appSecret,
              grant_type: "authorization_code",
              redirect_uri: options.redirectUri,
              code: cleanAuthorizationCode(code),
            },
          },
          { signal, timeoutMs },
        );
        short = parseSingle("exchangeCode", shortTokenSchema, body);
      } catch (error) {
        // Un código vencido, usado o de otra URI vuelve como un 400 genérico: es un problema del
        // código, no de la app, y se resuelve conectando de nuevo.
        if (isAppError(error) && error.code === "IG_REQUEST_REJECTED") {
          throw new AppError(
            "IG_AUTH_INVALID",
            "Instagram no aceptó el código de conexión (venció, ya se usó o la dirección de retorno no coincide): conecta de nuevo",
            { details: error.details },
          );
        }
        throw error;
      }
      const long = await longToken(
        "exchangeLongLived",
        tokenUrl("access_token", {
          grant_type: "ig_exchange_token",
          client_secret: options.appSecret,
          access_token: short.access_token,
        }),
        signal,
      );
      return { ...long, permissions: short.permissions };
    },

    refresh(accessToken, { signal } = {}) {
      return longToken(
        "refresh",
        tokenUrl("refresh_access_token", {
          grant_type: "ig_refresh_token",
          access_token: accessToken,
        }),
        signal,
      );
    },

    me(accessToken, callOptions) {
      return graph.me(accessToken, callOptions);
    },
  };

  /** Las rutas del token van sin versión (nota §3.3 y §3.4). */
  function tokenUrl(path: string, query: Record<string, string>) {
    const url = new URL(`${origin}/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async function longToken(call: string, url: URL, signal: AbortSignalLike | undefined) {
    const body = await instagramRequest(call, url, { method: "GET" }, { signal, timeoutMs });
    const token = parseSingle(call, longTokenSchema, body);
    return { accessToken: token.access_token, expiresAt: expiresAt(token.expires_in) };
  }
}
