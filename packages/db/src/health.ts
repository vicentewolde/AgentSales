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
