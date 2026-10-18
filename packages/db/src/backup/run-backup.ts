import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { type BackupStatusStore, fileBackupStatusStore } from "./status.js";
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
/**
 * Un `.partial` más viejo que esto es de un corte y se borra; uno más nuevo puede ser de otro
 * respaldo en curso (`pnpm db:backup` mientras corre el job), y no se toca.
 */
const STALE_PARTIAL_MS = 30 * 60 * 1000;

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
  /** Dónde se guarda el estado; por defecto, `estado-respaldo.json` en `dir` (F6). */
  status?: BackupStatusStore;
  /**
   * Qué se hace con el volcado ya comprobado (F8-T13): el worker lo sube a R2 y deja los últimos 14
   * allá. Con él, `dir` es una carpeta temporal y no se borran respaldos en ella. Si lanza, el
   * respaldo cuenta como fallido (el estado anota su código).
   */
  deliver?: BackupDelivery;
};

/** Lo que entrega `deliver`: los respaldos viejos que borró y si no pudo borrarlos. */
export type BackupDelivery = (backup: {
  /** La ruta del volcado comprobado (`<dir>/<file>`). */
  path: string;
  file: string;
  bytes: number;
}) => Promise<{ deleted: string[]; pruneFailed: boolean }>;

export type BackupResult = {
  /** El archivo nuevo (`agentsales-AAAAMMDD-HHMM.dump`), sin la carpeta. */
  file: string;
  bytes: number;
  /** Los respaldos viejos que se borraron (más de 14). */
  deleted: string[];
  /** Si no se pudieron borrar los viejos: el respaldo nuevo vale igual (se reintenta la próxima vez). */
  pruneFailed: boolean;
};

/**
 * `agentsales-AAAAMMDD-HHMM.dump` en hora de Chile. En la hora que se repite al volver al horario
 * de invierno, dos respaldos pueden tener el mismo nombre: el segundo reemplaza al primero.
 */
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
 * 4. lo renombra a `.dump`, borra los más viejos (deja 14) y guarda el estado. Con `deliver`
 *    (F8-T13), en vez de borrar los viejos de la carpeta se lo entrega (lo sube a R2) y recién
 *    después guarda el estado bueno: un volcado que no se lee nunca llega a `deliver`.
 * Una falla deja el estado con su código (sin borrar nada bueno) y lanza `BACKUP_FAILED`
 * (reintentable) o `BACKUP_TOOL_NOT_INSTALLED`. El mensaje lleva la salida de `pg_dump` redactada
 * (también la contraseña suelta). Un corte por apagado (`signal`) lanza `BACKUP_ABORTED`
 * (reintentable) sin anotarlo como falla.
 */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const store = deps.status ?? fileBackupStatusStore(deps.dir);
  if (deps.signal?.aborted) throw aborted();
  let release: () => Promise<void>;
  try {
    release = await acquireLock(deps.dir, now);
  } catch (caught) {
    // Otro respaldo en curso no es una falla: el estado no cambia.
    if (isAppError(caught) && caught.code === "BACKUP_IN_PROGRESS") throw caught;
    const error = backupError(caught);
    await recordFailure(deps.dir, store, await readPrevious(store), now, error.code);
    throw error;
  }
  try {
    return await backupLocked(deps, store, now);
  } finally {
    await release();
  }
}

/** El estado anterior; `undefined` si no se pudo leer (entonces una falla no se anota). */
const readPrevious = (store: BackupStatusStore): Promise<BackupStatus | null | undefined> =>
  store.read().catch(() => undefined);

/** El candado de la carpeta: un respaldo a la vez (`pnpm db:backup` no pasa por la cola). */
export const BACKUP_LOCK_FILE = "respaldo.lock";
/** Un candado más viejo que la vida del job es de un proceso que murió: se toma. */
const STALE_LOCK_MS = 15 * 60 * 1000;

/**
 * Toma el candado (`respaldo.lock`, creado con `wx`: solo uno lo crea). Si otro lo tiene desde hace
 * menos de 15 min, `BACKUP_IN_PROGRESS` (reintentable); uno más viejo o ilegible se reemplaza.
 * Devuelve cómo soltarlo.
 */
