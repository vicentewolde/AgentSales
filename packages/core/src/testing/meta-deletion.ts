import { ALL_SCOPE } from "../access.js";
import type {
  MetaDeletionRepository,
  MetaDeletionRequest,
} from "../ports/meta-deletion-repository.js";
import { structuredCopy } from "./copy.js";
import type { InMemoryPlatformAccountRepository } from "./platform-accounts.js";
import type { InMemoryPublicationRepository } from "./publications.js";

export type InMemoryMetaDeletionRepository = MetaDeletionRepository & {
  /** Los hashes guardados de cada pedido, para afirmar que el `user_id` no se guarda. */
  storedUserIdHashes(): string[];
};

/**
 * Doble en memoria de `MetaDeletionRepository` (F8-T17), sobre los dobles de cuentas y
 * publicaciones: la misma semántica que el de Drizzle, sin transacción (en memoria nada falla a
 * mitad).
 */
export function createInMemoryMetaDeletionRepository(deps: {
  platformAccounts: InMemoryPlatformAccountRepository;
  publications: InMemoryPublicationRepository;
}): InMemoryMetaDeletionRepository {
  const requests = new Map<string, { request: MetaDeletionRequest; userIdHash: string }>();
  const instagramAccountsOf = async (instagramUserId: string) =>
    (await deps.platformAccounts.list(ALL_SCOPE)).filter(
      (account) =>
        account.platform === "instagram" && account.externalAccountId === instagramUserId,
    );

  return {
    async deauthorizeInstagramUser(instagramUserId) {
      let changed = 0;
      for (const account of await instagramAccountsOf(instagramUserId)) {
        if (!account.hasCredentials && account.status === "revoked") continue;
        await deps.platformAccounts.disconnect(account.id);
        changed += 1;
      }
      return changed;
    },
    async eraseInstagramUser(input) {
      const accounts = await instagramAccountsOf(input.instagramUserId);
      for (const account of accounts) {
        deps.publications.eraseExternalData(account.id, {
          actor: "system",
          payload: { confirmationCode: input.code },
        });
        deps.platformAccounts.eraseExternalData(account.id);
      }
      const request: MetaDeletionRequest = {
        code: input.code,
        status: "completed",
        receivedAt: input.receivedAt,
        completedAt: input.receivedAt,
        accountsAffected: accounts.length,
      };
      requests.set(input.code, { request, userIdHash: input.instagramUserIdHash });
      return structuredCopy(request);
    },
    async getByCode(code) {
      const found = requests.get(code);
      return found === undefined ? null : structuredCopy(found.request);
    },
    storedUserIdHashes() {
      return [...requests.values()].map(({ userIdHash }) => userIdHash);
    },
  };
}
