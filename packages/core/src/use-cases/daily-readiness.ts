import { inScope } from "../access.js";
import { chileMonthOf, chileMonthRange } from "../chile-time.js";
import { editorialProfileView } from "../editorial-profile.js";
import { isPostPlatform, POST_PLATFORMS, type PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import { assertCan, scopeOf } from "../permissions.js";
import { isManualAccount, MANUAL_MODE_PLATFORMS } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { postPlatforms } from "../social/brief.js";
import {
  type DailyReadiness,
  dailyReadiness,
  type ReadinessAccount,
} from "../social/daily-readiness.js";
import type { User } from "../user.js";
import { xSpendLimitOf } from "../x/account.js";

type Actor = Pick<User, "id" | "role" | "brokerId">;

export type DailyReadinessDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  /** El gasto de X del mes de cada cuenta. */
  publications: Pick<PublicationRepository, "sumCostUsdSince">;
  /** El gasto de IA del mes de la marca. */
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  /** La cadencia: las redes de la marca son las de sus cuentas y las de su cadencia. */
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  now?: () => Date;
};

/**
 * «Lista para publicar a diario» de una marca (`GET /brokers/:id/daily-readiness`, F9.5-T27): lee
 * sus cuentas, su gasto de X y de IA del mes de Chile y su cadencia, y arma la lista
 * (`dailyReadiness`). Las redes son las de la marca (`postPlatforms`); si todavía no tiene ninguna,
 * todas las de los posts, para que diga qué conectar. `effectiveMode` y `server` los pone quien
 * llama (la única fuente del modo, ADR-0036); `workerSchedule` es el de `/health` (`null` si no se
 * sabe). Lo ajeno no existe (`BROKER_NOT_FOUND`); sin `broker.view`, `FORBIDDEN`. Solo lee.
 */
export async function getDailyReadiness(
  deps: DailyReadinessDeps,
  actor: Actor,
  {
    brokerId,
    effectiveMode,
    server,
    workerSchedule,
  }: {
    brokerId: string;
    effectiveMode: PublishMode;
    server: PublishMode;
    workerSchedule: boolean | null;
  },
): Promise<DailyReadiness> {
  const notFound = new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
    details: { id: brokerId },
  });
  if (!inScope(scopeOf(actor), brokerId)) throw notFound;
  assertCan(actor, "broker.view", brokerId);
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw notFound;
  const now = (deps.now ?? (() => new Date()))();
  const month = chileMonthRange(chileMonthOf(now));
  const [all, profile, spend] = await Promise.all([
    deps.platformAccounts.listByBroker(brokerId),
    deps.editorialProfiles.get(brokerId),
    deps.contentRuns.sumLlmCost({ from: month.from, to: month.to, brokerId }),
  ]);
  const own = all.filter((account) => isPostPlatform(account.platform));
  const brandNetworks = postPlatforms(editorialProfileView(brokerId, profile), own);
  const accounts: ReadinessAccount[] = [];
  // La más nueva primero: si hay varias de una red, la lista mira la conectada más reciente.
  for (const account of [...own].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (!isPostPlatform(account.platform)) continue;
    const x = account.platform === "x";
    accounts.push({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      status: account.status,
      publishingMode: (MANUAL_MODE_PLATFORMS as readonly string[]).includes(account.platform)
        ? isManualAccount(account)
          ? "manual"
          : "api"
        : null,
      spendLimitUsd: x ? xSpendLimitOf(account) : null,
      spentUsd: x ? await deps.publications.sumCostUsdSince(account.id, month.from) : null,
    });
  }
  return dailyReadiness({
    broker,
    effectiveMode,
    server,
    networks: brandNetworks.length > 0 ? brandNetworks : POST_PLATFORMS,
    accounts,
    workerSchedule,
    llmSpentUsd: spend.reduce((total, row) => total + row.costUsd, 0),
  });
}
