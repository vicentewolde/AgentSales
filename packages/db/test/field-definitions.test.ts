import { fieldDefinitionOrderFixture } from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SchemaDatabase } from "../src/client.js";
import { sqlStateOf } from "../src/errors.js";
import { createFieldDefinitionRepository } from "../src/repositories/field-definitions.js";
import { brokers, fieldDefinitions } from "../src/schema.js";
import { seed } from "../src/seed.js";
import { REAL_ESTATE_FIELD_DEFINITIONS } from "../src/seed-data.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// Cada `describe` usa su propia categoría o sus propias filas, para que se puedan correr solos.
let test: TestDatabase;
let demoBrokerId: string;

beforeAll(async () => {
  test = await createTestDatabase();
  ({ brokerId: demoBrokerId } = await seed(test.db));
});

afterAll(() => test.close());

async function createBroker(slug: string): Promise<string> {
  const [row] = await test.db
    .insert(brokers)
    .values({
      slug,
      name: slug,
      brandName: slug,
      primaryColor: "#000000",
      secondaryColor: "#FFFFFF",
    })
    .returning({ id: brokers.id });
  if (!row) throw new Error(`no se creó el broker ${slug}`);
  return row.id;
}

const realEstateGlobals = async () =>
  (await test.db.select().from(fieldDefinitions)).filter(
    (row) => row.category === "real_estate" && row.brokerId === null,
  );

describe("seed (PGlite)", () => {
  it("es idempotente: otra vez deja 36 globales con los mismos id y un solo broker demo", async () => {
    const before = await realEstateGlobals();
    const second = await seed(test.db);
    expect(second).toEqual({ brokerId: demoBrokerId, fieldDefinitions: 36 });
    const after = await realEstateGlobals();
    expect(after).toHaveLength(36);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    const demo = (await test.db.select().from(brokers)).filter((row) => row.slug === "demo");
    expect(demo).toHaveLength(1);
  });

  it("restaura una global modificada a mano, sin cambiarle el id (upsert, no borrar e insertar)", async () => {
    const [original] = (await realEstateGlobals()).filter((row) => row.key === "banos");
    await test.db
      .update(fieldDefinitions)
      .set({ label: "cambiado a mano", required: false })
      .where(eq(fieldDefinitions.id, original?.id ?? ""));
    await seed(test.db);
    const [restored] = (await realEstateGlobals()).filter((row) => row.key === "banos");
    expect(restored).toMatchObject({ id: original?.id, label: "Baños", required: true });
  });

  it("guarda las opciones de los enum como arreglo jsonb", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: "real_estate", brokerId: null });
    expect(defs.map((def) => def.key)).toEqual(REAL_ESTATE_FIELD_DEFINITIONS.map((def) => def.key));
    expect(defs.find((def) => def.key === "moneda")?.options).toEqual(["UF", "CLP"]);
  });
});

describe("único (broker_id, category, key) NULLS NOT DISTINCT (PGlite)", () => {
  const field = { category: "unique_check", label: "Vista", type: "text" as const };

  it("rechaza una segunda definición global con el mismo key", async () => {
    await test.db
      .insert(fieldDefinitions)
      .values({ ...field, key: "vista", sourceColumn: "vista" });
    const error = await test.db
      .insert(fieldDefinitions)
      .values({ ...field, key: "vista", sourceColumn: "vista" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(sqlStateOf(error)).toBe("23505");
  });

  it("acepta una definición del corredor con el mismo key que una global", async () => {
    await test.db.insert(fieldDefinitions).values({ ...field, key: "piso", sourceColumn: "piso" });
    await test.db
      .insert(fieldDefinitions)
      .values({ ...field, key: "piso", sourceColumn: "piso", brokerId: demoBrokerId });
    const rows = (await test.db.select().from(fieldDefinitions)).filter(
      (row) => row.category === field.category && row.key === "piso",
    );
    expect(rows).toHaveLength(2);
  });
});

// Mismo fixture que el repositorio en memoria (packages/core/src/testing), para que ordenen igual.
describe("createFieldDefinitionRepository (PGlite)", () => {
  let fixture: ReturnType<typeof fieldDefinitionOrderFixture>;
  let brokerA: string;

  beforeAll(async () => {
    brokerA = await createBroker("orden-a");
    fixture = fieldDefinitionOrderFixture({ brokerA, brokerB: await createBroker("orden-b") });
    await test.db.insert(fieldDefinitions).values(fixture.rows);
  });

  const labels = (rows: { label: string }[]) => rows.map((row) => row.label);

  it("sin corredor devuelve las globales de la categoría (incluidas las inactivas), en orden", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: fixture.category, brokerId: null });
    expect(labels(defs)).toEqual(fixture.expected.global);
  });

  it("con corredor suma las suyas, con la global primero si el key se repite", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: fixture.category, brokerId: brokerA });
    expect(labels(defs)).toEqual(fixture.expected.brokerA);
  });

  it("una fila con options corrupto es FIELD_DEFINITION_INVALID, no un ZodError", async () => {
    await test.db.insert(fieldDefinitions).values({
      category: "corrupt_check",
      key: "tipo",
      label: "Tipo",
      type: "enum",
      options: { no: "es un arreglo" },
      sourceColumn: "tipo",
    });
    const repo = createFieldDefinitionRepository(test.db);
    await expect(repo.list({ category: "corrupt_check", brokerId: null })).rejects.toMatchObject({
      code: "FIELD_DEFINITION_INVALID",
      retriable: false,
      details: { key: "tipo" },
    });
  });

  it("traduce un fallo de conexión a DB_UNAVAILABLE", async () => {
    // PGlite no tiene red: se simula el error que da node-postgres con Neon caído. La forma real
    // del error se prueba en unreachable.test.ts.
    const unreachable = {
      select: () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        });
      },
    } as unknown as SchemaDatabase;
    const repo = createFieldDefinitionRepository(unreachable);
    await expect(repo.list({ category: "real_estate", brokerId: null })).rejects.toMatchObject({
      code: "DB_UNAVAILABLE",
    });
  });
});
