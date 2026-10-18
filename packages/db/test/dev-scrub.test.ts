import { createSecretBox } from "@agentsales/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type DevScrubDeps, databaseTarget, runDevScrub } from "../src/dev-scrub.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { brokers, platformAccounts } from "../src/schema.js";
import { brokerData } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { connectedAccount } from "./platform-accounts.contract.js";

// `pnpm db:dev-scrub` (spec F8 §4.6): borra las credenciales copiadas en la rama de desarrollo y se
// niega a correr contra lo que parece producción.

const PRODUCTION_KEY = "p".repeat(32);
const DEV_KEY = "d".repeat(32);
const DEV_URL = "postgresql://u:secreto@ep-dev-123-pooler.sa-east-1.aws.neon.tech/neondb";
const PROD_URL = "postgresql://u:otro@ep-main-456.sa-east-1.aws.neon.tech/neondb";

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

/** Una "rama" con dos cuentas cifradas con la clave de producción (Instagram y Portal). */
async function setup(overrides: Partial<DevScrubDeps> = {}, answer = true) {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  const broker = await createBrokerRepository(db).create(brokerData("dev-scrub"));
  const production = createPlatformAccountRepository(db, {
    secretBox: createSecretBox(PRODUCTION_KEY),
  });
  await production.upsertConnected(connectedAccount(broker.id));
  await production.upsertConnected(
    connectedAccount(broker.id, {
      platform: "portal_inmobiliario",
      externalAccountId: "8035443",
      credentials: { accessToken: "APP_USR-a", refreshToken: "TG-r" },
      meta: {
        userId: "8035443",
        nickname: "CORREDORA_PRUEBA",
        siteId: "MLC",
        userType: "normal",
        scopes: ["offline_access", "read", "write"],
        testUser: false,
        connectedAt: "2026-09-20T12:00:00.000Z",
        tokenRefreshedAt: null,
        accessTokenExpiresAt: "2026-09-20T18:00:00.000Z",
        tokenExpiryEstimated: true,
      },
    }),
  );
  const out: string[] = [];
  const questions: string[] = [];
  const deps: DevScrubDeps = {
    db,
    secretBox: createSecretBox(DEV_KEY),
    databaseUrl: DEV_URL,
    appEncryptionKey: DEV_KEY,
    nodeEnv: "development",
    envFile: undefined,
    production: { databaseUrl: PROD_URL, appEncryptionKey: PRODUCTION_KEY },
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
    print: (line) => out.push(line),
    printError: (line) => out.push(line),
    ...overrides,
  };
  const rows = () => db.select().from(platformAccounts);
  return { deps, out, questions, rows, db };
}

describe("pnpm db:dev-scrub", () => {
  it("borra las credenciales que la clave de desarrollo no abre y deja las cuentas desconectadas", async () => {
    const s = await setup();
    expect(await runDevScrub(s.deps, { yes: false })).toBe(0);
    expect(s.questions).toHaveLength(1);
    const rows = await s.rows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ credentialsEncrypted: null, status: "revoked" });
    }
    const text = s.out.join("\n");
    expect(text).toContain("ep-dev-123.sa-east-1.aws.neon.tech/neondb");
    expect(text).toContain("instagram 1, portal_inmobiliario 1");
    expect(text).not.toContain("secreto");

    // Una segunda vez no hay nada que borrar (idempotente), sin preguntar.
    expect(await runDevScrub(s.deps, { yes: false })).toBe(0);
    expect(s.questions).toHaveLength(1);
    expect(s.out.at(-1)).toContain("nada que borrar");
  });

  it("con --yes no pregunta; si la respuesta es no, no borra nada", async () => {
    const yes = await setup();
    expect(await runDevScrub(yes.deps, { yes: true })).toBe(0);
    expect(yes.questions).toEqual([]);

    const no = await setup({}, false);
    expect(await runDevScrub(no.deps, { yes: false })).toBe(1);
    expect((await no.rows()).every((row) => row.credentialsEncrypted !== null)).toBe(true);
  });

  // Un caso por base (cada uno con su PGlite y su tiempo): juntos pasaban de 20 s con la máquina
  // cargada.
  it.each([
    ["sin .env.production", null],
    [
      "sin su base (una base de producción con la clave de desarrollo: la clave no la delata)",
      { appEncryptionKey: PRODUCTION_KEY },
    ],
    ["con una base que no es una URL", { databaseUrl: "no es url" }],
  ] as const)(
    "%s, se niega: no hay con qué comparar (también con --yes)",
    async (_case, production) => {
      const s = await setup({ production });
      expect(await runDevScrub(s.deps, { yes: true })).toBe(1);
      expect(s.out.join("\n")).toContain("No se borró nada");
      expect((await s.rows()).every((row) => row.credentialsEncrypted !== null)).toBe(true);
    },
  );

  it("deja las credenciales que abre la clave de desarrollo (conectadas en la rama) y una segunda vez no hace nada", async () => {
    const s = await setup();
    const [broker] = await s.db.select().from(brokers);
    await createPlatformAccountRepository(s.db, {
      secretBox: createSecretBox(DEV_KEY),
    }).upsertConnected(connectedAccount(broker?.id ?? "", { externalAccountId: "dev-1" }));

    expect(await runDevScrub(s.deps, { yes: true })).toBe(0);
    const rows = await s.rows();
    expect(
      rows.filter((row) => row.credentialsEncrypted !== null).map((row) => row.externalAccountId),
    ).toEqual(["dev-1"]);
    expect(s.out.join("\n")).toContain("Las 1 que abre la clave de desarrollo");

    expect(await runDevScrub(s.deps, { yes: false })).toBe(0);
    expect(s.questions).toEqual([]);
    expect(s.out.at(-1)).toContain("nada que borrar");
  });

  it("se niega con la misma base o la misma clave que .env.production (también con o sin pooler)", async () => {
    const sameDb = await setup({
      production: {
        databaseUrl: "postgres://otro:x@ep-dev-123.sa-east-1.aws.neon.tech:5432/neondb",
        appEncryptionKey: PRODUCTION_KEY,
      },
    });
    expect(await runDevScrub(sameDb.deps, { yes: true })).toBe(1);
    expect(sameDb.out.join("\n")).toContain("misma base");

    const sameKey = await setup({
      production: { databaseUrl: PROD_URL, appEncryptionKey: DEV_KEY },
    });
    expect(await runDevScrub(sameKey.deps, { yes: true })).toBe(1);
    expect(sameKey.out.join("\n")).toContain("misma que la de .env.production");
    expect((await sameKey.rows()).every((row) => row.credentialsEncrypted !== null)).toBe(true);
  });

  it("se niega con ENV_FILE o con NODE_ENV=production, sin tocar la base", async () => {
    const withEnvFile = await setup({ envFile: ".env.production" });
    expect(await runDevScrub(withEnvFile.deps, { yes: true })).toBe(1);
    expect(withEnvFile.out.join("\n")).toContain("ENV_FILE");

    const prod = await setup({ nodeEnv: "production" });
    expect(await runDevScrub(prod.deps, { yes: true })).toBe(1);
    const [row] = await prod.db
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.platform, "instagram"));
    expect(row?.credentialsEncrypted).not.toBeNull();
  });

  it("databaseTarget compara host, puerto y base, sin usuario ni contraseña", () => {
    expect(databaseTarget(DEV_URL)).toEqual({
      host: "ep-dev-123.sa-east-1.aws.neon.tech",
      port: "5432",
      database: "neondb",
    });
    expect(databaseTarget("no es una url")).toBeNull();
  });
});
