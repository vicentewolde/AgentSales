import {
  AppError,
  type ConnectAccountDeps,
  connectAccount,
  connectMercadoLibreAccount,
  disconnectAccount,
  instagramAccountMetaSchema,
  isAppError,
  type MercadoLibreAuth,
  mercadoLibreAccountMetaSchema,
  type PlatformAccount,
  type PlatformAccountRepository,
  type RefreshAccountTokensDeps,
  refreshAccountToken,
  requireBroker,
  type TokenRefreshResult,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  type AccountListResponse,
  type AccountRefreshResponse,
  type AccountResponse,
  accountRefreshBodySchema,
  connectTokenBodySchema,
  idParamSchema,
  type MercadoLibreAuthorizeUrlResponse,
  mercadoLibreAuthorizeUrlBodySchema,
  mercadoLibreConnectBodySchema,
  type PlatformAccountView,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated, validatedWithReason } from "../validation.js";
import {
  OAUTH_STATE_PLATFORMS,
  OAUTH_STATE_TTL_SECONDS,
  type OAuthStateSigner,
  verifyOAuthState,
} from "./oauth.js";

export type AccountRoutesDeps = ConnectAccountDeps &
  Omit<RefreshAccountTokensDeps, "onWarning"> & {
    platformAccounts: PlatformAccountRepository;
    /** Para los avisos del refresco a pedido (solo ids y códigos). */
    logger: AppLogger;
    /** Si el panel puede ofrecer el OAuth (par de la app y URI `https://`). */
    instagramOAuth: boolean;
    /** El inicio del OAuth, en el host de la URI de retorno (`AppDeps.instagramStartUrl`). */
    instagramStartUrl: string;
    /** Mercado Libre (`AppDeps.mercadoLibre`): OAuth con la dirección pegada (spec F4 §4.2). */
    mercadoLibre: { auth: MercadoLibreAuth; configured: boolean; redirectUri: string };
    /** Firma y verifica el `state` (con la plataforma y el corredor). */
    oauthState: OAuthStateSigner;
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

/** Lo que el panel muestra de `meta`, igual para las dos plataformas. */
type ShownMeta = {
  tokenExpiryEstimated: boolean;
  connectedAt: string;
  tokenRefreshedAt: string | null;
  accountType: string | null;
  permissions: string[] | null;
};

/**
 * La `meta` de la cuenta según su plataforma: Instagram (`accountType` y `permissions`) o Mercado
 * Libre (`userType` y `scopes`, desde F4-T06). `null` si no calza (una fila vieja o rota).
 */
function shownMeta(account: PlatformAccount): ShownMeta | null {
  if (account.platform === "portal_inmobiliario") {
    const meta = mercadoLibreAccountMetaSchema.safeParse(account.meta);
    if (!meta.success) return null;
    return {
      tokenExpiryEstimated: meta.data.tokenExpiryEstimated,
      connectedAt: meta.data.connectedAt,
      tokenRefreshedAt: meta.data.tokenRefreshedAt,
      accountType: meta.data.userType,
      permissions: meta.data.scopes,
    };
  }
  const meta = instagramAccountMetaSchema.safeParse(account.meta);
  return meta.success ? meta.data : null;
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
 * `/accounts` (spec F3 §4.6 y §4.8, spec F4 §4.2): las cuentas conectadas, conectar con el token del
 * panel de Meta (D4: Meta no acepta `http://localhost` para el OAuth), conectar Mercado Libre con la
 * dirección de vuelta pegada (la URL de autorización y el canje del código), refrescar el token a
 * pedido y desconectar. Conectar (`/me`) y refrescar llaman a Instagram de forma síncrona (seguimiento de
 * ADR-0014, punto 9). El token nunca vuelve en la respuesta ni va al log (el log de la API no
 * registra cuerpos, y la URL del refresco no sale del cliente de Instagram).
 */
export function accountRoutes(deps: AccountRoutesDeps) {
  return new Hono()
    .get("/", async (c) => {
      const accounts = await deps.platformAccounts.list();
      const body: AccountListResponse = {
        accounts: accounts.map(accountView),
        connect: {
          instagram: { oauth: deps.instagramOAuth, startUrl: deps.instagramStartUrl },
          mercadolibre: {
            configured: deps.mercadoLibre.configured,
            redirectUri: deps.mercadoLibre.redirectUri,
          },
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
        // Antes de llamar a Mercado Libre: un `state` ajeno o vencido no canjea nada.
        const expected = { platform: OAUTH_STATE_PLATFORMS.mercadolibre, broker };
        if (verifyOAuthState(deps.oauthState, state, expected) === null) throw stateInvalid();
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
    .post(
      "/:id/refresh",
      validated("param", idParamSchema),
      validated("json", accountRefreshBodySchema),
      async (c) => {
        const { force } = c.req.valid("json");
        const result = await refreshAccountToken(
          {
            ...deps,
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
    .post("/:id/disconnect", validated("param", idParamSchema), async (c) => {
      const account = await disconnectAccount(deps, { accountId: c.req.valid("param").id });
      const body: AccountResponse = { account: accountView(account) };
      return c.json(body, 200);
    });
}
