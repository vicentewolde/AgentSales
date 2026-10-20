import { AppError } from "@agentsales/core";
import { inArray, type SQL, sql } from "drizzle-orm";
import type { SchemaDatabase } from "./client.js";
import { brokers, editorialProfiles, fieldDefinitions } from "./schema.js";
import { DEMO_BROKER, OPERATOR_BRANDS, REAL_ESTATE_FIELD_DEFINITIONS } from "./seed-data.js";

/** `excluded.<columna>` de un upsert: el valor que se intentó insertar. */
const excluded = (column: { name: string }): SQL => sql.raw(`excluded."${column.name}"`);

export type SeedResult = { brokerId: string; fieldDefinitions: number };

export type SeedOptions = {
  /**
   * También las marcas del operador (`pnpm db:seed --operator-brands`). Nunca por defecto: con dos
   * instancias del mismo código (spec F9, D19), la de clientes no lleva las marcas del operador.
   */
  operatorBrands?: boolean;
};

/**
 * Idempotente: correrlo de nuevo actualiza en vez de duplicar. Ojo: pisa cualquier cambio hecho a
 * mano en el corredor demo (tono, colores, `auto_publish`) y en las definiciones **globales** de
 * `real_estate`. Para personalizar un campo, se crea una definición del corredor.
 */
export async function seed(db: SchemaDatabase, options: SeedOptions = {}): Promise<SeedResult> {
  const { slug, ...rest } = DEMO_BROKER;
  const [row] = await db
    .insert(brokers)
    .values(DEMO_BROKER)
    .onConflictDoUpdate({ target: brokers.slug, set: rest })
    .returning({ id: brokers.id });
  if (!row) {
    throw new AppError("SEED_FAILED", `No se pudo sembrar el corredor ${slug}`);
  }

  // Destino: el único NULLS NOT DISTINCT (broker_id, category, key) de la migración 0001.
  const defs = await db
    .insert(fieldDefinitions)
    .values(REAL_ESTATE_FIELD_DEFINITIONS)
    .onConflictDoUpdate({
      target: [fieldDefinitions.brokerId, fieldDefinitions.category, fieldDefinitions.key],
      set: {
        label: excluded(fieldDefinitions.label),
        type: excluded(fieldDefinitions.type),
        required: excluded(fieldDefinitions.required),
        options: excluded(fieldDefinitions.options),
        sourceColumn: excluded(fieldDefinitions.sourceColumn),
        isCore: excluded(fieldDefinitions.isCore),
        minValue: excluded(fieldDefinitions.minValue),
        maxValue: excluded(fieldDefinitions.maxValue),
        sortOrder: excluded(fieldDefinitions.sortOrder),
        active: excluded(fieldDefinitions.active),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: fieldDefinitions.id });

  if (options.operatorBrands === true) await seedOperatorBrands(db);

  return { brokerId: row.id, fieldDefinitions: defs.length };
}

/**
 * Las marcas del operador y sus perfiles editoriales vacíos (spec F9 §4.11). A diferencia del
 * corredor demo, **no pisa** lo que ya existe: el operador edita la marca y llena su perfil, y
 * correrlo de nuevo no lo borra (`ON CONFLICT DO NOTHING`). Devuelve los id por slug.
 */
export async function seedOperatorBrands(db: SchemaDatabase): Promise<Record<string, string>> {
  await db
    .insert(brokers)
    .values([...OPERATOR_BRANDS])
    .onConflictDoNothing({ target: brokers.slug });
  const slugs = OPERATOR_BRANDS.map((brand) => brand.slug);
  const rows = await db
    .select({ id: brokers.id, slug: brokers.slug })
    .from(brokers)
    .where(inArray(brokers.slug, slugs));
  if (rows.length !== slugs.length) {
    throw new AppError("SEED_FAILED", "No se pudieron sembrar las marcas del operador");
  }
  await db
    .insert(editorialProfiles)
    .values(rows.map((brand) => ({ brokerId: brand.id })))
    .onConflictDoNothing({ target: editorialProfiles.brokerId });
  return Object.fromEntries(rows.map((brand) => [brand.slug, brand.id]));
}