async function acquireLock(dir: string, now: Date): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, BACKUP_LOCK_FILE);
  const content = `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    const startedAt = await readFile(path, "utf8")
      .then((text) => Date.parse((JSON.parse(text) as { startedAt?: string }).startedAt ?? ""))
      .catch(() => Number.NaN);
    if (!Number.isNaN(startedAt) && now.getTime() - startedAt < STALE_LOCK_MS) break;
    await rm(path, { force: true });
  }
  throw new AppError(
    "BACKUP_IN_PROGRESS",
    "Ya hay un respaldo en curso (el del worker o otro pnpm db:backup): espera a que termine",
    { retriable: true },
  );
}

async function backupLocked(
  deps: BackupDeps,
  store: BackupStatusStore,
  now: Date,
): Promise<BackupResult> {
  const previous = await readPrevious(store);
  try {
    if (deps.signal?.aborted) throw aborted();
    const result = await dumpAndCheck(deps, now);
    await store.write({
      lastSuccessAt: now.toISOString(),
      lastFile: result.file,
      lastFailureAt: null,
      lastFailureCode: null,
    });
    return result;
  } catch (caught) {
    if (deps.signal?.aborted) throw aborted();
    const error = backupError(caught);
    await recordFailure(deps.dir, store, previous, now, error.code);
    throw error;
  }
}

const aborted = () =>
  new AppError("BACKUP_ABORTED", "El respaldo se cortó porque el worker se está apagando", {
    retriable: true,
  });

/** La conexión de `pg_dump`; una `DATABASE_URL` ilegible es un error propio, sin la URL. */
function connectionOf(databaseUrl: string): Record<string, string> {
  try {
    return pgEnvFromUrl(databaseUrl);
  } catch {
    throw new AppError("BACKUP_FAILED", "DATABASE_URL no es una URL válida: revisa .env");
  }
}

async function dumpAndCheck(deps: BackupDeps, now: Date): Promise<BackupResult> {
  const findTool = deps.findTool ?? findPgTool;
  const toolOptions = deps.binDir === undefined ? {} : { binDir: deps.binDir };
  const pgDump = findTool("pg_dump", toolOptions);
  const pgRestore = findTool("pg_restore", toolOptions);
  const run = deps.run ?? spawnProcess;
  const connection = connectionOf(deps.databaseUrl);

  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  await chmod(deps.dir, 0o700);
  for (const name of await readdir(deps.dir)) {
    if (!PARTIAL_FILE.test(name)) continue;
    const partialPath = join(deps.dir, name);
    const { mtimeMs } = await stat(partialPath);
    if (now.getTime() - mtimeMs > STALE_PARTIAL_MS) await rm(partialPath, { force: true });
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
        env: childEnv(connection, deps.processEnv),
        timeoutMs: BACKUP_DUMP_TIMEOUT_MS,
        ...signal,
      },
    );
    requireSuccess(dumped, "pg_dump", connection.PGPASSWORD);
    const listed = await run(pgRestore, ["--list", partial], {
      env: childEnv({}, deps.processEnv),
      timeoutMs: BACKUP_CHECK_TIMEOUT_MS,
      ...signal,
    });
    requireSuccess(listed, "pg_restore --list", connection.PGPASSWORD);
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
  // Lo sube quien lo pidió (F8-T13); si la subida falla, el respaldo no vale.
  if (deps.deliver !== undefined) {
    return { file, bytes: size, ...(await deps.deliver({ path, file, bytes: size })) };
  }
  // El respaldo nuevo ya está bien: no poder borrar los viejos no lo invalida.
  try {
    return { file, bytes: size, deleted: await prune(deps.dir), pruneFailed: false };
  } catch {
    return { file, bytes: size, deleted: [], pruneFailed: true };
  }
}

/** Borra los respaldos más viejos (por nombre: la fecha va en él) y deja los últimos 14. */
async function prune(dir: string): Promise<string[]> {
  const backups = (await readdir(dir)).filter((name) => BACKUP_FILE.test(name)).sort();
  const old = backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP));
  for (const name of old) await rm(join(dir, name), { force: true });
  return old;
}

function requireSuccess(result: ProcessResult, step: string, password: string | undefined): void {
  if (result.exitCode === 0) return;
  const redacted = redactText(result.stderr.trim());
  const output = (
    password === undefined || password === ""
      ? redacted
      : redacted.replaceAll(password, "[REDACTED]")
  ).slice(-ERROR_OUTPUT_CHARS);
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
  const syscall = (error as { syscall?: unknown } | null)?.syscall;
  // Node entrega `syscall: "spawn /ruta/pg_dump"`: la herramienta desapareció o su intérprete falta.
  if (code === "ENOENT" && typeof syscall === "string" && syscall.startsWith("spawn")) {
    return new AppError(
      "BACKUP_TOOL_NOT_INSTALLED",
      `No se pudo iniciar ${syscall.includes("pg_restore") ? "pg_restore" : "pg_dump"}: instala el cliente de Postgres (brew install libpq) o revisa PG_BIN_DIR`,
      { cause: error },
    );
  }
  return new AppError(
    "BACKUP_FAILED",
    `No se pudo escribir el respaldo${typeof code === "string" ? ` (${code})` : ""}: revisa la carpeta BACKUP_DIR y el espacio en disco`,
    { retriable: true, cause: error },
  );
}

/**
 * Anota la falla sin perder el último bueno; si tampoco se puede escribir, no tapa el error. Si el
 * estado anterior no se pudo leer (`undefined`), no se anota: se perdería el último bueno.
 */
async function recordFailure(
  dir: string,
  store: BackupStatusStore,
  previous: BackupStatus | null | undefined,
  now: Date,
  code: string,
): Promise<void> {
  if (previous === undefined) return;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await store.write({
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFile: previous?.lastFile ?? null,
      lastFailureAt: now.toISOString(),
      lastFailureCode: code,
    });
  } catch {
    // La carpeta (o R2) no se puede escribir: el error original ya lo dice.
  }
}
