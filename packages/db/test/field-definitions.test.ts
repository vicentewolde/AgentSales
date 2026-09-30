import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SchemaDatabase } from "../src/client.js";
import { sqlStateOf } from "../src/errors.js";
import { createFieldDefinitionRepository } from "../src/repositories/field-definitions.js";
import { brokers, fieldDefinitions } from "../src/schema.js";
import { seed } from "../src/seed.js";
import { REAL_ESTATE_FIELD_DEFINITIONS } from "../src/seed-data.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

let test: TestDatabase;
let demoBrokerId: string;
let otherBrokerId: string;

beforeAll(async () => {
  test = await createTestDatabase();
  ({ brokerId: demoBrokerId } = await seed(test.db));
  const [other] = await test.db
    .insert(brokers)
    .values({
      slug: "otro",
      name: "Otro",
      brandName: "Otro",
      primaryColor: "#000000",
      secondaryColor: "#FFFFFF",
    })
    .returning({ id: brokers.id });
  otherBrokerId = other?.id ?? "";
});

afterAll(() => test.close());

/** Mismo `sortOrder` que la global, para que el orden lo decida el desempate (la global primero). */
const dormitoriosOrder =
  REAL_ESTATE_FIELD_DEFINITIONS.find((def) => def.key === "dormitorios")?.sortOrder ?? 0;

const customField = (overrides: Partial<typeof fieldDefinitions.$inferInsert>) => ({
  category: "real_estate",
  key: "dormitorios",
  label: "Dormitorios",
  type: "number" as const,
  sourceColumn: "dormitorios",
  ...overrides,
});

describe("seed (PGlite)", () => {
  it("es idempotente: dos veces dejan 36 definiciones globales y un solo broker demo", async () => {
    const second = await seed(test.db);
    expect(second).toEqual({ brokerId: demoBrokerId, fieldDefinitions: 36 });
    const globals = await test.db.select().from(fieldDefinitions);
    expect(globals.filter((row) => row.brokerId === null)).toHaveLength(36);
    const demo = (await test.db.select().from(brokers)).filter((row) => row.slug === "demo");
    expect(demo).toHaveLength(1);
  });

  it("guarda las opciones de los enum como arreglo jsonb", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: "real_estate", brokerId: null });
    expect(defs.find((def) => def.key === "moneda")?.options).toEqual(["UF", "CLP"]);
  });
});

describe("único (broker_id, category, key) NULLS NOT DISTINCT (PGlite)", () => {
  it("rechaza una segunda definición global con el mismo key", async () => {
    const error = await test.db
      .insert(fieldDefinitions)
      .values(customField({}))
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(sqlStateOf(error)).toBe("23505");
  });

  it("acepta una definición del corredor con el mismo key que una global", async () => {
    await test.db
      .insert(fieldDefinitions)
      .values(customField({ brokerId: demoBrokerId, required: true, sortOrder: dormitoriosOrder }));
    const count = (await test.db.select().from(fieldDefinitions)).filter(
      (row) => row.key === "dormitorios",
    );
    expect(count).toHaveLength(2);
  });
});

describe("createFieldDefinitionRepository (PGlite)", () => {
  beforeAll(async () => {
    await test.db
      .insert(fieldDefinitions)
      .values([
        customField({ key: "vista", sourceColumn: "vista", brokerId: otherBrokerId }),
        customField({ key: "antiguo", sourceColumn: "antiguo", active: false }),
        customField({ key: "color", sourceColumn: "color", category: "product" }),
      ]);
  });

  it("sin corredor devuelve solo las globales activas de la categoría, en el orden del seed", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: "real_estate", brokerId: null });
    expect(defs.map((def) => def.key)).toEqual(REAL_ESTATE_FIELD_DEFINITIONS.map((def) => def.key));
  });

  it("con corredor suma las suyas (la global primero si el key se repite) y no las de otro", async () => {
    const repo = createFieldDefinitionRepository(test.db);
    const defs = await repo.list({ category: "real_estate", brokerId: demoBrokerId });
    expect(defs).toHaveLength(37);
    const dorms = defs.filter((def) => def.key === "dormitorios");
    expect(dorms.map((def) => def.brokerId)).toEqual([null, demoBrokerId]);
    expect(defs.some((def) => def.key === "vista" || def.key === "antiguo")).toBe(false);
  });

  it("traduce un fallo de conexión a DB_UNAVAILABLE", async () => {
    // PGlite no tiene red: se simula el error que da node-postgres con Neon caído.
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
