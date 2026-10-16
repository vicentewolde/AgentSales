import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AbortSignalLike,
  AppError,
  type BackupStatus,
  isAppError,
  redactText,
} from "@agentsales/core";
import { childEnv, pgEnvFromUrl } from "./connection.js";
import { type ProcessResult, type ProcessRunner, spawnProcess } from "./runner.js";
import { readBackupStatus, writeBackupStatus } from "./status.js";
import { findPgTool } from "./tools.js";

// El respaldo local de la base (spec F6 §4.11, seguimiento de ADR-0007).

/** Cuántos respaldos se guardan: los más viejos se borran solo después de uno bueno. */
export const BACKUP_KEEP = 14;
/** Tope de `pg_dump` (el job `db.backup` vive 15 min). */
export const BACKUP_DUMP_TIMEOUT_MS = 10 * 60 * 1000;
/** Tope de `pg_restore --list` (solo lee el archivo). */
export const BACKUP_CHECK_TIMEOUT_MS = 2 * 60 * 1000;
/** Los respaldos se nombran en hora de Chile, la del operador. */
const BACKUP_TIME_ZONE = "America/Santiago";
/** Solo estos archivos se cuentan y se borran: nunca otro archivo de la carpeta. */
const BACKUP_FILE = /^agentsales-\d{8}-\d{4}\.dump$/;
const PARTIAL_FILE = /^agentsales-\d{8}-\d{4}\.dump\.partial$/;
/** Cuánto de la salida de `pg_dump` va al mensaje del error (ya redactado). */
const ERROR_OUTPUT_CHARS = 400;

export type BackupDeps = {
  /** La carpeta de los respaldos, ya resuelta (`resolveBackupDir`: absoluta y fuera del proyecto). */
  dir: string;
  /** `DATABASE_URL`: se pasa a `pg_dump` por variables de entorno, nunca en los argumentos. */
  databaseUrl: string;
  /** `PG_BIN_DIR`, si está. */
  binDir?: string;
  run?: ProcessRunner;
  /** Cómo se busca cada herramienta (los tests dan la suya). */
  findTool?: typeof findPgTool;
  now?: () => Date;
  signal?: AbortSignalLike;
  /** El entorno del que salen `PATH` y `HOME` para los procesos hijos. */
  processEnv?: Readonly<Record<string, string | undefined>>;
};

export type BackupResult = {
  /** El archivo nuevo (`agentsales-AAAAMMDD-HHMM.dump`), sin la carpeta. */
  file: string;
  bytes: number;
  /** Los respaldos viejos que se borraron (más de 14). */
  deleted: string[];
};

/** `agentsales-AAAAMMDD-HHMM.dump` en hora de Chile. */
export function backupFileName(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: BACKUP_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `agentsales-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.dump`;
}

/**
 * Hace un respaldo:
 * 1. crea la carpeta con permisos `0700` y borra los `.partial` que dejó un corte;
 * 2. `pg_dump -Fc --no-owner --no-acl --exclude-schema=pgboss` a `<nombre>.dump.partial` (`0600`),
 *    con la conexión por variables de entorno;
 * 3. `pg_restore --list` del archivo: si no se lee, se borra y no cuenta;
 * 4. lo renombra a `.dump`, borra los más viejos (deja 14) y guarda el estado.
 * Una falla deja el estado con su código (sin borrar nada bueno) y lanza `BACKUP_FAILED`
 * (reintentable) o `BACKUP_TOOL_NOT_INSTALLED`. El mensaje lleva la salida de `pg_dump` redactada.
 */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const previous = await readBackupStatus(deps.dir);
  try {
    const result = await dumpAndCheck(deps, now);
    await writeBackupStatus(deps.dir, {
      lastSuccessAt: now.toISOString(),
      lastFile: result.file,
      lastFailureAt: null,
      lastFailureCode: null,
    });
    return result;
  } catch (caught) {
    const error = backupError(caught);
    await recordFailure(deps.dir, previous, now, error.code);
    throw error;
  }
}

