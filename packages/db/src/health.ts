import { AppError } from "@agentsales/core";
import { type SQL, sql } from "drizzle-orm";

/** Lo mínimo que necesita el ping; `Database` lo cumple. */
export type Pingable = { execute(query: SQL): PromiseLike<unknown> };

export type PingOptions = {
  /** Reintentos tras el primer fallo; Neon puede tardar en despertar (ADR-0007). */
  retries?: number;
  retryDelayMs?: number;
};

/**
 * Comprueba que la base responde (`select 1`). Cada intento está acotado por el timeout de
 * conexión del pool (10 s); si todos fallan, lanza el error del último intento.
 */
export async function pingDatabase(
  db: Pingable,
  { retries = 1, retryDelayMs = 500 }: PingOptions = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/** Consulta con filas; `Database` lo cumple. */
export type Queryable = { execute(query: SQL): PromiseLike<{ rows: unknown[] }> };

/** Esquema que crea pg-boss al arrancar el worker (ADR-0005). */
export const QUEUE_SCHEMA = "pgboss";

/**
 * Check de la cola para `/health`: solo lee el catálogo, no arranca pg-boss (arrancarlo en la API
 * activaría su mantenimiento y supervisión). Lanza `QUEUE_NOT_INITIALIZED` si falta el esquema.
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
      "QUEUE_NOT_INITIALIZED",
      `No existe el esquema ${schema} de la cola: arranca el worker una vez (pnpm dev)`,
    );
  }
}
