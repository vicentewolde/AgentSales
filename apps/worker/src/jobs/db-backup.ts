import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AbortSignalLike,
  AppError,
  type BackupStatus,
  isAppError,
  type JobQueue,
  type MediaStorage,
} from "@agentsales/core";
import {
  BACKUP_KEEP,
  type BackupDelivery,
  type BackupStatusStore,
  findPgTool,
  readBackupStatus,
  runBackup,
} from "@agentsales/db/backup";
import { readStoredBackupStatus, writeStoredBackupStatus } from "@agentsales/storage";
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

/**
 * Dónde queda el respaldo (spec F8 §4.9, `BACKUP_TARGET`): en la carpeta (F6, el Mac) o en R2, con
 * el volcado en el bucket de respaldos (`backups`, su propio token) y el estado en el principal
 * (`status`, que la API lee).
 */
export type BackupTarget =
  | {
      kind: "local";
      /** La carpeta ya resuelta (`resolveBackupDir`). */
      dir: string;
    }
  | {
      kind: "r2";
      backups: MediaStorage;
      status: Pick<MediaStorage, "get" | "put">;
      /** Dónde se crea la carpeta temporal del volcado (por defecto, la del sistema). */
      tmpRoot?: string;
    };

/** Los volcados en el bucket de respaldos: `db/agentsales-AAAAMMDD-HHMM.dump`. */
export const BACKUP_OBJECT_PREFIX = "db/";
/** Solo estos objetos se cuentan y se borran: nunca otro del bucket. */
const BACKUP_OBJECT = /^db\/agentsales-\d{8}-\d{4}\.dump$/;

export type DbBackupJobDeps = {
  target: BackupTarget;
  databaseUrl: string;
  binDir?: string;
  /** Se dispara al apagar el worker: corta `pg_dump`. */
  signal: AbortSignalLike;
  run?: Parameters<typeof runBackup>[0]["run"];
  findTool?: typeof findPgTool;
  now?: () => Date;
  /** El sha256 de un archivo, en hexadecimal (los tests dan el suyo). */
  sha256File?: (path: string) => Promise<string>;
};

/** El sha256 de un archivo leyéndolo en streaming (un volcado puede pesar cientos de MB). */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** El estado del respaldo según dónde queda: el archivo de la carpeta o `system/` en R2. */
export function backupStatusOf(target: BackupTarget): () => Promise<BackupStatus | null> {
  return target.kind === "local"
    ? () => readBackupStatus(target.dir)
    : () => readStoredBackupStatus(target.status);
}

const storedStatusStore = (storage: Pick<MediaStorage, "get" | "put">): BackupStatusStore => ({
  read: () => readStoredBackupStatus(storage),
  write: (status) => writeStoredBackupStatus(storage, status),
});

/**
 * Sube el volcado comprobado al bucket de respaldos (spec F8 §4.9) con su sha256 (R2 rechaza un
 * contenido distinto), revisa que quedó con su tamaño y recién entonces borra los más viejos (deja
 * 14, solo objetos `db/agentsales-…dump`). No poder borrarlos no invalida el respaldo nuevo.
 */
export function uploadBackup(
  backups: MediaStorage,
  sha256File: (path: string) => Promise<string> = sha256OfFile,
): BackupDelivery {
  return async ({ path, file, bytes }) => {
    const key = `${BACKUP_OBJECT_PREFIX}${file}`;
    const sha256 = await sha256File(path);
    await backups.putStream(key, createReadStream(path), {
      contentType: "application/octet-stream",
      contentLength: bytes,
      sha256,
    });
    const stored = await backups.head(key);
    if (stored?.size !== bytes) {
      throw new AppError(
        "BACKUP_UPLOAD_FAILED",
        "El respaldo no quedó completo en el bucket de respaldos",
        { retriable: true },
      );
    }
    try {
      return { deleted: await pruneUploaded(backups), pruneFailed: false };
    } catch {
      return { deleted: [], pruneFailed: true };
    }
  };
}

/** Borra los volcados más viejos del bucket (por nombre: la fecha va en él) y deja los últimos 14. */
async function pruneUploaded(backups: MediaStorage): Promise<string[]> {
  const keys = (await backups.list(BACKUP_OBJECT_PREFIX))
    .map((object) => object.path)
    .filter((path) => BACKUP_OBJECT.test(path))
    .sort();
  const old = keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP));
  for (const key of old) await backups.delete(key);
  return old.map((key) => key.slice(BACKUP_OBJECT_PREFIX.length));
}

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `db.backup`: corre `runBackup` y registra el archivo, su tamaño, dónde quedó y cuántos viejos
 * se borraron. Con R2 (F8-T13) vuelca a una carpeta temporal que se borra al terminar, lo sube con
 * `uploadBackup` y guarda el estado en `system/` del bucket principal. Un error lleva solo su código
 * (el mensaje trae la salida de `pg_dump`, ya redactada, que puede nombrar el host).
 * `BACKUP_FAILED` y un R2 caído se reintentan una vez; `BACKUP_TOOL_NOT_INSTALLED`, no.
 */
export function dbBackupJob(deps: DbBackupJobDeps): Job {
  return defineJob({
    name: "db.backup",
    queue: DB_BACKUP_QUEUE,
    schedule: DB_BACKUP_SCHEDULE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async (_data, { logger }) => {
      const common = {
        databaseUrl: deps.databaseUrl,
        signal: deps.signal,
        ...(deps.binDir === undefined ? {} : { binDir: deps.binDir }),
        ...(deps.run === undefined ? {} : { run: deps.run }),
        ...(deps.findTool === undefined ? {} : { findTool: deps.findTool }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      };
      const { target } = deps;
      let result: Awaited<ReturnType<typeof runBackup>>;
      if (target.kind === "local") {
        result = await runBackup({ ...common, dir: target.dir });
      } else {
        // `mkdtemp` la crea con `0700`; el volcado trae datos de clientes y se borra siempre.
        const dir = await mkdtemp(join(target.tmpRoot ?? tmpdir(), "agentsales-backup-"));
        try {
          result = await runBackup({
            ...common,
            dir,
            status: storedStatusStore(target.status),
            deliver: uploadBackup(target.backups, deps.sha256File),
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      logger.info(
        {
          file: result.file,
          kb: Math.round(result.bytes / 1024),
          target: target.kind,
          deleted: result.deleted.length,
        },
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
  deps: Pick<DbBackupJobDeps, "binDir" | "findTool" | "now"> & {
    /** El estado del último respaldo (`backupStatusOf`); si lanza (R2 caído), no se encola. */
    readStatus: () => Promise<BackupStatus | null>;
  },
): Promise<BackupStartupDecision> {
  const now = (deps.now ?? (() => new Date()))();
  const status = await deps.readStatus();
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
