import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryBrokerRepository,
  createInMemoryUserRepositories,
} from "@agentsales/core/testing";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import {
  createInvitationRepository,
  createOAuthStateRepository,
  createSessionRepository,
  createUserRepository,
} from "../src/repositories/users.js";
import { brokerData } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { userRepositoryContract } from "./users.contract.js";

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

async function pgliteRepositories() {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  return {
    db,
    brokers: createBrokerRepository(db),
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    invitations: createInvitationRepository(db),
    oauthStates: createOAuthStateRepository(db),
  };
}

userRepositoryContract("en memoria", async () => ({
  brokers: createInMemoryBrokerRepository(),
  ...createInMemoryUserRepositories(),
}));

userRepositoryContract("Drizzle sobre PGlite", pgliteRepositories);

describe("usuarios · Postgres (PGlite)", () => {
  it("borrar un usuario borra sus sesiones (cascada)", async () => {
    const repos = await pgliteRepositories();
    const user = await repos.users.create({
      email: "cascada@ejemplo.cl",
      name: "x",
      role: "admin",
      brokerId: null,
    });
    await repos.sessions.create({
      userId: user.id,
      tokenHash: "h-cascada",
      client: "panel",
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await repos.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    expect(await repos.sessions.findByTokenHash("h-cascada")).toBeNull();
  });

  it("un corredor creado después de la migración nace no propio", async () => {
    const repos = await pgliteRepositories();
    const broker = await repos.brokers.create(brokerData("nuevo-despues-de-0009"));
    expect(broker.operatorOwned).toBe(false);
  });
});

describe("migración 0009", () => {
  it("marca como propios a los corredores que ya existían", async () => {
    const client = new PGlite();
    try {
      const files = readdirSync(MIGRATIONS_FOLDER)
        .filter((file) => file.endsWith(".sql"))
        .sort();
      const apply = async (file: string) => {
        const text = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
        for (const statement of text.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") await client.exec(statement);
        }
      };
      for (const file of files.filter((file) => file < "0009")) await apply(file);
      await client.exec(
        `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color)
         VALUES ('de-antes', 'De antes', 'De antes', '#112233', '#112233')`,
      );
      await apply(files.find((file) => file.startsWith("0009")) ?? "");
      const result = await client.query(
        "SELECT operator_owned FROM brokers WHERE slug = 'de-antes'",
      );
      expect(result.rows[0]).toEqual({ operator_owned: true });
    } finally {
      await client.close();
    }
  });
});
