import { PGlite } from "@electric-sql/pglite";
import { getConstructionPlans } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUEUE_SCHEMA } from "./boss.js";
import { countPendingJobs, type QueueSql } from "./pending-jobs.js";

// F9.5-T24 (ADR-0037): la consulta corre contra el esquema real de pg-boss 12.35 (el que crea
// `getConstructionPlans`), en PGlite.

const MINUTE = 60_000;
const IGNORE = ["publication.due", "publications.watch"];
const QUEUES = [
  ...IGNORE,
  "__pgboss__send-it",
  "publication.publish",
  "content.prepare",
  "post.draft",
  "import.run",
  "post.media",
  "content.plan",
];

describe("countPendingJobs (PGlite con el esquema de pg-boss)", () => {
  let pg: PGlite;
  let db: QueueSql;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(getConstructionPlans(QUEUE_SCHEMA));
    db = { executeSql: async (text, values) => pg.query(text, values) };
    // Las colas (la tabla `job` exige la suya); sin partición propia, van a `job_common`.
    for (const name of QUEUES) {
      await pg.query(
        `insert into ${QUEUE_SCHEMA}.queue (name, policy, retry_limit, retry_delay, retry_backoff,
          expire_seconds, retention_seconds, deletion_seconds, partition, table_name)
          values ($1, 'standard', 0, 0, false, 60, 60, 60, false, 'job_common')`,
        [name],
      );
    }
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec(`delete from ${QUEUE_SCHEMA}.job`);
  });

  /** Un job en ese estado que empieza en `minutes` (negativo: ya pudo empezar). */
  const job = (name: string, state: string, minutes = 0) =>
    pg.query(
      `insert into ${QUEUE_SCHEMA}.job (name, state, start_after)
        values ($1, $2::${QUEUE_SCHEMA}.job_state, now() + make_interval(mins => $3))`,
      [name, state, minutes],
    );

  const count = (withinMinutes = 70) =>
    countPendingJobs(db, { withinMs: withinMinutes * MINUTE, ignore: IGNORE });

  it("sin jobs, 0", async () => {
    expect(await count()).toBe(0);
  });

  it("cuenta los activos y los que esperan y empiezan dentro del margen", async () => {
    await job("publication.publish", "active");
    await job("content.prepare", "created", 5);
    await job("post.draft", "retry", 60);
    expect(await count()).toBe(3);
  });

  it("no cuenta lo que empieza después del margen, ni lo terminado, fallido o cancelado", async () => {
    await job("publication.publish", "retry", 120);
    await job("import.run", "completed", -5);
    await job("post.media", "failed", -5);
    await job("content.plan", "cancelled", -5);
    expect(await count()).toBe(0);
    expect(await count(150)).toBe(1);
  });

  it("no cuenta los internos de pg-boss (el cron de cada minuto) ni los ignorados", async () => {
    await job("__pgboss__send-it", "created");
    await job("__pgboss__send-it", "active");
    await job("publication.due", "active");
    await job("publications.watch", "created");
    expect(await count()).toBe(0);
  });
});
