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

/**
 * La versión de Postgres del servidor (`show server_version`, por ejemplo `18.6`), con los mismos
 * reintentos que el ping: sirve también de ping en `/health` (spec F6 §4.11). `doctor` la compara
 * con la de `pg_dump`.
 */
export async function readServerVersion(
  db: Pingable,
  { retries = 1, retryDelayMs = 500 }: PingOptions = {},
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = (await db.execute(sql`show server_version`)) as {
        rows?: Array<Record<string, unknown>>;
      };
      const value = result.rows?.[0]?.server_version;
      return typeof value === "string" ? value.trim() : String(value);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
