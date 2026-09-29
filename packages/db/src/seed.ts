import { AppError } from "@agentsales/core";
import type { Database } from "./client.js";
import { brokers } from "./schema.js";
import { DEMO_BROKER } from "./seed-data.js";

/**
 * Idempotente: correrlo de nuevo actualiza el corredor demo en vez de duplicarlo. Ojo: pisa
 * cualquier cambio hecho a mano en ese corredor (tono, colores, `auto_publish`).
 */
export async function seed(db: Database): Promise<{ brokerId: string }> {
  const { slug, ...rest } = DEMO_BROKER;
  const [row] = await db
    .insert(brokers)
    .values(DEMO_BROKER)
    .onConflictDoUpdate({ target: brokers.slug, set: rest })
    .returning({ id: brokers.id });
  if (!row) {
    throw new AppError("SEED_FAILED", `No se pudo sembrar el corredor ${slug}`);
  }
  return { brokerId: row.id };
}
