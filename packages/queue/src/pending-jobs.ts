import { QUEUE_SCHEMA } from "./boss.js";

/** Lo que `countPendingJobs` necesita de pg-boss (`boss.getDb()` lo cumple). */
export type QueueSql = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

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
