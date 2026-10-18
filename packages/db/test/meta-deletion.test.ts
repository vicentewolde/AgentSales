import { createSecretBox } from "@agentsales/config";
import {
  ERASED_ACCOUNT_DISPLAY_NAME,
  type LockedRepositories,
  type MetaDeletionRepository,
  type PlatformAccountRepository,
  type PublicationRepository,
} from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryMetaDeletionRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createMediaRepository } from "../src/repositories/media.js";
import { createMetaDeletionRepository } from "../src/repositories/meta-deletion-requests.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { createPublicationRepository } from "../src/repositories/publications.js";
import { metaDeletionRequests } from "../src/schema.js";
import { newContent } from "./content-repositories.contract.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { connectedAccount } from "./platform-accounts.contract.js";

// F8-T17 (spec F8 §4.11, D18): lo que borran las vueltas de Meta, igual en memoria y en PGlite.

type Repos = Omit<LockedRepositories, "publications" | "platformAccounts"> & {
  publications: PublicationRepository;
  platformAccounts: PlatformAccountRepository;
  metaDeletion: MetaDeletionRepository;
};

const RECEIVED = new Date("2026-10-18T15:00:00.000Z");
let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

/** Un corredor con una cuenta de Instagram de `instagramUserId` y una publicación publicada. */
async function seed(repos: Repos, instagramUserId: string) {
  const brokerId = (await repos.brokers.create(brokerData(unique("meta")))).id;
  const listingId = (await repos.listings.create(newListing(brokerId, unique("P-META")))).id;
  const account = await repos.platformAccounts.upsertConnected(
    connectedAccount(brokerId, { externalAccountId: instagramUserId, displayName: "@corredora" }),
  );
  const run = await repos.contentRuns.create({ listingId, texts: true });
  await repos.contentRuns.markRunning(run.id);
  await repos.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [newContent("instagram")],
  });
  const [content] = await repos.contents.listCurrent(listingId);
  const created = await repos.publications.create(
    {
      listingId,
      platformAccountId: account.id,
      platform: "instagram",
      format: "post",
      contentId: content?.id ?? "",
      mediaIds: [],
      listingSourceHash: "hash",
    },
    { actor: "operator" },
  );
  await repos.publications.transition(
    created.id,
    { from: "approved", to: "publishing", changes: { incrementAttempts: true, dryRun: false } },
    { actor: "system" },
  );
  await repos.publications.saveProgress(created.id, {
    attemptStartedAt: "2026-10-18T12:00:00.000Z",
    childIds: ["hijo-1"],
    containerId: "carrusel-1",
  });
  await repos.publications.addEvent(created.id, {
    type: "publish_attempt",
    actor: "system",
    payload: { mode: "live", sent: { account: { id: account.id, displayName: "@corredora" } } },
  });
  const publication = await repos.publications.transition(
    created.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: "17900000000000001",
        externalUrl: "https://www.instagram.com/p/abc/",
        publishedAt: RECEIVED,
      },
    },
    { actor: "system" },
  );
  return { account, publication };
}

