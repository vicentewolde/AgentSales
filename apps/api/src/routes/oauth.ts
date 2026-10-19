import {
  type BrokerRepository,
  type ConnectAccountDeps,
  can,
  connectAccount,
  connectMercadoLibreAccount,
  type InstagramAuth,
  isAppError,
  type MercadoLibreAuth,
  type OAuthStateRepository,
} from "@agentsales/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type AppEnv, requireAuth } from "../auth.js";
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

/** Cookie del `state` del OAuth de Instagram (sin HTTPS, la de F3). */
export const OAUTH_STATE_COOKIE = "agentsales_oauth_state";

/**
 * El nombre de la cookie del `state` de Instagram (spec F8 §4.3): con HTTPS, `__Host-` (el navegador
 * la exige `Secure`, `Path=/` y sin `Domain`) y una por proveedor (`_ig`; la de Mercado Libre llega
 * con F8-T19), para que dos conexiones no se pisen.
 */
export const instagramStateCookieName = (secure: boolean): string =>
  secure ? "__Host-agentsales_oauth_ig" : OAUTH_STATE_COOKIE;
/**
 * La cookie del `state` de Mercado Libre (spec F8 §4.3, T19): la pone `authorize-url`, y la vuelta
 * la exige igual al `state` de la URL. Con HTTPS, `__Host-agentsales_oauth_ml`; sin él, la de
 * desarrollo. Una por proveedor: dos conexiones no se pisan.
 */
export const mercadoLibreStateCookieName = (secure: boolean): string =>
  secure ? "__Host-agentsales_oauth_ml" : "agentsales_oauth_state_ml";

/** `Lax` (la vuelta llega desde `auth.mercadolibre.cl`), `Path=/` y sin `Domain`, como la de Instagram. */
export const oauthStateCookieOptions = (secure: boolean) => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  secure,
});

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
 * Devuelve el corredor con el nonce y el vencimiento, o `null` si algo no calza (quien llama
 * responde `OAUTH_STATE_INVALID` sin llamar a la plataforma). El de Instagram se amarra además a una
 * cookie que se borra; los dos sirven una vez (Mercado Libre desde F7, Instagram desde F8-T17: quien
 * llama marca el nonce usado).
 */
export function verifyOAuthStateData(
  signer: OAuthStateSigner,
  state: string,
  expected: { platform: OAuthStatePlatform; broker?: string },
): { broker: string; nonce: string; expiresAt: Date } | null {
  let data: Readonly<Record<string, string | number | boolean>>;
  try {
    data = signer.verify(state);
  } catch {
    return null;
  }
  if (data.platform !== expected.platform || typeof data.broker !== "string") return null;
  if (expected.broker !== undefined && data.broker !== expected.broker) return null;
  if (typeof data.nonce !== "string" || typeof data.exp !== "number") return null;
  return { broker: data.broker, nonce: data.nonce, expiresAt: new Date(data.exp * 1000) };
}

/**
 * Dónde empieza el OAuth (`connect.instagram.startUrl`, F3-T17): en el host de la URI de retorno,
 * porque la cookie del `state` distingue el host, y en su misma ruta con `start` en vez de
 * `callback` (spec F8 §4.3: la API va bajo `/api`, cierra la deuda "tras un prefijo" de F3).
 */
export function instagramStartUrlOf(redirectUri: string): string {
  const url = new URL(redirectUri);
  const path = /\/callback\/?$/.test(url.pathname)
    ? url.pathname.replace(/\/callback\/?$/, "/start")
    : `${url.pathname.replace(/\/$/, "")}/start`;
  return new URL(path, url.origin).toString();
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
  /**
   * Mercado Libre (spec F8 §4.3, T19): la vuelta automática del OAuth. `secureCookie` es si la cookie
   * del `state` va `Secure` (con HTTPS, como la sesión).
   */
  mercadoLibre: { auth: MercadoLibreAuth; configured: boolean; secureCookie: boolean };
  oauthState: OAuthStateSigner;
  /** Los `state` ya usados (spec F8 §4.11): el de Instagram sirve una vez, como el de Mercado Libre. */
  oauthStates: Pick<OAuthStateRepository, "markUsed">;
  /** El hash del nonce que se guarda (SHA-256, el de los tokens de sesión). */
  stateHash: (nonce: string) => string;
  /** La URL absoluta del panel (`http://localhost:<WEB_PORT>`): ahí vuelve el operador. */
  panelUrl: string;
  logger: AppLogger;
};

