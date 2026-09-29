import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export type DbClient = {
  db: Database;
  /** Cierra el pool; llamarlo al terminar scripts y al apagar apps. */
  close: () => Promise<void>;
};

/** Neon suspende el cómputo tras 5 min sin uso: la primera conexión puede tardar unos segundos. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * pg trata hoy `sslmode=require` como `verify-full`, pero en su próxima versión mayor pasará a
 * la semántica de libpq (cifra sin verificar el certificado). Se fija `verify-full` explícito
 * para mantener la verificación; los certificados de Neon son de una CA pública.
 */
export function toPgConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.searchParams.get("sslmode") === "require") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

/** Crea el cliente con la conexión **directa** de Neon (sin `-pooler`; lo valida `loadEnv`). */
export function createDb(databaseUrl: string): DbClient {
  const pool = new pg.Pool({
    connectionString: toPgConnectionString(databaseUrl),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    max: 5,
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
