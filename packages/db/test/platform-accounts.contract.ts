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
      expect(await repos.accounts.changeStatus(created.id, "connected", "expired")).toBe(true);

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
      expect(again.createdAt).toEqual(created.createdAt);
      expect(again.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
      expect(
        (await repos.accounts.listByBroker(brokerId)).filter(
          (account) => account.externalAccountId === first.externalAccountId,
        ),
      ).toHaveLength(1);
    });

    it("reconectar una cuenta desconectada la deja conectada y con credenciales", async () => {
      const input = connectedAccount(brokerId);
      const created = await repos.accounts.upsertConnected(input);
      await repos.accounts.disconnect(created.id);

      const again = await repos.accounts.upsertConnected(input);

      expect(again).toMatchObject({ id: created.id, status: "connected", hasCredentials: true });
      expect(await repos.accounts.getCredentials(created.id)).toEqual(input.credentials);
    });

    it("la misma cuenta externa en otra plataforma es otra fila", async () => {
      const input = connectedAccount(brokerId);
      const instagram = await repos.accounts.upsertConnected(input);
      const portal = await repos.accounts.upsertConnected({
        ...input,
        platform: "portal_inmobiliario",
      });

      expect(portal.id).not.toBe(instagram.id);
    });

    it("guarda meta como JSON: sin undefined y con las fechas como texto", async () => {
      const account = await repos.accounts.upsertConnected(
        connectedAccount(brokerId, {
          meta: { at: new Date("2026-10-05T12:00:00Z"), nada: undefined, n: 1 },
        }),
      );

      expect(account.meta).toEqual({ at: "2026-10-05T12:00:00.000Z", n: 1 });
      expect((await repos.accounts.get(account.id))?.meta).toEqual(account.meta);
    });

    it("rechaza credenciales vacías o con otra forma (CREDENTIALS_INVALID), sin el valor en el error", async () => {
      for (const credentials of [{ accessToken: "" }, { otra: "IGAA-secreto" }]) {
        const error = await repos.accounts
          .upsertConnected(
            connectedAccount(brokerId, { credentials: credentials as { accessToken: string } }),
          )
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: "CREDENTIALS_INVALID", retriable: false });
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
          "IGAA-secreto",
        );
      }
      const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
      await expect(
        repos.accounts.updateToken(account.id, {
          credentials: { accessToken: "" },
          tokenExpiresAt: null,
        }),
      ).rejects.toMatchObject({ code: "CREDENTIALS_INVALID" });
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

    it("con revokeOthers desconecta las demás cuentas del corredor en esa plataforma, en el mismo paso", async () => {
      const own = (await repos.brokers.create(brokerData(unique("cuentas-revoca")))).id;
      const other = (await repos.brokers.create(brokerData(unique("cuentas-revoca-otro")))).id;
      const first = await repos.accounts.upsertConnected(connectedAccount(own));
      const elsewhere = await repos.accounts.upsertConnected(connectedAccount(other));
      const thirdInput = connectedAccount(own);
      const second = await repos.accounts.upsertConnected(thirdInput, { revokeOthers: true });
      expect(second.status).toBe("connected");
      expect(await repos.accounts.get(first.id)).toMatchObject({
        status: "revoked",
        hasCredentials: false,
      });
      await expect(repos.accounts.getCredentials(first.id)).rejects.toMatchObject({
        code: "ACCOUNT_NOT_CONNECTED",
      });
      // Otro corredor no se toca, y reconectar la misma cuenta con revokeOthers la deja conectada.
      expect((await repos.accounts.get(elsewhere.id))?.status).toBe("connected");
      const again = await repos.accounts.upsertConnected(thirdInput, { revokeOthers: true });
      expect(again).toMatchObject({ id: second.id, status: "connected" });
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

    it("updateToken guarda el token nuevo y mezcla meta a un nivel, sin cambiar el estado", async () => {
      const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));

      const updated = await repos.accounts.updateToken(account.id, {
        credentials: { accessToken: "IGAA-refrescado" },
        tokenExpiresAt: new Date("2027-02-01T00:00:00Z"),
        meta: { tokenRefreshedAt: "2026-10-05T12:00:00.000Z" },
      });

      expect(updated).toMatchObject({
        status: "connected",
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
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(account.updatedAt.getTime());

      const again = await repos.accounts.updateToken(account.id, {
        credentials: { accessToken: "IGAA-otra-vez" },
        tokenExpiresAt: null,
      });
      expect(again).toMatchObject({ tokenExpiresAt: null, meta: updated.meta });
    });

    it("updateToken no revive una cuenta vencida ni desconectada (ACCOUNT_NOT_CONNECTED)", async () => {
      const update = { credentials: { accessToken: "IGAA-tarde" }, tokenExpiresAt: null };
      const expired = await repos.accounts.upsertConnected(connectedAccount(brokerId));
      await repos.accounts.changeStatus(expired.id, "connected", "expired");
      const revoked = await repos.accounts.upsertConnected(connectedAccount(brokerId));
      await repos.accounts.disconnect(revoked.id);

      for (const account of [expired, revoked]) {
        await expect(repos.accounts.updateToken(account.id, update)).rejects.toMatchObject({
          code: "ACCOUNT_NOT_CONNECTED",
        });
      }
      expect(await repos.accounts.get(revoked.id)).toMatchObject({
        status: "revoked",
        hasCredentials: false,
      });
      expect(await repos.accounts.getCredentials(expired.id)).not.toEqual({
        accessToken: "IGAA-tarde",
      });
    });

    it("changeStatus es condicional: no cambia si la cuenta ya está en otro estado", async () => {
      const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));

      expect(await repos.accounts.changeStatus(account.id, "expired", "error")).toBe(false);
      expect((await repos.accounts.get(account.id))?.status).toBe("connected");
      expect(await repos.accounts.changeStatus(account.id, "connected", "error")).toBe(true);
      expect(await repos.accounts.get(account.id)).toMatchObject({
        status: "error",
        hasCredentials: true,
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
        () => repos.accounts.changeStatus(id, "connected", "expired"),
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