/**
 * Lo que se anota de un canje que falló: el código del error y, si es de la app, sus `details` (lo
 * que dijo la plataforma: el status HTTP, el tipo y el subcódigo; ya van sin tokens ni datos de la
 * petición, y el logger oculta cualquier clave sensible), para poder distinguir en producción una
 * clave secreta equivocada de una dirección de retorno que no coincide o de un código usado. Nunca
 * el código de autorización ni los tokens: no están en el error.
 */
function failureFields(caught: unknown) {
  if (isAppError(caught)) {
    return caught.details === undefined
      ? { code: caught.code }
      : { code: caught.code, details: caught.details };
  }
  return {
    code: "INTERNAL_ERROR",
    errorName: caught instanceof Error ? caught.name : typeof caught,
  };
}

/**
 * `/oauth/instagram` (spec F3 §4.6): Instagram Login completo, implementado para F7 (con HTTPS) y
 * probado con dobles: en F3, Meta no acepta `http://localhost` y la cuenta se conecta con el token
 * del panel (D4). Las dos rutas responden con redirecciones, y la vuelta siempre termina en el panel
 * (`/cuentas?conectada=instagram` o `?error=<código>`), sin datos de la cuenta en la URL.
 *
 * `/oauth/mercadolibre/callback` (spec F8 §4.3, T19, D20): la vuelta automática de Mercado Libre, sin
 * pegar la dirección. La protegen el `state` firmado (de un solo uso) y su cookie, que puso
 * `authorize-url`; termina en el panel igual (`?conectada=mercadolibre&proveedor=mercadolibre` o
 * `?error=<código>&proveedor=mercadolibre`).
 */
