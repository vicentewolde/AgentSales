import type {
  BrokerRepository,
  ConnectedAccount,
  PlatformAccountRepository,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";
import { brokerData } from "./import-repositories.contract.js";

/**
 * Suite de contrato de `PlatformAccountRepository` (F3-T03): corre igual contra el doble en memoria
 * y contra Drizzle sobre PGlite. Cada caso usa su propia cuenta externa: la base se comparte.
 */
export type PlatformAccountRepositories = {
  brokers: BrokerRepository;
  accounts: PlatformAccountRepository;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

export const connectedAccount = (
  brokerId: string,
  overrides: Partial<ConnectedAccount> = {},
): ConnectedAccount => ({
  brokerId,
  platform: "instagram",
  externalAccountId: unique("17841400"),
  displayName: "@muestra",
  tokenExpiresAt: new Date("2026-12-04T12:00:00Z"),
  meta: { accountType: "MEDIA_CREATOR", permissions: ["instagram_business_basic"] },
  credentials: { accessToken: unique("IGAA-token") },
  ...overrides,
});

export function platformAccountRepositoryContract(
  name: string,
  make: () => Promise<PlatformAccountRepositories>,
) {
  describe(`${name} · PlatformAccountRepository`, () => {
    let repos: PlatformAccountRepositories;
    let brokerId: string;
    beforeAll(async () => {
      repos = await make();
      brokerId = (await repos.brokers.create(brokerData(unique("cuentas")))).id;
    });

    it("upsertConnected crea la cuenta conectada, sin credenciales en la entidad", async () => {
      const input = connectedAccount(brokerId);
      const account = await repos.accounts.upsertConnected(input);

      expect(account).toMatchObject({
        brokerId,
        platform: "instagram",
        externalAccountId: input.externalAccountId,
        displayName: "@muestra",
        status: "connected",
        tokenExpiresAt: input.tokenExpiresAt,
        meta: input.meta,
        hasCredentials: true,
      });
      expect(JSON.stringify(account)).not.toContain(input.credentials.accessToken);
      expect(await repos.accounts.get(account.id)).toEqual(account);
      expect(await repos.accounts.get(repos.missingId)).toBeNull();
    });

    it("getCredentials devuelve las credenciales descifradas", async () => {
      const input = connectedAccount(brokerId);
      const account = await repos.accounts.upsertConnected(input);

      expect(await repos.accounts.getCredentials(account.id)).toEqual(input.credentials);
    });

    it("reconectar la misma cuenta actualiza la fila (mismo id) y la deja conectada", async () => {
      const first = connectedAccount(brokerId);
      const created = await repos.accounts.upsertConnected(first);
      await repos.accounts.markStatus(created.id, "expired");

      const again = await repos.accounts.upsertConnected({
        ...first,
        displayName: "@nuevo",
        meta: { accountType: "BUSINESS" },
        credentials: { accessToken: "IGAA-reconectada" },
        tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
      });

      expect(again).toMatchObject({
        id: created.id,
        displayName: "@nuevo",
        status: "connected",
        meta: { accountType: "BUSINESS" },
        tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
      });
      expect(await repos.accounts.getCredentials(created.id)).toEqual({
        accessToken: "IGAA-reconectada",
      });
    });

    it("la misma cuenta externa en otro corredor es otra fila", async () => {
      const other = (await repos.brokers.create(brokerData(unique("cuentas-otro")))).id;
      const input = connectedAccount(brokerId);
      const mine = await repos.accounts.upsertConnected(input);
      const theirs = await repos.accounts.upsertConnected({ ...input, brokerId: other });

      expect(theirs.id).not.toBe(mine.id);
      expect((await repos.accounts.listByBroker(other)).map((account) => account.id)).toEqual([
        theirs.id,
      ]);
    });

    it("listByBroker filtra por corredor y plataforma, por fecha de creación; list las trae todas", async () => {
      const own = (await repos.brokers.create(brokerData(unique("cuentas-lista")))).id;
      const first = await repos.accounts.upsertConnected(connectedAccount(own));
      const second = await repos.accounts.upsertConnected(connectedAccount(own));

      expect((await repos.accounts.listByBroker(own)).map((account) => account.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect(await repos.accounts.listByBroker(own, "portal_inmobiliario")).toEqual([]);
      expect((await repos.accounts.listByBroker(own, "instagram")).length).toBe(2);
      const all = (await repos.accounts.list()).map((account) => account.id);
      expect(all).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(all.indexOf(first.id)).toBeLessThan(all.indexOf(second.id));
    });

    it("updateToken guarda el token nuevo y mezcla meta, sin cambiar el estado", async () => {
      const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
      await repos.accounts.markStatus(account.id, "error");

      const updated = await repos.accounts.updateToken(account.id, {
        credentials: { accessToken: "IGAA-refrescado" },
        tokenExpiresAt: new Date("2027-02-01T00:00:00Z"),
        meta: { tokenRefreshedAt: "2026-10-05T12:00:00.000Z" },
      });

      expect(updated).toMatchObject({
        status: "error",
        tokenExpiresAt: new Date("2027-02-01T00:00:00Z"),
        meta: {
          accountType: "MEDIA_CREATOR",
          permissions: ["instagram_business_basic"],
          tokenRefreshedAt: "2026-10-05T12:00:00.000Z",
        },
      });
      expect(await repos.accounts.getCredentials(account.id)).toEqual({
        accessToken: "IGAA-refrescado",
      });
    });

    it("disconnect deja la cuenta en revoked, sin credenciales; getCredentials da ACCOUNT_NOT_CONNECTED", async () => {
      const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
      const disconnected = await repos.accounts.disconnect(account.id);

      expect(disconnected).toMatchObject({ status: "revoked", hasCredentials: false });
      await expect(repos.accounts.getCredentials(account.id)).rejects.toMatchObject({
        code: "ACCOUNT_NOT_CONNECTED",
        retriable: false,
      });
    });

    it("una cuenta que no existe es ACCOUNT_NOT_FOUND en cada escritura y en getCredentials", async () => {
      const id = repos.missingId;
      const credentials = { accessToken: "x" };
      for (const action of [
        () => repos.accounts.getCredentials(id),
        () => repos.accounts.updateToken(id, { credentials, tokenExpiresAt: null }),
        () => repos.accounts.markStatus(id, "expired"),
        () => repos.accounts.disconnect(id),
      ]) {
        await expect(action()).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
      }
    });

    it("un corredor que no existe es BROKER_NOT_FOUND", async () => {
      await expect(
        repos.accounts.upsertConnected(connectedAccount(repos.missingId)),
      ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND", retriable: false });
    });
  });
}
