import { AppError } from "../errors.js";
import {
  type MarketplaceAccountMeta,
  marketplaceAccountMetaSchema,
  type PlatformAccount,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";

export type ConnectMarketplaceAccountDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected">;
  now?: () => Date;
};

const brokerNotFound = (brokerId: string) =>
  new AppError("BROKER_NOT_FOUND", "No existe el corredor", { details: { brokerId } });

/**
 * Conecta la cuenta de Marketplace de un corredor (spec F5 §4.2, ADR-0017): la llama el worker
 * (job `marketplace.profile`, `login`) cuando ve la sesión abierta en el perfil del navegador. La
 * cuenta **no guarda credenciales** (la sesión vive en el perfil): `external_account_id` = el id de
 * la cookie `c_user`, `display_name` = `label` o "Facebook de <corredor>", sin vencimiento, y `meta`
 * con `userId`, `connectedAt` y `sessionCheckedAt`. Otra cuenta de Marketplace del corredor queda
 * desconectada en el mismo paso (una conectada por corredor y plataforma); reconectar la misma
 * actualiza su fila (y borra un `lastLoginError` anterior). Errores: `BROKER_NOT_FOUND` y
 * `MARKETPLACE_SESSION_ID_INVALID` (el id no es numérico).
 */
export async function connectMarketplaceAccount(
  deps: ConnectMarketplaceAccountDeps,
  { brokerId, userId, label }: { brokerId: string; userId: string; label?: string },
): Promise<PlatformAccount> {
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw brokerNotFound(brokerId);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const parsed = marketplaceAccountMetaSchema.safeParse({
    userId,
    connectedAt: at,
    sessionCheckedAt: at,
  });
  if (!parsed.success) {
    throw new AppError(
      "MARKETPLACE_SESSION_ID_INVALID",
      "La sesión de Facebook no trae el id de la cuenta esperado",
    );
  }
  const meta: MarketplaceAccountMeta = parsed.data;
  return deps.platformAccounts.upsertConnected(
    {
      brokerId,
      platform: "fb_marketplace",
      externalAccountId: meta.userId,
      displayName: label?.trim() || `Facebook de ${broker.name}`,
      tokenExpiresAt: null,
      meta,
      credentials: null,
    },
    { revokeOthers: true },
  );
}

/**
 * Anota el último error de un inicio de sesión de Marketplace que falló (tope, perfil tomado,
 * Chromium) en la cuenta del corredor, si existe, para que la CLI y el panel lo muestren (spec F5
 * §4.2). Usa la más reciente de Marketplace del corredor. Sin cuenta, no hace nada (`null`).
 */
export async function recordMarketplaceLoginError(
  deps: {
    platformAccounts: Pick<PlatformAccountRepository, "listByBroker" | "mergeMeta">;
    now?: () => Date;
  },
  { brokerId, code }: { brokerId: string; code: string },
): Promise<PlatformAccount | null> {
  const accounts = await deps.platformAccounts.listByBroker(brokerId, "fb_marketplace");
  const latest = accounts.at(-1);
  if (latest === undefined) return null;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  return deps.platformAccounts.mergeMeta(latest.id, { lastLoginError: { code, at } });
}
