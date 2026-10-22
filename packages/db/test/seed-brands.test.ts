import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brokers, editorialProfiles } from "../src/schema.js";
import { seed } from "../src/seed.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F9-T03 (spec F9 §4.11): solo con `--operator-brands` (D19: la instancia de clientes no las lleva),
// el seed siembra las dos marcas del operador con su perfil editorial vacío, sin duplicarlas ni pisar
// lo que el operador ya cambió. Las pruebas van en orden sobre la misma base.

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
  await seed(test.db);
});

afterAll(() => test.close());

const brandRows = () =>
  test.db
    .select({
      id: brokers.id,
      slug: brokers.slug,
      name: brokers.name,
      kind: brokers.kind,
      operatorOwned: brokers.operatorOwned,
      autoPublish: brokers.autoPublish,
      // F9.5-T22 (ADR-0036): el seed nunca enciende el modo en vivo de nada.
      liveEnabled: brokers.liveEnabled,
    })
    .from(brokers)
    .where(inArray(brokers.slug, ["vinny", "agentpey"]))
    .orderBy(brokers.slug);

describe("seed · marcas del operador (PGlite)", () => {
  it("sin el parámetro no las crea (ni sus perfiles): el seed de siempre", async () => {
    expect(await brandRows()).toEqual([]);
    expect(await test.db.select().from(editorialProfiles)).toEqual([]);
    const demo = await test.db.select().from(brokers).where(eq(brokers.slug, "demo"));
    expect(demo).toHaveLength(1);
  });

  it("con el parámetro crea Vinny y AgentPey como marcas del operador, con su perfil vacío", async () => {
    await seed(test.db, { operatorBrands: true });
    const rows = await brandRows();
    expect(rows.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        slug: "agentpey",
        name: "AgentPey",
        kind: "brand",
        operatorOwned: true,
        autoPublish: false,
        liveEnabled: false,
      },
      {
        slug: "vinny",
        name: "Vinny",
        kind: "brand",
        operatorOwned: true,
        autoPublish: false,
        liveEnabled: false,
      },
    ]);
    const profiles = await test.db
      .select()
      .from(editorialProfiles)
      .where(
        inArray(
          editorialProfiles.brokerId,
          rows.map((row) => row.id),
        ),
      );
    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      expect(profile).toMatchObject({
        languages: ["es"],
        audience: null,
        pillars: [],
        facts: [],
        avoid: [],
        cadence: {},
        defaultHashtags: [],
      });
    }
  });

  it("con el parámetro otra vez no duplica ni pisa lo que el operador cambió en la marca o en su perfil", async () => {
    const [agentpey] = await brandRows();
    await test.db
      .update(brokers)
      .set({ primaryColor: "#ABCDEF", tone: "Directo" })
      .where(eq(brokers.slug, "agentpey"));
    await test.db
      .update(editorialProfiles)
      .set({ facts: ["AgentPey publica avisos"], languages: ["es", "en"] })
      .where(eq(editorialProfiles.brokerId, agentpey?.id ?? ""));

    await seed(test.db, { operatorBrands: true });
    await seed(test.db, { operatorBrands: true });
    // Sin el parámetro, tampoco las borra.
    await seed(test.db);

    const rows = await brandRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(agentpey?.id);
    const [broker] = await test.db.select().from(brokers).where(eq(brokers.slug, "agentpey"));
    expect(broker).toMatchObject({ primaryColor: "#ABCDEF", tone: "Directo" });
    const profiles = await test.db.select().from(editorialProfiles);
    expect(profiles).toHaveLength(2);
    expect(profiles.find((profile) => profile.brokerId === agentpey?.id)).toMatchObject({
      facts: ["AgentPey publica avisos"],
      languages: ["es", "en"],
    });
  });
});
