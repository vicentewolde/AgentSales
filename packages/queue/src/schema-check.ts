import { AppError } from "@agentsales/core";
import { type SQL, sql } from "drizzle-orm";
import { QUEUE_SCHEMA } from "./boss.js";

/** Consulta con filas; el `Database` de `@agentsales/db` lo cumple. */
export type Queryable = { execute(query: SQL): PromiseLike<{ rows: unknown[] }> };

/**
 * Check de la cola para `/health`: solo lee el catálogo, no arranca pg-boss (arrancarlo en la API
 * activaría su mantenimiento y supervisión). Lanza `QUEUE_UNAVAILABLE` si falta el esquema.
 * `ok` significa que la cola se inicializó alguna vez, **no** que el worker esté corriendo.
 */
export async function checkQueueSchema(
  db: Queryable,
  schema: string = QUEUE_SCHEMA,
): Promise<void> {
  const result = await db.execute(
    // pg_namespace ve todos los esquemas; information_schema solo los que el rol puede usar.
    sql`select 1 from pg_catalog.pg_namespace where nspname = ${schema}`,
  );
  if (result.rows.length === 0) {
    throw new AppError(
      "QUEUE_UNAVAILABLE",
      `No existe el esquema ${schema} de la cola: arranca el worker una vez (pnpm dev)`,
      { retriable: true },
    );
  }
}
