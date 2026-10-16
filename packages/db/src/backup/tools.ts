import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { AppError } from "@agentsales/core";

/** Donde Homebrew deja `libpq` en Apple Silicon (keg-only: no queda en el PATH; nota `neon-backup.md`). */
export const DEFAULT_LIBPQ_BIN_DIR = "/opt/homebrew/opt/libpq/bin";

export type PgTool = "pg_dump" | "pg_restore";

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * La ruta de `pg_dump` o `pg_restore` (spec F6 §4.11): con `binDir` (`PG_BIN_DIR`), solo ahí; si
 * no, en el `PATH` y después en la carpeta de `libpq` de Homebrew. Si no está,
 * `BACKUP_TOOL_NOT_INSTALLED` (no reintentable) con cómo instalarlo.
 */
export function findPgTool(
  tool: PgTool,
  {
    binDir,
    pathEnv = process.env.PATH ?? "",
    isExecutable = isExecutableFile,
  }: { binDir?: string; pathEnv?: string; isExecutable?: (path: string) => boolean } = {},
): string {
  const candidates =
    binDir === undefined
      ? [
          ...pathEnv
            .split(delimiter)
            .filter((dir) => dir !== "")
            .map((dir) => join(dir, tool)),
          join(DEFAULT_LIBPQ_BIN_DIR, tool),
        ]
      : [join(binDir, tool)];
  const found = candidates.find((path) => isExecutable(path));
  if (found !== undefined) return found;
  throw new AppError(
    "BACKUP_TOOL_NOT_INSTALLED",
    binDir === undefined
      ? `No se encontró ${tool}: instala el cliente de Postgres (brew install libpq) o fija PG_BIN_DIR en .env`
      : `No se encontró ${tool} en PG_BIN_DIR: revisa la carpeta (con Homebrew, /opt/homebrew/opt/libpq/bin)`,
    { details: { tool } },
  );
}

/** Una versión de Postgres: mayor y menor (`null` si no la trae). */
export type PgVersion = { major: number; minor: number | null };

/** La versión de `pg_dump --version` (`pg_dump (PostgreSQL) 18.6 (Homebrew)`); `null` si no se lee. */
export function parsePgToolVersion(output: string): PgVersion | null {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(output);
  return match === null ? null : versionOf(match[1], match[2]);
}

/** La versión del servidor (`show server_version`: `18.6`, `17.5 (Debian…)`); `null` si no se lee. */
export function parseServerVersion(value: string): PgVersion | null {
  const match = /^\s*(\d+)(?:\.(\d+))?/.exec(value);
  return match === null ? null : versionOf(match[1], match[2]);
}

const versionOf = (major: string | undefined, minor: string | undefined): PgVersion => ({
  major: Number(major),
  minor: minor === undefined ? null : Number(minor),
});

/** `pg_dump` se niega a volcar un servidor de versión mayor más nueva que la suya. */
export const canDumpServer = (client: PgVersion, server: PgVersion): boolean =>
  client.major >= server.major;
