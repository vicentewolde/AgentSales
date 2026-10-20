import {
  type BrokerRepository,
  type ConnectLinkedInAccountDeps,
  can,
  connectLinkedInAccount,
  isAppError,
  type LinkedInAuth,
  type OAuthStateRepository,
} from "@agentsales/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type AppEnv, requireAuth } from "../auth.js";
import { oauthStartQuerySchema } from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated } from "../validation.js";
import {
  linkedinStateCookieName,
  OAUTH_STATE_PLATFORMS,
  OAUTH_STATE_TTL_SECONDS,
  type OAuthStateSigner,
  oauthStateCookieOptions,
  sameText,
  verifyOAuthStateData,
} from "./oauth.js";

export type LinkedInOAuthDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: ConnectLinkedInAccountDeps["platformAccounts"];
  linkedin: {
    auth: LinkedInAuth;
    /** Si están `LINKEDIN_CLIENT_ID` y `LINKEDIN_CLIENT_SECRET` (sin ellos no se canjea). */
    configured: boolean;
    /** `Secure` y `__Host-` en la cookie del `state`: cuando la dirección de retorno es `https://`. */
    secureCookie: boolean;
  };
  oauthState: OAuthStateSigner;
  /** Los `state` ya usados: el de LinkedIn sirve una vez, como los de Instagram y Mercado Libre. */
  oauthStates: Pick<OAuthStateRepository, "markUsed">;
  stateHash: (nonce: string) => string;
  /** La URL absoluta del panel: ahí vuelve el operador. */
  panelUrl: string;
  logger: AppLogger;
  now?: () => Date;
};

/** Lo que se anota de una conexión que falló: el código y los `details` del error, nunca el código del OAuth ni el token. */
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
 * `/oauth/linkedin` (spec F9 §4.6 y §4.7, F9-T15): el OAuth del perfil personal de LinkedIn.
 * - `GET /start?broker=<slug>` (con sesión): el administrador conecta cualquier marca o corredor, y
 *   un corredor solo el suyo (`linkedin.connect`, como `instagram.connect` de ADR-0028; lo ajeno
 *   responde como si no existiera). Firma el `state` con la plataforma y la marca, lo deja en una
 *   cookie `__Host-` (con HTTPS) `HttpOnly` y `Lax`, y manda a LinkedIn.
 * - `GET /callback` (pública: llega desde LinkedIn sin la cookie `Strict` de la sesión; fuera del
 *   CSRF como las de Meta): exige el `state` igual al de su cookie, firmado, vigente, de LinkedIn y
 *   **sin usar** (se anota usado antes de canjear), y conecta la cuenta en modo `manual` (D5).
 * Las dos responden con redirecciones y terminan en el panel (`/cuentas?conectada=linkedin&
 * proveedor=linkedin` o `?error=<código>&proveedor=linkedin`), sin datos de la cuenta en la URL.
 */
export function linkedinOAuthRoutes(deps: LinkedInOAuthDeps) {
  const cookieName = linkedinStateCookieName(deps.linkedin.secureCookie);
  const cookieOptions = oauthStateCookieOptions(deps.linkedin.secureCookie);
  const toPanel = (params: Record<string, string>) => {
    const url = new URL("/cuentas", deps.panelUrl);
    for (const [name, value] of Object.entries({
      ...params,
      proveedor: OAUTH_STATE_PLATFORMS.linkedin,
    })) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  };

  return new Hono<AppEnv>()
    .get("/start", validated("query", oauthStartQuerySchema), async (c) => {
      const { broker } = c.req.valid("query");
      if (!deps.linkedin.configured) {
        return c.redirect(toPanel({ error: "LINKEDIN_NOT_CONFIGURED" }), 302);
      }
      const target = await deps.brokers.findBySlug(broker);
      // Un corredor solo conecta el suyo; el de otro responde como uno que no existe (ADR-0022).
      if (target === null || !can(requireAuth(c).user, "linkedin.connect", target.id)) {
        return c.redirect(toPanel({ error: "BROKER_NOT_FOUND" }), 302);
      }
      // Con la plataforma: un `state` de Instagram o de Mercado Libre no sirve en esta vuelta.
      const state = deps.oauthState.sign(
        { platform: OAUTH_STATE_PLATFORMS.linkedin, broker },
        { ttlSeconds: OAUTH_STATE_TTL_SECONDS },
      );
      setCookie(c, cookieName, state, { ...cookieOptions, maxAge: OAUTH_STATE_TTL_SECONDS });
      return c.redirect(deps.linkedin.auth.authorizeUrl(state), 302);
    })
    .get("/callback", async (c) => {
      const cookie = getCookie(c, cookieName);
      // Un `state` sirve una sola vez: la cookie se borra pase lo que pase.
      deleteCookie(c, cookieName, cookieOptions);
      const { code, state, error } = c.req.query();
      // El operador canceló en LinkedIn (`user_cancelled_login`, `user_cancelled_authorize`).
      if (error !== undefined) return c.redirect(toPanel({ error: "OAUTH_DENIED" }), 302);

      // Sin llamar a LinkedIn: un `state` ajeno, vencido, de otra plataforma, sin cookie o ya usado
      // no canjea nada.
      if (state === undefined || cookie === undefined || !sameText(state, cookie)) {
        return c.redirect(toPanel({ error: "OAUTH_STATE_INVALID" }), 302);
      }
      const verified = verifyOAuthStateData(deps.oauthState, state, {
        platform: OAUTH_STATE_PLATFORMS.linkedin,
      });
      if (
        verified === null ||
        !(await deps.oauthStates.markUsed(deps.stateHash(verified.nonce), verified.expiresAt))
      ) {
        return c.redirect(toPanel({ error: "OAUTH_STATE_INVALID" }), 302);
      }
      if (code === undefined || code === "") {
        return c.redirect(toPanel({ error: "OAUTH_CODE_MISSING" }), 302);
      }
      // Sin el par de la app, el canje mandaría un secret vacío: ni se intenta.
      if (!deps.linkedin.configured) {
        return c.redirect(toPanel({ error: "LINKEDIN_NOT_CONFIGURED" }), 302);
      }
      try {
        await connectLinkedInAccount(
          {
            brokers: deps.brokers,
            platformAccounts: deps.platformAccounts,
            linkedin: deps.linkedin.auth,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          { broker: verified.broker, code, signal: c.req.raw.signal },
        );
        return c.redirect(toPanel({ conectada: OAUTH_STATE_PLATFORMS.linkedin }), 302);
      } catch (caught) {
        const fields = failureFields(caught);
        deps.logger.warn(fields, "no se pudo conectar la cuenta de LinkedIn");
        return c.redirect(toPanel({ error: fields.code }), 302);
      }
    });
}