export function oauthRoutes(deps: OAuthDeps) {
  const toPanel = (params: Record<string, string>) => {
    const url = new URL("/cuentas", deps.panelUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  };
  // `Path=/` (no la ruta de la vuelta): `__Host-` lo exige, y con el prefijo `/api` la ruta cambia.
  const cookieName = instagramStateCookieName(deps.instagram.secureCookie);
  const cookieOptions = oauthStateCookieOptions(deps.instagram.secureCookie);
  const mlCookieName = mercadoLibreStateCookieName(deps.mercadoLibre.secureCookie);
  const mlCookieOptions = oauthStateCookieOptions(deps.mercadoLibre.secureCookie);
  const toPanelFromMercadoLibre = (params: Record<string, string>) =>
    toPanel({ ...params, proveedor: OAUTH_STATE_PLATFORMS.mercadolibre });

  /**
   * El `state` de una vuelta: igual al de su cookie, firmado, vigente, de la plataforma esperada y
   * todavía sin usar (se anota usado aquí, antes de canjear). `null` si algo no calza: nunca se llama
   * a la plataforma.
   */
  const takeState = async (
    state: string | undefined,
    cookie: string | undefined,
    platform: OAuthStatePlatform,
  ) => {
    if (state === undefined || cookie === undefined || !sameText(state, cookie)) return null;
    const verified = verifyOAuthStateData(deps.oauthState, state, { platform });
    if (verified === null) return null;
    return (await deps.oauthStates.markUsed(deps.stateHash(verified.nonce), verified.expiresAt))
      ? verified
      : null;
  };

  return new Hono<AppEnv>()
    .get("/instagram/start", validated("query", oauthStartQuerySchema), async (c) => {
      const { broker } = c.req.valid("query");
      if (!deps.instagram.oauthConfigured) {
        return c.redirect(toPanel({ error: "INSTAGRAM_NOT_CONFIGURED" }), 302);
      }
      const target = await deps.brokers.findBySlug(broker);
      // Un corredor solo conecta el suyo; el de otro responde como uno que no existe (ADR-0022).
      if (target === null || !can(requireAuth(c).user, "instagram.connect", target.id)) {
        return c.redirect(toPanel({ error: "BROKER_NOT_FOUND" }), 302);
      }
      // Con la plataforma: un `state` de Mercado Libre no sirve en esta vuelta (spec F4 §4.2).
      const state = deps.oauthState.sign(
        { platform: OAUTH_STATE_PLATFORMS.instagram, broker },
        { ttlSeconds: OAUTH_STATE_TTL_SECONDS },
      );
      setCookie(c, cookieName, state, {
        ...cookieOptions,
        maxAge: OAUTH_STATE_TTL_SECONDS,
      });
      return c.redirect(deps.instagram.auth.authorizeUrl(state), 302);
    })
    .get("/instagram/callback", async (c) => {
      const cookie = getCookie(c, cookieName);
      // Un `state` sirve una sola vez: la cookie se borra pase lo que pase.
      deleteCookie(c, cookieName, cookieOptions);
      const { code, state, error } = c.req.query();
      // El operador rechazó en Instagram: no es un error de la app, solo un aviso para el panel.
      if (error !== undefined) return c.redirect(toPanel({ error: "OAUTH_DENIED" }), 302);

      // Sin llamar a Instagram: un `state` ajeno, vencido, de otra plataforma o sin cookie no canjea,
      // y uno ya usado tampoco (deuda de F3: una vuelta repetida, aun con su cookie).
      const verified = await takeState(state, cookie, OAUTH_STATE_PLATFORMS.instagram);
      if (verified === null) return c.redirect(toPanel({ error: "OAUTH_STATE_INVALID" }), 302);
      const { broker } = verified;
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
        const fields = failureFields(caught);
        deps.logger.warn(fields, "no se pudo conectar la cuenta de Instagram");
        return c.redirect(toPanel({ error: fields.code }), 302);
      }
    })
    .get("/mercadolibre/callback", async (c) => {
      const cookie = getCookie(c, mlCookieName);
      // Un `state` sirve una sola vez: la cookie se borra pase lo que pase.
      deleteCookie(c, mlCookieName, mlCookieOptions);
      const { code, state, error } = c.req.query();
      // El administrador rechazó en Mercado Libre: solo un aviso para el panel.
      if (error !== undefined)
        return c.redirect(toPanelFromMercadoLibre({ error: "OAUTH_DENIED" }), 302);

      // Sin llamar a Mercado Libre: un `state` ajeno (también el de Instagram), vencido, ya usado o
      // sin su cookie no canjea nada.
      const verified = await takeState(state, cookie, OAUTH_STATE_PLATFORMS.mercadolibre);
      if (verified === null) {
        return c.redirect(toPanelFromMercadoLibre({ error: "OAUTH_STATE_INVALID" }), 302);
      }
      if (code === undefined || code === "") {
        return c.redirect(toPanelFromMercadoLibre({ error: "OAUTH_CODE_MISSING" }), 302);
      }
      // Sin el par de la app, el canje mandaría un secret vacío: ni se intenta.
      if (!deps.mercadoLibre.configured) {
        return c.redirect(toPanelFromMercadoLibre({ error: "MERCADOLIBRE_NOT_CONFIGURED" }), 302);
      }

      try {
        await connectMercadoLibreAccount(
          {
            brokers: deps.brokers,
            platformAccounts: deps.platformAccounts,
            mercadoLibre: deps.mercadoLibre.auth,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          { broker: verified.broker, code, signal: c.req.raw.signal },
        );
        return c.redirect(toPanelFromMercadoLibre({ conectada: "mercadolibre" }), 302);
      } catch (caught) {
        const fields = failureFields(caught);
        deps.logger.warn(fields, "no se pudo conectar la cuenta de Mercado Libre");
        return c.redirect(toPanelFromMercadoLibre({ error: fields.code }), 302);
      }
    });
}
