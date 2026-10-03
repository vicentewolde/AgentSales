import { AppError } from "@agentsales/core";
import { type SQL, sql } from "drizzle-orm";
import type { SchemaDatabase } from "./client.js";
import { brokers, fieldDefinitions } from "./schema.js";
import { DEMO_BROKER, REAL_ESTATE_FIELD_DEFINITIONS } from "./seed-data.js";

/** `excluded.<columna>` de un upsert: el valor que se intentó insertar. */
const excluded = (column: { name: string }): SQL => sql.raw(`excluded."${column.name}"`);

export type SeedResult = { brokerId: string; fieldDefinitions: number };

/**
 * Idempotente: correrlo de nuevo actualiza en vez de duplicar. Ojo: pisa cualquier cambio hecho a
 * mano en el corredor demo (tono, colores, `auto_publish`) y en las definiciones **globales** de
 * `real_estate`. Para personalizar un campo, se crea una definición del corredor.
 */
export async function seed(db: SchemaDatabase): Promise<SeedResult> {
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

  return { brokerId: row.id, fieldDefinitions: defs.length };
}
