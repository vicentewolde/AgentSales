import type { JobName } from "@agentsales/core";
import { QUEUE_SCHEMA } from "./boss.js";

/** Lo que `countPendingJobs` necesita de pg-boss (`boss.getDb()` lo cumple). */
export type QueueSql = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

/**
 * Los jobs de fondo que no cuentan como trabajo (F9.5-T24, ADR-0037; ADR-0044): `publication.due`
 * corre cada minuto aunque no haya nada (lo programado que vence se mira aparte) y
 * `publications.watch` cada hora (es vigilancia, y el arranque del worker ya hace lo mismo). Ni el
 * worker se queda encendido por ellos ni la API lo enciende por ellos.
 */
export const BACKGROUND_JOBS: readonly JobName[] = ["publication.due", "publications.watch"];

/** El prefijo de las colas internas de pg-boss (por ejemplo `__pgboss__send-it`, del cron). */
export const PGBOSS_INTERNAL_PREFIX = "__pgboss__";

/**
 * Cuenta en la tabla de pg-boss (12.35: `job`, con `name`, `state` y `start_after`) los jobs activos
 * y los que esperan (`created` o `retry`) y empiezan dentro de `withinMs`, sin los de `ignore` ni
 * los internos de pg-boss (F9.5-T24: el worker se apaga solo cuando no queda ninguno). Un job que
 * espera más allá del margen (un reintento con espera larga) no cuenta: corre al próximo encendido.
 */
export async function countPendingJobs(
  db: QueueSql,
  { withinMs, ignore }: { withinMs: number; ignore: readonly string[] },
  schema: string = QUEUE_SCHEMA,
): Promise<number> {
  const result = await db.executeSql(
    `select count(*)::int as count from ${schema}.job
      where not starts_with(name, $1)
        and name <> all($2::text[])
        and (state = 'active'
          or (state in ('created', 'retry') and start_after <= now() + make_interval(secs => $3)))`,
    [PGBOSS_INTERNAL_PREFIX, [...ignore], Math.ceil(withinMs / 1000)],
  );
  const row = result.rows[0] as { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Cuándo le toca al próximo job que no es de fondo (ADR-0044: la API enciende el worker detenido
 * para él): ya (`now()` de la base) si hay uno activo, si no el `start_after` más temprano de los que
 * esperan (`created` o `retry`); `null` sin ninguno. Sin los de `ignore` ni los internos de pg-boss.
 * Devuelve una sola fila, para cuidar la transferencia de Neon.
 */
export async function nextPendingJobAt(
  db: QueueSql,
  { ignore }: { ignore: readonly string[] },
  schema: string = QUEUE_SCHEMA,
): Promise<Date | null> {
  const result = await db.executeSql(
    `select min(case when state = 'active' then now() else start_after end) as next
       from ${schema}.job
      where not starts_with(name, $1)
        and name <> all($2::text[])
        and state in ('active', 'created', 'retry')`,
    [PGBOSS_INTERNAL_PREFIX, [...ignore]],
  );
  const value = (result.rows[0] as { next?: unknown } | undefined)?.next;
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