async function dumpAndCheck(deps: BackupDeps, now: Date): Promise<BackupResult> {
  const findTool = deps.findTool ?? findPgTool;
  const toolOptions = deps.binDir === undefined ? {} : { binDir: deps.binDir };
  const pgDump = findTool("pg_dump", toolOptions);
  const pgRestore = findTool("pg_restore", toolOptions);
  const run = deps.run ?? spawnProcess;

  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  await chmod(deps.dir, 0o700);
  for (const name of await readdir(deps.dir)) {
    if (PARTIAL_FILE.test(name)) await rm(join(deps.dir, name), { force: true });
  }

  const file = backupFileName(now);
  const path = join(deps.dir, file);
  const partial = `${path}.partial`;
  // Se crea vacío con `0600` antes de que `pg_dump` lo llene: nunca existe con otros permisos.
  await writeFile(partial, "", { mode: 0o600 });
  try {
    const signal = deps.signal === undefined ? {} : { signal: deps.signal };
    const dumped = await run(
      pgDump,
      ["-Fc", "--no-owner", "--no-acl", "--exclude-schema=pgboss", "-f", partial],
      {
        env: childEnv(pgEnvFromUrl(deps.databaseUrl), deps.processEnv),
        timeoutMs: BACKUP_DUMP_TIMEOUT_MS,
        ...signal,
      },
    );
    requireSuccess(dumped, "pg_dump");
    const listed = await run(pgRestore, ["--list", partial], {
      env: childEnv({}, deps.processEnv),
      timeoutMs: BACKUP_CHECK_TIMEOUT_MS,
      ...signal,
    });
    requireSuccess(listed, "pg_restore --list");
    if (listed.stdout.trim() === "") {
      throw new AppError("BACKUP_FAILED", "El respaldo quedó vacío: pg_restore no listó nada", {
        retriable: true,
      });
    }
    await chmod(partial, 0o600);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const { size } = await stat(path);
  return { file, bytes: size, deleted: await prune(deps.dir) };
}

/** Borra los respaldos más viejos (por nombre: la fecha va en él) y deja los últimos 14. */
async function prune(dir: string): Promise<string[]> {
  const backups = (await readdir(dir)).filter((name) => BACKUP_FILE.test(name)).sort();
  const old = backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP));
  for (const name of old) await rm(join(dir, name), { force: true });
  return old;
}

function requireSuccess(result: ProcessResult, step: string): void {
  if (result.exitCode === 0) return;
  const output = redactText(result.stderr.trim()).slice(-ERROR_OUTPUT_CHARS);
  throw new AppError(
    "BACKUP_FAILED",
    `${step} terminó con ${result.exitCode === null ? "corte" : `código ${result.exitCode}`}${output === "" ? "" : `: ${output}`}`,
    { retriable: true },
  );
}

/** Un error del respaldo: los nuestros tal cual; uno de Node (disco, permisos) como `BACKUP_FAILED`. */
function backupError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" && (error as { syscall?: unknown }).syscall === "spawn") {
    return new AppError("BACKUP_TOOL_NOT_INSTALLED", "No se pudo iniciar pg_dump o pg_restore", {
      cause: error,
    });
  }
  return new AppError(
    "BACKUP_FAILED",
    `No se pudo escribir el respaldo${typeof code === "string" ? ` (${code})` : ""}: revisa la carpeta BACKUP_DIR y el espacio en disco`,
    { retriable: true, cause: error },
  );
}

/** Anota la falla sin perder el último bueno; si tampoco se puede escribir, no tapa el error. */
async function recordFailure(
  dir: string,
  previous: BackupStatus | null,
  now: Date,
  code: string,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeBackupStatus(dir, {
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFile: previous?.lastFile ?? null,
      lastFailureAt: now.toISOString(),
      lastFailureCode: code,
    });
  } catch {
    // La carpeta no se puede escribir: el error original ya lo dice.
  }
}
