import { type AbortSignalLike, isAppError, type JobQueue } from "@agentsales/core";
import { findPgTool, readBackupStatus, runBackup } from "@agentsales/db/backup";
import { defineJob, type Job, type JobSchedule, type QueuePolicy } from "./define.js";

/**
 * Clave fija de `db.backup`: con la cola `exclusive`, el del arranque y el del cron nunca corren a
 * la vez ni se acumulan (spec F6 §4.11).
 */
export const DB_BACKUP_KEY = "db.backup";

/** Política de `db.backup` (spec F6 §4.14): `exclusive`, 1 reintento desde 5 min y 15 min de vida. */
export const DB_BACKUP_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 5 * 60,
  retryBackoff: false,
  expireInSeconds: 15 * 60,
};

/**
 * Una vez al día a las 13:00 de Chile (el worker corre con `pnpm dev`, en horas de trabajo). El cron
 * perdido con el worker apagado no se repite: lo cubre el del arranque.
 */
export const DB_BACKUP_SCHEDULE: JobSchedule<"db.backup"> = {
  cron: "0 13 * * *",
  tz: "America/Santiago",
  data: {},
  singletonKey: DB_BACKUP_KEY,
};

/** Al arrancar se respalda si el último bueno tiene más de esto (o no hay ninguno). */
export const DB_BACKUP_STARTUP_AFTER_MS = 20 * 60 * 60 * 1000;

export type DbBackupJobDeps = {
  /** La carpeta ya resuelta (`resolveBackupDir`). */
  dir: string;
  databaseUrl: string;
  binDir?: string;
  /** Se dispara al apagar el worker: corta `pg_dump`. */
  signal: AbortSignalLike;
  run?: Parameters<typeof runBackup>[0]["run"];
  findTool?: typeof findPgTool;
  now?: () => Date;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `db.backup`: corre `runBackup` y registra el archivo, su tamaño y cuántos viejos se borraron.
 * Un error lleva solo su código (el mensaje trae la salida de `pg_dump`, ya redactada, que puede
 * nombrar el host). `BACKUP_FAILED` se reintenta una vez; `BACKUP_TOOL_NOT_INSTALLED`, no.
 */
export function dbBackupJob(deps: DbBackupJobDeps): Job {
  return defineJob({
    name: "db.backup",
    queue: DB_BACKUP_QUEUE,
    schedule: DB_BACKUP_SCHEDULE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async (_data, { logger }) => {
      const result = await runBackup({
        dir: deps.dir,
        databaseUrl: deps.databaseUrl,
        signal: deps.signal,
        ...(deps.binDir === undefined ? {} : { binDir: deps.binDir }),
        ...(deps.run === undefined ? {} : { run: deps.run }),
        ...(deps.findTool === undefined ? {} : { findTool: deps.findTool }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      logger.info(
        { file: result.file, kb: Math.round(result.bytes / 1024), deleted: result.deleted.length },
        "respaldo de la base listo",
      );
      if (result.pruneFailed) {
        logger.warn(
          "no se pudieron borrar los respaldos viejos: se intenta en el próximo respaldo",
        );
      }
    },
  });
}

export type BackupStartupDecision = "enqueued" | "recent" | "tool_missing";

/**
 * Al arrancar: si el último respaldo bueno tiene más de 20 h (o no hay), encola uno. Sin `pg_dump`
 * no lo encola (fallaría en cada arranque): devuelve `tool_missing` y el worker lo avisa una vez.
 */
export async function requestBackupIfDue(
  queue: JobQueue,
  deps: Pick<DbBackupJobDeps, "dir" | "binDir" | "findTool" | "now">,
): Promise<BackupStartupDecision> {
  const now = (deps.now ?? (() => new Date()))();
  const status = await readBackupStatus(deps.dir);
  const last = status?.lastSuccessAt == null ? null : Date.parse(status.lastSuccessAt);
  if (last !== null && now.getTime() - last <= DB_BACKUP_STARTUP_AFTER_MS) return "recent";
  try {
    (deps.findTool ?? findPgTool)(
      "pg_dump",
      deps.binDir === undefined ? {} : { binDir: deps.binDir },
    );
  } catch {
    return "tool_missing";
  }
  await queue.enqueue("db.backup", {}, { singletonKey: DB_BACKUP_KEY });
  return "enqueued";
}