function metaDeletionContract(name: string, make: () => Promise<Repos>) {
  describe(`${name} · MetaDeletionRepository`, () => {
    let repos: Repos;
    beforeAll(async () => {
      repos = await make();
    });

    it("quitar la app desconecta las cuentas de ese usuario y nada más", async () => {
      const user = unique("1784");
      const { account, publication } = await seed(repos, user);
      const other = await seed(repos, unique("1784"));

      expect(await repos.metaDeletion.deauthorizeInstagramUser(user)).toBe(1);
      expect(await repos.platformAccounts.get(account.id)).toMatchObject({
        status: "revoked",
        hasCredentials: false,
        externalAccountId: user,
        displayName: "@corredora",
      });
      // Sus publicaciones no cambian; la otra cuenta sigue conectada.
      expect(await repos.publications.get(publication.id)).toMatchObject({
        status: "published",
        externalId: "17900000000000001",
      });
      expect(await repos.platformAccounts.get(other.account.id)).toMatchObject({
        status: "connected",
      });
      // Otra vez: ya no queda nada que desconectar.
      expect(await repos.metaDeletion.deauthorizeInstagramUser(user)).toBe(0);
    });

    it("borrar los datos deja la cuenta sin credenciales ni datos, y las publicaciones sin enlace ni id pero en su estado, con su evento", async () => {
      const user = unique("1784");
      const { account, publication } = await seed(repos, user);
      const other = await seed(repos, unique("1784"));

      const request = await repos.metaDeletion.eraseInstagramUser({
        instagramUserId: user,
        instagramUserIdHash: `sha:${user}`,
        code: unique("codigo"),
        receivedAt: RECEIVED,
      });

      expect(request).toMatchObject({
        status: "completed",
        receivedAt: RECEIVED,
        completedAt: RECEIVED,
        accountsAffected: 1,
      });
      const erased = await repos.platformAccounts.get(account.id);
      expect(erased).toMatchObject({
        status: "revoked",
        hasCredentials: false,
        displayName: ERASED_ACCOUNT_DISPLAY_NAME,
        meta: {},
        tokenExpiresAt: null,
      });
      expect(erased?.externalAccountId).not.toContain(user);
      await expect(repos.platformAccounts.getCredentials(account.id)).rejects.toMatchObject({
        code: "ACCOUNT_NOT_CONNECTED",
      });
      expect(await repos.publications.get(publication.id)).toMatchObject({
        status: "published",
        externalId: null,
        externalUrl: null,
        progress: null,
      });
      const events = await repos.publications.listEvents(publication.id);
      expect(events.at(-1)).toMatchObject({
        type: "data_deleted",
        fromStatus: null,
        toStatus: null,
        actor: "system",
        payload: { confirmationCode: request.code },
      });
      // El nombre de la cuenta sale de lo enviado en el intento; lo demás queda.
      expect(events.find((event) => event.type === "publish_attempt")?.payload).toEqual({
        mode: "live",
        sent: { account: { id: account.id, displayName: "" } },
      });
      expect(await repos.metaDeletion.getByCode(request.code)).toEqual(request);
      // Lo de otro usuario no se toca.
      expect(await repos.publications.get(other.publication.id)).toMatchObject({
        externalId: "17900000000000001",
      });
    });

    it("la publicación borrada queda tocada después (updated_at avanza)", async () => {
      const user = unique("1784");
      const { publication } = await seed(repos, user);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await repos.metaDeletion.eraseInstagramUser({
        instagramUserId: user,
        instagramUserIdHash: "hmac",
        code: unique("codigo"),
        receivedAt: RECEIVED,
      });
      const after = await repos.publications.get(publication.id);
      expect(after?.updatedAt.getTime()).toBeGreaterThan(publication.updatedAt.getTime());
    });

    it("el mismo usuario en dos corredores: borra las dos cuentas; repetirlo no borra nada más", async () => {
      const user = unique("1784");
      const first = await seed(repos, user);
      const second = await seed(repos, user);
      const input = { instagramUserId: user, instagramUserIdHash: "hmac", receivedAt: RECEIVED };

      const request = await repos.metaDeletion.eraseInstagramUser({ ...input, code: unique("c") });
      expect(request.accountsAffected).toBe(2);
      for (const { account } of [first, second]) {
        expect((await repos.platformAccounts.get(account.id))?.displayName).toBe(
          ERASED_ACCOUNT_DISPLAY_NAME,
        );
      }
      const eventsBefore = (await repos.publications.listEvents(first.publication.id)).length;

      const again = await repos.metaDeletion.eraseInstagramUser({ ...input, code: unique("c") });
      expect(again.accountsAffected).toBe(0);
      expect(await repos.publications.listEvents(first.publication.id)).toHaveLength(eventsBefore);
    });

    it("una cuenta de otra plataforma con el mismo id externo no se toca", async () => {
      const user = unique("1784");
      const brokerId = (await repos.brokers.create(brokerData(unique("meta")))).id;
      const portal = await repos.platformAccounts.upsertConnected(
        connectedAccount(brokerId, {
          platform: "portal_inmobiliario",
          externalAccountId: user,
          displayName: "VENDEDOR",
          credentials: { accessToken: unique("APP_USR"), refreshToken: unique("TG") },
        }),
      );

      expect(await repos.metaDeletion.deauthorizeInstagramUser(user)).toBe(0);
      const request = await repos.metaDeletion.eraseInstagramUser({
        instagramUserId: user,
        instagramUserIdHash: "hmac",
        code: unique("codigo"),
        receivedAt: RECEIVED,
      });
      expect(request.accountsAffected).toBe(0);
      expect(await repos.platformAccounts.get(portal.id)).toMatchObject({
        status: "connected",
        externalAccountId: user,
        displayName: "VENDEDOR",
      });
    });

    it("un usuario que no calza responde con su pedido sin borrar nada", async () => {
      const request = await repos.metaDeletion.eraseInstagramUser({
        instagramUserId: unique("desconocido"),
        instagramUserIdHash: "sha:desconocido",
        code: unique("codigo"),
        receivedAt: RECEIVED,
      });
      expect(request.accountsAffected).toBe(0);
      expect(await repos.metaDeletion.getByCode(request.code)).toEqual(request);
      expect(await repos.metaDeletion.getByCode("no-existe")).toBeNull();
    });
  });
}

