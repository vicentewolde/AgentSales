import {
  AppError,
  type ConnectAccountDeps,
  connectAccount,
  disconnectAccount,
  instagramAccountMetaSchema,
  isAppError,
  type PlatformAccount,
  type PlatformAccountRepository,
  type RefreshAccountTokensDeps,
  refreshAccountToken,
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
  type PlatformAccountView,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated, validatedWithReason } from "../validation.js";

export type AccountRoutesDeps = ConnectAccountDeps &
  Omit<RefreshAccountTokensDeps, "onWarning"> & {
    platformAccounts: PlatformAccountRepository;
    /** Para los avisos del refresco a pedido (solo ids y códigos). */
    logger: AppLogger;
    /** Si el panel puede ofrecer el OAuth (par de la app y URI `https://`). */
    instagramOAuth: boolean;
  };

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

/**
 * La vista HTTP de una cuenta: nunca credenciales. De `meta` solo lo que muestra el panel; si no
 * calza con el esquema de Instagram (otra plataforma, una fila vieja), esos campos van en `null`.
 */
export function accountView(account: PlatformAccount): PlatformAccountView {
  const meta = instagramAccountMetaSchema.safeParse(account.meta);
  const known = meta.success ? meta.data : null;
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
 * `/accounts` (spec F3 §4.6 y §4.8): las cuentas conectadas, conectar con el token del panel de
 * Meta (D4: Meta no acepta `http://localhost` para el OAuth), refrescar el token a pedido y
 * desconectar. Conectar (`/me`) y refrescar llaman a Instagram de forma síncrona (seguimiento de
 * ADR-0014, punto 9). El token nunca vuelve en la respuesta ni va al log (el log de la API no
 * registra cuerpos, y la URL del refresco no sale del cliente de Instagram).
 */
export function accountRoutes(deps: AccountRoutesDeps) {
  return new Hono()
    .get("/", async (c) => {
      const accounts = await deps.platformAccounts.list();
      const body: AccountListResponse = {
        accounts: accounts.map(accountView),
        connect: { instagram: { oauth: deps.instagramOAuth } },
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
