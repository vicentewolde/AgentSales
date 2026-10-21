import {
  AppError,
  type ConnectAccountDeps,
  connectAccount,
  connectDiscordAccount,
  connectManualMarketplaceAccount,
  connectMercadoLibreAccount,
  type DiscordWebhooks,
  disconnectAccount,
  discordAccountMetaSchema,
  instagramAccountMetaSchema,
  isAppError,
  isManualAccount,
  type JobQueue,
  linkedinAccountMetaSchema,
  MANUAL_MODE_PLATFORMS,
  type MercadoLibreAuth,
  marketplaceAccountMetaSchema,
  marketplaceLoginErrorText,
  mercadoLibreAccountMetaSchema,
  type OAuthStateRepository,
  type PlatformAccount,
  type PlatformAccountRepository,
  type PublicationRepository,
  type RefreshAccountTokensDeps,
  refreshAccountToken,
  requestMarketplaceLogin,
  requireBroker,
  setAccountMode,
  setXSpendLimit,
  type TokenRefreshResult,
  xAccountMetaSchema,
  xSpendLimitOf,
} from "@agentsales/core";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { AppEnv } from "../auth.js";
import {
  type AccountListResponse,
  type AccountModeResponse,
  type AccountRefreshResponse,
  type AccountResponse,
  accountDisconnectBodySchema,
  accountListQuerySchema,
  accountModeBodySchema,
  accountRefreshBodySchema,
  connectTokenBodySchema,
  discordConnectBodySchema,
  idParamSchema,
  type MarketplaceLoginResponse,
  type MercadoLibreAuthorizeUrlResponse,
  marketplaceLoginBodySchema,
  marketplaceManualBodySchema,
  mercadoLibreAuthorizeUrlBodySchema,
  mercadoLibreConnectBodySchema,
  type PlatformAccountView,
  xSpendLimitBodySchema,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { listScope } from "../scope.js";
import { validated, validatedWithReason } from "../validation.js";
import {
  mercadoLibreStateCookieName,
  OAUTH_STATE_PLATFORMS,
  OAUTH_STATE_TTL_SECONDS,
  type OAuthStateSigner,
  oauthStateCookieOptions,
  type TikTokOAuthDeps,
  verifyOAuthStateData,
} from "./oauth.js";

export type AccountRoutesDeps = ConnectAccountDeps &
  Omit<RefreshAccountTokensDeps, "onWarning" | "mercadoLibre"> & {
    platformAccounts: PlatformAccountRepository;
    /** Para los avisos del refresco a pedido (solo ids y códigos). */
    logger: AppLogger;
    /** Si el panel puede ofrecer el OAuth (par de la app y URI `https://`). */
    instagramOAuth: boolean;
    /** El inicio del OAuth, en el host de la URI de retorno (`AppDeps.instagramStartUrl`). */
    instagramStartUrl: string;
    /**
     * Mercado Libre (`AppDeps.mercadoLibre`): OAuth con la dirección pegada (spec F4 §4.2) o, con
     * `secureCookie` (internet), con la vuelta automática (spec F8 §4.3, T19).
     */
    mercadoLibre: {
      auth: MercadoLibreAuth;
      configured: boolean;
      redirectUri: string;
      secureCookie: boolean;
    };
    /** Firma y verifica el `state` (con la plataforma y el corredor). */
    oauthState: OAuthStateSigner;
    /** Los `state` usados (spec F7 §4.12) y el hash con que se guarda su nonce. */
    oauthStates: Pick<OAuthStateRepository, "markUsed">;
    stateHash: (nonce: string) => string;
    /** Desconectar Marketplace: una publicación esperando el clic final lo impide (spec F5 §4.2). */
    publications: Pick<PublicationRepository, "listByStatus">;
    /** Desconectar Marketplace encola el borrado del perfil (`marketplace.profile`). */
    queue: JobQueue;
    /** Si el ambiente permite el formulario automático (no en producción, spec F8 §4.10, D4). */
    marketplaceAutomation: boolean;
    /** Discord (F9-T14): leer el webhook al conectarlo, sin publicar. */
    discord: DiscordWebhooks;
    /**
     * X (F9-T16): si la API tiene el par de la app y el inicio del OAuth con PKCE (en el host de
     * `X_REDIRECT_URI`), para `GET /accounts`.
     */
    x: { configured: boolean; startUrl: string };
    /**
     * LinkedIn (F9-T15): si está el par de la app y dónde empieza su OAuth (en el host de
     * `LINKEDIN_REDIRECT_URI`), para la CLI.
     */
    linkedin: { configured: boolean; startUrl: string };
    /**
     * TikTok (F9-T26): si está configurado y dónde empieza el OAuth (para la lista), y su
     * renovación del token que rota (para el refresco a pedido).
     */
    tiktok: TikTokOAuthDeps;
  };

/** Sin el par de la app no se arma la URL ni se canjea: el canje mandaría un secret vacío. */
function mercadoLibreNotConfigured() {
  return new AppError(
    "MERCADOLIBRE_NOT_CONFIGURED",
    "Falta configurar la app de Mercado Libre: anota ML_APP_ID y ML_CLIENT_SECRET en .env y reinicia la API (docs/07-checklist-cuentas.md)",
  );
}

/**
 * Al conectar, los errores de Mercado Libre dicen qué hacer con la dirección pegada: un código que
 * no sirve se pide de nuevo, y un rechazo de la petición suele ser la dirección de retorno.
 */
function mercadoLibreConnectError(error: unknown): unknown {
  if (!isAppError(error)) return error;
  if (error.code === "ML_AUTH_INVALID") {
    return new AppError(
      error.code,
      "Mercado Libre no aceptó la conexión (el código venció o ya se usó): pide el enlace de nuevo, autoriza y pega la dirección en seguida",
      { details: error.details, cause: error },
    );
  }
  if (error.code === "ML_REQUEST_REJECTED") {
    return new AppError(
      error.code,
      `${error.message}: revisa que ML_REDIRECT_URI sea la misma dirección registrada en la app de Mercado Libre`,
      { details: error.details, cause: error },
    );
  }
  return error;
}

/** Un `state` vencido, alterado, de otra plataforma o de otro corredor: no se canjea nada. */
function stateInvalid() {
  return new AppError(
    "OAUTH_STATE_INVALID",
    "La autorización venció o no corresponde a este corredor: pide el enlace de nuevo y autoriza otra vez",
  );
}

/**
 * Con el token del panel, "reconecta la cuenta" no ayuda: lo que sirve es generar otro token. Los
 * demás errores pasan tal cual.
 */
function tokenError(error: unknown): unknown {
  if (!isAppError(error)) return error;
  if (error.code === "IG_AUTH_INVALID") {
    return new AppError(
      error.code,
      "Instagram no aceptó el token (venció o está incompleto): genera uno nuevo con Generate token en el panel de Meta",
      { details: error.details, cause: error },
    );
  }
  if (error.code === "IG_PERMISSION_DENIED") {
    return new AppError(
      error.code,
      "El token no tiene los permisos de Instagram: en el panel de Meta agrega instagram_business_basic e instagram_business_content_publish y genera uno nuevo",
      { details: error.details, cause: error },
    );
  }
  return error;
}

/** Lo que el panel muestra de `meta`, igual para todas las plataformas. */
type ShownMeta = {
  marketplaceMode: "profile" | "manual" | null;
  tokenExpiryEstimated: boolean;
  connectedAt: string;
  tokenRefreshedAt: string | null;
  accountType: string | null;
  permissions: string[] | null;
  sessionCheckedAt: string | null;
  lastLoginError: { code: string; at: string } | null;
};

const NO_SESSION = { sessionCheckedAt: null, lastLoginError: null, marketplaceMode: null } as const;

/**
 * La `meta` de la cuenta según su plataforma: Instagram (`accountType` y `permissions`), Mercado
 * Libre (`userType` y `scopes`, desde F4-T06) o Marketplace (la sesión revisada y el último error de
 * inicio de sesión, F5-T08: sin token ni vencimiento). `null` si no calza (una fila vieja o rota).
 */
function shownMeta(account: PlatformAccount): ShownMeta | null {
  if (account.platform === "fb_marketplace") {
    const meta = marketplaceAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    const profile = meta.data.mode === "profile" ? meta.data : null;
    return {
      tokenExpiryEstimated: false,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: null,
      accountType: null,
      permissions: null,
      // A mano (F7): sin sesión del navegador que revisar.
      sessionCheckedAt: profile?.sessionCheckedAt ?? null,
      lastLoginError: profile?.lastLoginError ?? null,
      marketplaceMode: meta.data.mode,
    };
  }
  if (account.platform === "discord") {
    // Un webhook no tiene token que venza ni permisos: solo cuándo se conectó (F9-T14).
    const meta = discordAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    return {
      tokenExpiryEstimated: false,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: null,
      accountType: null,
      permissions: null,
      ...NO_SESSION,
    };
  }
  if (account.platform === "x") {
    // X (F9-T16): el usuario, los permisos y el último refresco; el token vive 2 h y se renueva.
    const meta = xAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    return {
      tokenExpiryEstimated: false,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: meta.data.tokenRefreshedAt,
      accountType: null,
      permissions: meta.data.scopes,
      ...NO_SESSION,
    };
  }
  if (account.platform === "linkedin") {
    // LinkedIn (F9-T15): el token de 60 días no se renueva solo; los permisos del canje.
    const meta = linkedinAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    return {
      tokenExpiryEstimated: false,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: null,
      accountType: null,
      permissions: meta.data.scopes,
      ...NO_SESSION,
    };
  }
  if (account.platform === "portal_inmobiliario") {
    const meta = mercadoLibreAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    return {
      tokenExpiryEstimated: meta.data.tokenExpiryEstimated,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: meta.data.tokenRefreshedAt,
      accountType: meta.data.userType,
      permissions: meta.data.scopes,
      ...NO_SESSION,
    };
  }
  const meta = instagramAccountMetaSchema.safeParse(account.meta);
  return meta.success ? { ...meta.data, ...NO_SESSION } : null;
}

/**
 * La vista HTTP de una cuenta: nunca credenciales. De `meta` solo lo que muestra el panel; si no
 * calza con el esquema de su plataforma (una fila vieja), esos campos van en `null`.
 */
export function accountView(account: PlatformAccount): PlatformAccountView {
  const known = shownMeta(account);
  return {
    id: account.id,
    brokerId: account.brokerId,
    platform: account.platform,
    displayName: account.displayName,
    status: account.status,
    tokenExpiresAt: account.tokenExpiresAt,
    tokenExpiryEstimated: known?.tokenExpiryEstimated ?? false,
    connectedAt: known === null ? null : new Date(known.connectedAt),
    tokenRefreshedAt: known?.tokenRefreshedAt == null ? null : new Date(known.tokenRefreshedAt),
    accountType: known?.accountType ?? null,
    permissions: known?.permissions ?? null,
    sessionCheckedAt: known?.sessionCheckedAt == null ? null : new Date(known.sessionCheckedAt),
    lastLoginError:
      known?.lastLoginError == null
        ? null
        : {
            code: known.lastLoginError.code,
            message: marketplaceLoginErrorText(known.lastLoginError.code),
            at: new Date(known.lastLoginError.at),
          },
    marketplaceMode: known?.marketplaceMode ?? null,
    // X (F9-T16): el tope de gasto del mes.
    ...(account.platform === "x" ? { spendLimitUsd: xSpendLimitOf(account) } : {}),
    // F9-T15: el modo de una red de contenido de marca (ADR-0029 punto 9); sin `mode`, por API.
    publishingMode: (MANUAL_MODE_PLATFORMS as readonly string[]).includes(account.platform)
      ? isManualAccount(account)
        ? "manual"
        : "api"
      : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** La respuesta del refresco a pedido: el resultado con la vista de la cuenta, sin el token. */
function refreshView(result: TokenRefreshResult): AccountRefreshResponse {
  const account = accountView(result.account);
  if (result.outcome === "refreshed") return { outcome: "refreshed", account };
  if (result.outcome === "skipped") {
    const { reason, refreshableAt } = result;
    return { outcome: "skipped", reason, refreshableAt, account };
  }
  return { outcome: "expired", reason: result.reason, account };
}

/**
 * `/accounts` (spec F3 §4.6 y §4.8, spec F4 §4.2 y §4.3, spec F5 §4.2): las cuentas conectadas,
 * conectar con el token del panel de Meta (D4: Meta no acepta `http://localhost` para el OAuth),
 * conectar Mercado Libre con la dirección de vuelta pegada (la URL de autorización y el canje del
 * código), pedir el inicio de sesión de Marketplace (lo encola: la ventana la abre el worker),
 * refrescar el token a pedido (Instagram o Mercado Libre, cada una con su política) y desconectar
 * (Marketplace pide `confirmed`: borra el perfil del navegador). Conectar y
 * refrescar llaman a la plataforma de forma síncrona (seguimiento de ADR-0014, punto 9). Desde
 * F7-T15 (ADR-0023), el administrador activa Marketplace a mano (`/marketplace/manual`), y desde
 * F9-T14 conecta el webhook de un canal de Discord (`/discord/connect`). El token
 * nunca vuelve en la respuesta ni va al log (el log de la API no registra cuerpos, y la URL del
 * refresco de Instagram no sale de su cliente).
 */
export function accountRoutes(deps: AccountRoutesDeps) {
  return new Hono<AppEnv>()
    .get("/", validated("query", accountListQuerySchema), async (c) => {
      // Un corredor ve sus cuentas (spec F7 §4.5); conectarlas es del administrador. `?broker`
      // filtra (el selector del panel, F7-T17).
      const accounts = await deps.platformAccounts.list(
        await listScope(c, deps.brokers, c.req.valid("query").broker),
      );
      const body: AccountListResponse = {
        accounts: accounts.map(accountView),
        connect: {
          instagram: { oauth: deps.instagramOAuth, startUrl: deps.instagramStartUrl },
          mercadolibre: {
            configured: deps.mercadoLibre.configured,
            redirectUri: deps.mercadoLibre.redirectUri,
            // La vuelta automática solo con el dominio (HTTPS): en el Mac, la dirección no llega.
            automatic:
              deps.mercadoLibre.configured &&
              deps.mercadoLibre.secureCookie &&
              new URL(deps.mercadoLibre.redirectUri).pathname.endsWith(
                "/oauth/mercadolibre/callback",
              ),
          },
          marketplace: { automation: deps.marketplaceAutomation },
          x: { configured: deps.x.configured, startUrl: deps.x.startUrl },
          linkedin: { configured: deps.linkedin.configured, startUrl: deps.linkedin.startUrl },
          tiktok: { configured: deps.tiktok.configured, startUrl: deps.tiktok.startUrl },
        },
      };
      return c.json(body, 200);
    })
    .post("/connect-token", validatedWithReason("json", connectTokenBodySchema), async (c) => {
      const { broker, token } = c.req.valid("json");
      const account = await connectAccount(deps, {
        broker,
        grant: { kind: "token", accessToken: token },
        signal: c.req.raw.signal,
      }).catch((error: unknown) => {
        throw tokenError(error);
      });
      const body: AccountResponse = { account: accountView(account) };
      return c.json(body, 200);
    })
    .post("/discord/connect", validatedWithReason("json", discordConnectBodySchema), async (c) => {
      // Discord (F9-T14): la URL del webhook pegada por la entrada estándar de la CLI. Se lee en
      // Discord sin publicar y se guarda cifrada; nunca vuelve en la respuesta ni va al log.
      const { broker, webhookUrl } = c.req.valid("json");
      const account = await connectDiscordAccount(deps, {
        broker,
        webhookUrl,
        signal: c.req.raw.signal,
      });
      const body: AccountResponse = { account: accountView(account) };
      return c.json(body, 200);
    })
    .post(
      "/mercadolibre/authorize-url",
      validated("json", mercadoLibreAuthorizeUrlBodySchema),
      async (c) => {
        if (!deps.mercadoLibre.configured) throw mercadoLibreNotConfigured();
        const { broker } = c.req.valid("json");
        await requireBroker(deps.brokers, broker);
        const state = deps.oauthState.sign(
          { platform: OAUTH_STATE_PLATFORMS.mercadolibre, broker },
          { ttlSeconds: OAUTH_STATE_TTL_SECONDS },
        );
        // La cookie que exige la vuelta automática (T19): igual al `state` de la URL, `Lax` (la vuelta
        // llega desde Mercado Libre) y de la misma vida que el `state`. La CLI la ignora.
        setCookie(c, mercadoLibreStateCookieName(deps.mercadoLibre.secureCookie), state, {
          ...oauthStateCookieOptions(deps.mercadoLibre.secureCookie),
          maxAge: OAUTH_STATE_TTL_SECONDS,
        });
        const body: MercadoLibreAuthorizeUrlResponse = {
          url: deps.mercadoLibre.auth.authorizeUrl(state),
        };
        return c.json(body, 200);
      },
    )
    .post(
      "/mercadolibre/connect",
      validatedWithReason("json", mercadoLibreConnectBodySchema),
      async (c) => {
        if (!deps.mercadoLibre.configured) throw mercadoLibreNotConfigured();
        const { broker, code, state } = c.req.valid("json");
        // Antes de llamar a Mercado Libre: un `state` ajeno o vencido no canjea nada, y uno ya
        // usado tampoco (spec F7 §4.12: sirve una vez).
        const expected = { platform: OAUTH_STATE_PLATFORMS.mercadolibre, broker };
        const verified = verifyOAuthStateData(deps.oauthState, state, expected);
        if (verified === null) throw stateInvalid();
        if (
          !(await deps.oauthStates.markUsed(deps.stateHash(verified.nonce), verified.expiresAt))
        ) {
          throw new AppError(
            "OAUTH_STATE_USED",
            "Esa dirección de vuelta ya se usó: conecta Mercado Libre de nuevo",
          );
        }
        const account = await connectMercadoLibreAccount(
          {
            brokers: deps.brokers,
            platformAccounts: deps.platformAccounts,
            mercadoLibre: deps.mercadoLibre.auth,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          { broker, code, signal: c.req.raw.signal },
        ).catch((error: unknown) => {
          throw mercadoLibreConnectError(error);
        });
        const body: AccountResponse = { account: accountView(account) };
        return c.json(body, 200);
      },
    )
    .post("/marketplace/manual", validated("json", marketplaceManualBodySchema), async (c) => {
      const account = await connectManualMarketplaceAccount(
        {
          brokers: deps.brokers,
          platformAccounts: deps.platformAccounts,
          publications: deps.publications,
          queue: deps.queue,
          marketplaceAutomation: deps.marketplaceAutomation,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        },
        { broker: c.req.valid("json").broker },
      );
      const body: AccountResponse = { account: accountView(account) };
      return c.json(body, 201);
    })
    .post("/marketplace/login", validated("json", marketplaceLoginBodySchema), async (c) => {
      const { broker, label } = c.req.valid("json");
      const { brokerId, requestedAt } = await requestMarketplaceLogin(
        {
          brokers: deps.brokers,
          queue: deps.queue,
          marketplaceAutomation: deps.marketplaceAutomation,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        },
        { broker, ...(label === undefined ? {} : { label }) },
      );
      const body: MarketplaceLoginResponse = { queued: true, brokerId, requestedAt };
      return c.json(body, 202);
    })
    .post(
      "/:id/refresh",
      validated("param", idParamSchema),
      validated("json", accountRefreshBodySchema),
      async (c) => {
        const { force } = c.req.valid("json");
        const result = await refreshAccountToken(
          {
            ...deps,
            // Sin el par, una cuenta de Mercado Libre a la que le toca es MERCADOLIBRE_NOT_CONFIGURED
            // (503) sin llamar ni cambiarla.
            mercadoLibre: deps.mercadoLibre.configured ? deps.mercadoLibre.auth : null,
            onWarning: ({ accountId, code }) =>
              deps.logger.warn({ accountId, code }, "aviso del refresco de tokens"),
          },
          {
            accountId: c.req.valid("param").id,
            force: force ?? false,
            signal: c.req.raw.signal,
          },
        );
        return c.json(refreshView(result), 200);
      },
    )
    .post(
      "/:id/spend-limit",
      validated("param", idParamSchema),
      validated("json", xSpendLimitBodySchema),
      async (c) => {
        // X (F9-T16, spec F9 §4.12): el tope de gasto del mes; no llama a X.
        const account = await setXSpendLimit(deps, {
          accountId: c.req.valid("param").id,
          spendLimitUsd: c.req.valid("json").spendLimitUsd,
        });
        const body: AccountResponse = { account: accountView(account) };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/mode",
      validated("param", idParamSchema),
      validated("json", accountModeBodySchema),
      async (c) => {
        // F9-T15 (ADR-0029 punto 9): `manual` o `api` en una red de contenido de marca; solo el
        // administrador (`ROUTE_ACCESS`). LinkedIn pasa a `api` cuando S2 y S3 estén resueltas.
        const { account, changed } = await setAccountMode(deps, {
          accountId: c.req.valid("param").id,
          mode: c.req.valid("json").mode,
        });
        const body: AccountModeResponse = { account: accountView(account), changed };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/disconnect",
      validated("param", idParamSchema),
      validated("json", accountDisconnectBodySchema),
      async (c) => {
        const { confirmed } = c.req.valid("json");
        const account = await disconnectAccount(deps, {
          accountId: c.req.valid("param").id,
          ...(confirmed === undefined ? {} : { confirmed }),
        });
        const body: AccountResponse = { account: accountView(account) };
        return c.json(body, 200);
      },
    );
}
