import {
  AppError,
  type ConnectAccountDeps,
  connectAccount,
  disconnectAccount,
  instagramAccountMetaSchema,
  isAppError,
  type PlatformAccount,
  type PlatformAccountRepository,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  type AccountListResponse,
  type AccountResponse,
  connectTokenBodySchema,
  idParamSchema,
  type PlatformAccountView,
} from "../contracts/index.js";
import { validated, validatedWithReason } from "../validation.js";

export type AccountRoutesDeps = ConnectAccountDeps & {
  platformAccounts: PlatformAccountRepository;
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

/**
 * `/accounts` (spec F3 §4.6 y §4.8): las cuentas conectadas, conectar con el token del panel de
 * Meta (D4: Meta no acepta `http://localhost` para el OAuth) y desconectar. Conectar llama a
 * Instagram de forma síncrona (`/me`; seguimiento de ADR-0014, punto 9). El token del cuerpo nunca
 * vuelve en la respuesta ni va al log (el log de la API no registra cuerpos).
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
    .post("/:id/disconnect", validated("param", idParamSchema), async (c) => {
      const account = await disconnectAccount(deps, { accountId: c.req.valid("param").id });
      const body: AccountResponse = { account: accountView(account) };
      return c.json(body, 200);
    });
}
