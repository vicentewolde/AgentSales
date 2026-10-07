import { PGlite } from "@electric-sql/pglite";
import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SchemaDatabase } from "../src/client.js";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import * as schema from "../src/schema.js";

export type TestDatabase = { db: SchemaDatabase; close: () => Promise<void> };

/**
 * Postgres en memoria (PGlite, WASM) con todas las migraciones de `packages/db/drizzle` aplicadas.
 * Sin red ni Neon: prueba los repositorios y las restricciones reales (spec F1, D4).
 */
export async function createTestDatabase(options: { logger?: Logger } = {}): Promise<TestDatabase> {
  const client = new PGlite();
  // El logger (opcional) deja ver el SQL que manda un repositorio (por ejemplo, el del candado).
  const db = drizzle(client, { schema, ...(options.logger ? { logger: options.logger } : {}) });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => client.close() };
}
