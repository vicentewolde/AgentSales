import { AppError } from "../errors.js";
import type { PlatformAccount, PlatformCredentials } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { structuredCopy } from "./copy.js";

export type InMemoryPlatformAccountRepository = PlatformAccountRepository & {
  /** Las credenciales guardadas tal cual (en memoria no se cifran), para afirmar en los tests. */
  storedCredentials(id: string): PlatformCredentials | null;
};

export type InMemoryPlatformAccountRepositoryOptions = {
  /** Para rechazar un corredor que no existe como Postgres (`BROKER_NOT_FOUND`); sin él, no valida. */
  brokers?: Pick<BrokerRepository, "findById">;
};

type Stored = { account: PlatformAccount; credentials: PlatformCredentials | null };

const notFound = (id: string) =>
  new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${id}`, { details: { accountId: id } });

/** Doble en memoria de `PlatformAccountRepository`, con la misma semántica que el de Drizzle. */
export function createInMemoryPlatformAccountRepository(
  options: InMemoryPlatformAccountRepositoryOptions = {},
): InMemoryPlatformAccountRepository {
  let next = 0;
  const stored = new Map<string, Stored>();
  const find = (id: string) => {
    const found = stored.get(id);
    if (found === undefined) throw notFound(id);
    return found;
  };
  const save = (
    id: string,
    changes: Partial<PlatformAccount>,
    credentials?: Stored["credentials"],
  ) => {
    const current = find(id);
    const account = { ...current.account, ...changes, updatedAt: new Date() };
    const nextCredentials = credentials === undefined ? current.credentials : credentials;
    stored.set(id, {
      account: { ...account, hasCredentials: nextCredentials !== null },
      credentials: nextCredentials,
    });
    return structuredCopy(stored.get(id)?.account as PlatformAccount);
  };
  const byCreation = (a: PlatformAccount, b: PlatformAccount) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    async upsertConnected(input) {
      if (options.brokers && (await options.brokers.findById(input.brokerId)) === null) {
        throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${input.brokerId}`, {
          details: { brokerId: input.brokerId },
        });
      }
      const existing = [...stored.values()].find(
        ({ account }) =>
          account.brokerId === input.brokerId &&
          account.platform === input.platform &&
          account.externalAccountId === input.externalAccountId,
      );
      const changes = {
        displayName: input.displayName,
        tokenExpiresAt: input.tokenExpiresAt === null ? null : new Date(input.tokenExpiresAt),
        meta: structuredCopy(input.meta),
        status: "connected" as const,
      };
      if (existing !== undefined) {
        return save(existing.account.id, changes, { ...input.credentials });
      }
      const now = new Date();
      const account: PlatformAccount = {
        id: `account-${++next}`,
        brokerId: input.brokerId,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
        ...changes,
        hasCredentials: true,
        createdAt: now,
        updatedAt: now,
      };
      stored.set(account.id, { account, credentials: { ...input.credentials } });
      return structuredCopy(account);
    },
    async get(id) {
      const found = stored.get(id);
      return found === undefined ? null : structuredCopy(found.account);
    },
    async list() {
      return [...stored.values()]
        .map(({ account }) => account)
        .sort(byCreation)
        .map(structuredCopy);
    },
    async listByBroker(brokerId, platform) {
      return [...stored.values()]
        .map(({ account }) => account)
        .filter((account) => account.brokerId === brokerId)
        .filter((account) => platform === undefined || account.platform === platform)
        .sort(byCreation)
        .map(structuredCopy);
    },
    async getCredentials(id) {
      const { credentials } = find(id);
      if (credentials === null) {
        throw new AppError("ACCOUNT_NOT_CONNECTED", "La cuenta no tiene credenciales: conéctala", {
          details: { accountId: id },
        });
      }
      return { ...credentials };
    },
    async updateToken(id, update) {
      const current = find(id);
      return save(
        id,
        {
          tokenExpiresAt: update.tokenExpiresAt === null ? null : new Date(update.tokenExpiresAt),
          meta: { ...current.account.meta, ...structuredCopy(update.meta ?? {}) },
        },
        { ...update.credentials },
      );
    },
    async markStatus(id, status) {
      return save(id, { status });
    },
    async disconnect(id) {
      return save(id, { status: "revoked" }, null);
    },
    storedCredentials(id) {
      const found = stored.get(id);
      return found?.credentials ? { ...found.credentials } : null;
    },
  };
}
