import {
  type BrokerRepository,
  type ConnectAccountDeps,
  connectAccount,
  type InstagramAuth,
  isAppError,
} from "@agentsales/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { oauthStartQuerySchema } from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated } from "../validation.js";

/** Compara dos textos en tiempo constante (sin `node:crypto`: este módulo entra en `AppType`). */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie del `state` del OAuth: solo la ve la ruta de vuelta (`/oauth`). */
export const OAUTH_STATE_COOKIE = "agentsales_oauth_state";
/** El `state` vale 10 minutos (spec F3 §4.6). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Firma y verifica el `state` (lo implementa `createStateSigner` de `@agentsales/config`, que la
 * app no importa para no arrastrar Node a `AppType`). `verify` lanza `OAUTH_STATE_INVALID`.
 */
export type OAuthStateSigner = {
  sign(data: Record<string, string>, options: { ttlSeconds: number }): string;
  verify(token: string): Readonly<Record<string, string | number | boolean>>;
};

/**
 * La plataforma que va en el `state` (spec F4 §4.2): el nombre del proveedor del OAuth
 * (`mercadolibre`), no el valor del enum de la cuenta (`portal_inmobiliario`). Cada vuelta rechaza el
 * `state` de la otra.
 */
export const OAUTH_STATE_PLATFORMS = {
  instagram: "instagram",
  mercadolibre: "mercadolibre",
} as const;
export type OAuthStatePlatform = (typeof OAUTH_STATE_PLATFORMS)[keyof typeof OAUTH_STATE_PLATFORMS];

/**
 * Verifica un `state`: firma, vencimiento, la plataforma esperada y, si se pide, el corredor.
 * Devuelve el corredor, o `null` si algo no calza (quien llama responde `OAUTH_STATE_INVALID` sin
 * llamar a la plataforma). No es de un solo uso: el de Instagram se amarra a una cookie que se borra;
 * el de Mercado Libre vale sus 10 min (el código, en cambio, se canjea una sola vez; deuda de F7).
 */
export function verifyOAuthState(
  signer: OAuthStateSigner,
  state: string,
  expected: { platform: OAuthStatePlatform; broker?: string },
): string | null {
  let data: Readonly<Record<string, string | number | boolean>>;
  try {
    data = signer.verify(state);
  } catch {
    return null;
  }
  if (data.platform !== expected.platform || typeof data.broker !== "string") return null;
  if (expected.broker !== undefined && data.broker !== expected.broker) return null;
  return data.broker;
}

/**
 * Dónde empieza el OAuth (`connect.instagram.startUrl`, F3-T17): `/oauth/instagram/start` en el host
 * de la URI de retorno, porque la cookie del `state` distingue el host. Asume la API en la raíz del
 * host (deuda de F7 si se monta tras un prefijo).
 */
export function instagramStartUrlOf(redirectUri: string): string {
  return new URL("/oauth/instagram/start", redirectUri).toString();
}

export type OAuthDeps = Omit<ConnectAccountDeps, "instagram"> & {
  brokers: Pick<BrokerRepository, "findBySlug">;
  instagram: {
    auth: InstagramAuth;
    /** Si están `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` (sin ellos, el OAuth no puede canjear). */
    oauthConfigured: boolean;
    /** `Secure` en la cookie: cuando la URI de retorno es `https://` (F7). */
    secureCookie: boolean;
  };
  oauthState: OAuthStateSigner;
  /** La URL absoluta del panel (`http://localhost:<WEB_PORT>`): ahí vuelve el operador. */
  panelUrl: string;
  logger: AppLogger;
};

/**
 * `/oauth/instagram` (spec F3 §4.6): Instagram Login completo, implementado para F7 (con HTTPS) y
 * probado con dobles: en F3, Meta no acepta `http://localhost` y la cuenta se conecta con el token
 * del panel (D4). Las dos rutas responden con redirecciones, y la vuelta siempre termina en el panel
 * (`/cuentas?conectada=instagram` o `?error=<código>`), sin datos de la cuenta en la URL.
 */
export function oauthRoutes(deps: OAuthDeps) {
  const toPanel = (params: Record<string, string>) => {
    const url = new URL("/cuentas", deps.panelUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  };
  const cookieOptions = {
    path: "/oauth",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: deps.instagram.secureCookie,
  };

  return new Hono()
    .get("/instagram/start", validated("query", oauthStartQuerySchema), async (c) => {
      const { broker } = c.req.valid("query");
      if (!deps.instagram.oauthConfigured) {
        return c.redirect(toPanel({ error: "INSTAGRAM_NOT_CONFIGURED" }), 302);
      }
      if ((await deps.brokers.findBySlug(broker)) === null) {
        return c.redirect(toPanel({ error: "BROKER_NOT_FOUND" }), 302);
      }
      // Con la plataforma: un `state` de Mercado Libre no sirve en esta vuelta (spec F4 §4.2).
      const state = deps.oauthState.sign(
        { platform: OAUTH_STATE_PLATFORMS.instagram, broker },
        { ttlSeconds: OAUTH_STATE_TTL_SECONDS },
      );
      setCookie(c, OAUTH_STATE_COOKIE, state, {
        ...cookieOptions,
        maxAge: OAUTH_STATE_TTL_SECONDS,
      });
      return c.redirect(deps.instagram.auth.authorizeUrl(state), 302);
    })
    .get("/instagram/callback", async (c) => {
      const cookie = getCookie(c, OAUTH_STATE_COOKIE);
      // Un `state` sirve una sola vez: la cookie se borra pase lo que pase.
      deleteCookie(c, OAUTH_STATE_COOKIE, cookieOptions);
      const { code, state, error } = c.req.query();
      // El operador rechazó en Instagram: no es un error de la app, solo un aviso para el panel.
      if (error !== undefined) return c.redirect(toPanel({ error: "OAUTH_DENIED" }), 302);

      // Sin llamar a Instagram: un `state` ajeno, vencido, de otra plataforma o sin cookie no canjea.
      const broker =
        state === undefined || cookie === undefined || !sameText(state, cookie)
          ? null
          : verifyOAuthState(deps.oauthState, state, { platform: OAUTH_STATE_PLATFORMS.instagram });
      if (broker === null) return c.redirect(toPanel({ error: "OAUTH_STATE_INVALID" }), 302);
      if (code === undefined || code === "") {
        return c.redirect(toPanel({ error: "OAUTH_CODE_MISSING" }), 302);
      }
      // Sin el par de la app, el canje mandaría un `client_secret` vacío: ni se intenta.
      if (!deps.instagram.oauthConfigured) {
        return c.redirect(toPanel({ error: "INSTAGRAM_NOT_CONFIGURED" }), 302);
      }

      try {
        await connectAccount(
          { ...deps, instagram: deps.instagram.auth },
          { broker, grant: { kind: "oauth_code", code }, signal: c.req.raw.signal },
        );
        return c.redirect(toPanel({ conectada: "instagram" }), 302);
      } catch (caught) {
        const reason = isAppError(caught) ? caught.code : "INTERNAL_ERROR";
        // Solo el código (y el tipo, si no es de la app): el error puede traer detalles del canje.
        deps.logger.warn(
          isAppError(caught)
            ? { code: reason }
            : { code: reason, errorName: caught instanceof Error ? caught.name : typeof caught },
          "no se pudo conectar la cuenta de Instagram",
        );
        return c.redirect(toPanel({ error: reason }), 302);
      }
    });
}