metaDeletionContract("en memoria", async () => {
  const brokers = createInMemoryBrokerRepository();
  const { contentRuns, contents } = createInMemoryContentRepositories();
  const publications = createInMemoryPublicationRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository({ brokers });
  return {
    brokers,
    listings: createInMemoryListingRepository(),
    media: createInMemoryMediaRepository(),
    contentRuns,
    contents,
    publications,
    platformAccounts,
    metaDeletion: createInMemoryMetaDeletionRepository({ platformAccounts, publications }),
  };
});

metaDeletionContract("Drizzle sobre PGlite", async () => {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  return {
    brokers: createBrokerRepository(db),
    listings: createListingRepository(db),
    media: createMediaRepository(db),
    contentRuns: createContentRunRepository(db),
    contents: createContentRepository(db),
    publications: createPublicationRepository(db),
    platformAccounts: createPlatformAccountRepository(db, {
      secretBox: createSecretBox("k".repeat(32)),
    }),
    metaDeletion: createMetaDeletionRepository(db),
  };
});

describe("pedidos de borrado de Meta · lo que el puerto no muestra (PGlite)", () => {
  it("si anotar el pedido falla, no queda nada borrado (una sola transacción)", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const { db } = database;
    const repos: Repos = {
      brokers: createBrokerRepository(db),
      listings: createListingRepository(db),
      media: createMediaRepository(db),
      contentRuns: createContentRunRepository(db),
      contents: createContentRepository(db),
      publications: createPublicationRepository(db),
      platformAccounts: createPlatformAccountRepository(db, {
        secretBox: createSecretBox("k".repeat(32)),
      }),
      metaDeletion: createMetaDeletionRepository(db),
    };
    const input = { instagramUserIdHash: "hmac", code: "codigo-repetido", receivedAt: RECEIVED };
    await repos.metaDeletion.eraseInstagramUser({ ...input, instagramUserId: "nadie" });
    const user = unique("1784");
    const { account, publication } = await seed(repos, user);

    // El mismo código choca con la llave primaria al final: lo anterior se deshace.
    await expect(
      repos.metaDeletion.eraseInstagramUser({ ...input, instagramUserId: user }),
    ).rejects.toThrow();
    expect(await repos.platformAccounts.get(account.id)).toMatchObject({
      status: "connected",
      externalAccountId: user,
      displayName: "@corredora",
    });
    expect(await repos.publications.get(publication.id)).toMatchObject({
      externalId: "17900000000000001",
    });
    expect(
      (await repos.publications.listEvents(publication.id)).some((e) => e.type === "data_deleted"),
    ).toBe(false);
  });

  it("la base guarda el hash del usuario, nunca el user_id", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const repository = createMetaDeletionRepository(database.db);
    await repository.eraseInstagramUser({
      instagramUserId: "17841400000000009",
      instagramUserIdHash: "sha:17841400000000009",
      code: "codigo-hash",
      receivedAt: RECEIVED,
    });
    const rows = await database.db
      .select()
      .from(metaDeletionRequests)
      .where(eq(metaDeletionRequests.code, "codigo-hash"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('"17841400000000009"');
    expect(rows[0]?.metaUserIdHash).toBe("sha:17841400000000009");
  });
});
