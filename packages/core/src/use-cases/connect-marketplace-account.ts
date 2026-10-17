import { AppError } from "../errors.js";
import { assertMarketplaceAutomationAllowed } from "../marketplace/automation.js";
import { manualConfirmPending, marketplaceProfileActionPending } from "../marketplace/limits.js";
import {
  isManualMarketplaceAccount,
  MANUAL_MARKETPLACE_ACCOUNT_ID,
  type MarketplaceManualMeta,
  type MarketplaceProfileMeta,
  marketplaceProfileMetaSchema,
  type PlatformAccount,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { requireBroker } from "./connect-account.js";

export type ConnectMarketplaceAccountDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected" | "listByBroker">;
  /** Para no revocar otra cuenta del corredor con un formulario esperando el clic final. */
  publications: Pick<PublicationRepository, "listByStatus">;
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
 * actualiza su fila (y borra un `lastLoginError` anterior). Errores: `BROKER_NOT_FOUND`,
 * `MARKETPLACE_SESSION_ID_INVALID` (el id no es numérico) y `MANUAL_CONFIRM_PENDING` si la sesión es
 * de **otra** cuenta de Facebook y la conectada tiene una publicación esperando el clic final
 * (revocarla dejaría esa publicación en una cuenta desconectada: spec F5 §4.3, D11). Desde F7
 * (ADR-0023), solo para un corredor propio: si no, `MARKETPLACE_AUTOMATION_NOT_ALLOWED`.
 */
export async function connectMarketplaceAccount(
  deps: ConnectMarketplaceAccountDeps,
  { brokerId, userId, label }: { brokerId: string; userId: string; label?: string },
): Promise<PlatformAccount> {
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw brokerNotFound(brokerId);
  assertMarketplaceAutomationAllowed(broker);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const parsed = marketplaceProfileMetaSchema.safeParse({
    mode: "profile",
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
  const meta: MarketplaceProfileMeta = parsed.data;
  await requireNoWaitingOnOthers(deps, brokerId, meta.userId);
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
 * Antes de revocar las otras cuentas de Marketplace del corredor (al conectar otra): ninguna puede
 * tener una publicación esperando el clic final (`MANUAL_CONFIRM_PENDING`, spec F5 §4.3). El id
 * es de una publicación del mismo corredor (sus cuentas).
 */
async function requireNoWaitingOnOthers(
  deps: Pick<ConnectMarketplaceAccountDeps, "platformAccounts" | "publications">,
  brokerId: string,
  keepExternalId: string,
): Promise<void> {
  const others = (await deps.platformAccounts.listByBroker(brokerId, "fb_marketplace")).filter(
    (account) => account.status === "connected" && account.externalAccountId !== keepExternalId,
  );
  if (others.length === 0) return;
  const ids = new Set(others.map((account) => account.id));
  const waiting = (await deps.publications.listByStatus("awaiting_manual_confirm")).find(
    (publication) => ids.has(publication.platformAccountId),
  );
  if (waiting !== undefined) throw manualConfirmPending(waiting.id);
  // Un formulario llenándose terminaría esperando el clic en una cuenta revocada (como al
  // desconectar, spec F5 §4.2).
  const filling = (await deps.publications.listByStatus("publishing")).find((publication) =>
    ids.has(publication.platformAccountId),
  );
  if (filling !== undefined) {
    throw new AppError(
      "PUBLICATION_IN_PROGRESS",
      "Se está llenando un formulario de Marketplace de este corredor: espera a que termine",
      { details: { publicationId: filling.id } },
    );
  }
}

/**
 * Activa Marketplace **a mano** para un corredor (spec F7 §4.8, ADR-0023;
 * `POST /accounts/marketplace/manual`, administrador): una cuenta sin credenciales ni perfil del
 * navegador (`external_account_id = "manual"`, `meta.mode = "manual"`). El corredor publica él
 * mismo y confirma con el enlace. Sirve para cualquier corredor (también uno propio). Otra cuenta
 * de Marketplace del corredor queda desconectada (`MANUAL_CONFIRM_PENDING` si espera un clic) y,
 * si era un perfil, se encola el borrado de su sesión (`MARKETPLACE_PROFILE_ACTION_PENDING` si ya
 * hay otra acción del perfil en cola);
 * activarla otra vez actualiza la misma fila. El corredor va por su `slug`; `BROKER_NOT_FOUND` si
 * no existe.
 */
export async function connectManualMarketplaceAccount(
  deps: Omit<ConnectMarketplaceAccountDeps, "brokers"> & {
    brokers: Pick<BrokerRepository, "findBySlug">;
    /** Para borrar el perfil del navegador que se reemplaza (`marketplace.profile`, `forget`). */
    queue: JobQueue;
  },
  { broker: slug }: { broker: string },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const brokerId = broker.id;
  await requireNoWaitingOnOthers(deps, brokerId, MANUAL_MARKETPLACE_ACCOUNT_ID);
  // Reemplazar un perfil conectado borra también su sesión de Facebook del disco, como
  // desconectarlo (antes de cambiar nada: con otra acción del perfil en cola, se repite después).
  const replacesProfile = (
    await deps.platformAccounts.listByBroker(brokerId, "fb_marketplace")
  ).some((account) => account.status === "connected" && !isManualMarketplaceAccount(account));
  if (replacesProfile) {
    const queued = await deps.queue.enqueue(
      "marketplace.profile",
      { brokerId, action: "forget" },
      { singletonKey: brokerId },
    );
    if (queued === null) throw marketplaceProfileActionPending(brokerId);
  }
  const meta: MarketplaceManualMeta = {
    mode: "manual",
    connectedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  return deps.platformAccounts.upsertConnected(
    {
      brokerId,
      platform: "fb_marketplace",
      externalAccountId: MANUAL_MARKETPLACE_ACCOUNT_ID,
      displayName: `Marketplace a mano (${broker.name})`,
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
 * §4.2). Usa la conectada o, si no hay, la que cambió más recién. Sin cuenta, no hace nada (`null`).
 */
export async function recordMarketplaceLoginError(
  deps: {
    platformAccounts: Pick<PlatformAccountRepository, "listByBroker" | "mergeMeta">;
    now?: () => Date;
  },
  { brokerId, code }: { brokerId: string; code: string },
): Promise<PlatformAccount | null> {
  const accounts = await deps.platformAccounts.listByBroker(brokerId, "fb_marketplace");
  const latest =
    accounts.find((account) => account.status === "connected") ??
    [...accounts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (latest === undefined) return null;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  return deps.platformAccounts.mergeMeta(latest.id, { lastLoginError: { code, at } });
}
