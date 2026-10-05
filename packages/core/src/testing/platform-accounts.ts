import { AppError } from "../errors.js";
import {
  checkCredentials,
  normalizeAccountMeta,
  type PlatformAccount,
  type PlatformCredentials,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { structuredCopy } from "./copy.js";

export type InMemoryPlatformAccountRepository = PlatformAccountRepository & {
  /** Las credenciales guardadas tal cual (en memoria no se cifran), para afirmar en los tests. */
  storedCredentials(id: string): PlatformCredentials | null;
  /**
   * Hace que `getCredentials` de esa cuenta falle como un cifrado ilegible (otra clave o
   * alterado): `CREDENTIALS_UNREADABLE`. Para probar que quien publica o refresca lo maneja.
   */
  corruptCredentials(id: string): void;
};

export type InMemoryPlatformAccountRepositoryOptions = {
  /** Para rechazar un corredor que no existe como Postgres (`BROKER_NOT_FOUND`); sin él, no valida. */
  brokers?: Pick<BrokerRepository, "findById">;
};

type Stored = {
  /** Orden de creación: el desempate estable (Postgres usa `created_at` con microsegundos). */
  sequence: number;
  account: PlatformAccount;
  credentials: PlatformCredentials | null;
  unreadable: boolean;
};

const notFound = (id: string) =>
  new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${id}`, { details: { accountId: id } });

const notConnected = (id: string) =>
  new AppError("ACCOUNT_NOT_CONNECTED", "La cuenta no tiene credenciales: conéctala", {
    details: { accountId: id },
  });

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
  /** Aplica cambios y devuelve una copia de la cuenta guardada. */
  const save = (
    id: string,
    changes: Partial<PlatformAccount>,
    credentials?: PlatformCredentials | null,
  ): PlatformAccount => {
    const current = find(id);
    const nextCredentials = credentials === undefined ? current.credentials : credentials;
    const account: PlatformAccount = {
      ...current.account,
      ...changes,
      hasCredentials: nextCredentials !== null,
      updatedAt: new Date(),
    };
    stored.set(id, {
      ...current,
      account,
      credentials: nextCredentials,
      unreadable: credentials === undefined ? current.unreadable : false,
    });
    return structuredCopy(account);
  };
  const ordered = (filter: (account: PlatformAccount) => boolean) =>
    [...stored.values()]
      .filter(({ account }) => filter(account))
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ account }) => structuredCopy(account));

  return {
    async upsertConnected(input) {
      const credentials = checkCredentials(input.credentials);
      const meta = normalizeAccountMeta(input.meta);
      if (options.brokers && (await options.brokers.findById(input.brokerId)) === null) {
        throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${input.brokerId}`, {
          details: { brokerId: input.brokerId },
        });
      }
      const changes = {
        displayName: input.displayName,
        tokenExpiresAt: input.tokenExpiresAt === null ? null : new Date(input.tokenExpiresAt),
        meta,
        status: "connected" as const,
      };
      const existing = [...stored.values()].find(
        ({ account }) =>
          account.brokerId === input.brokerId &&
          account.platform === input.platform &&
          account.externalAccountId === input.externalAccountId,
      );
      if (existing !== undefined) return save(existing.account.id, changes, credentials);
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
      stored.set(account.id, { sequence: next, account, credentials, unreadable: false });
      return structuredCopy(account);
    },
    async get(id) {
      const found = stored.get(id);
      return found === undefined ? null : structuredCopy(found.account);
    },
    async list() {
      return ordered(() => true);
    },
    async listByBroker(brokerId, platform) {
      return ordered(
        (account) =>
          account.brokerId === brokerId &&
          (platform === undefined || account.platform === platform),
      );
    },
    async getCredentials(id) {
      const { credentials, unreadable } = find(id);
      if (credentials === null) throw notConnected(id);
      if (unreadable) {
        throw new AppError(
          "CREDENTIALS_UNREADABLE",
          "No se pudieron leer las credenciales guardadas: reconecta la cuenta",
          { details: { reason: "authentication" } },
        );
      }
      return { ...credentials };
    },
    async updateToken(id, update) {
      const credentials = checkCredentials(update.credentials);
      const patch = normalizeAccountMeta(update.meta);
      const current = find(id);
      if (current.account.status !== "connected" || current.credentials === null) {
        throw notConnected(id);
      }
      return save(
        id,
        {
          tokenExpiresAt: update.tokenExpiresAt === null ? null : new Date(update.tokenExpiresAt),
          meta: { ...current.account.meta, ...patch },
        },
        credentials,
      );
    },
    async changeStatus(id, from, to) {
      if (find(id).account.status !== from) return false;
      save(id, { status: to });
      return true;
    },
    async disconnect(id) {
      return save(id, { status: "revoked" }, null);
    },
    storedCredentials(id) {
      const found = stored.get(id);
      return found?.credentials ? { ...found.credentials } : null;
    },
    corruptCredentials(id) {
      const found = find(id);
      stored.set(id, { ...found, unreadable: true });
    },
  };
}
