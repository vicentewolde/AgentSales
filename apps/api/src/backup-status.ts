import type { BackupStatus, MediaStorage } from "@agentsales/core";
import { readBackupStatus } from "@agentsales/db/backup";
import { readStoredBackupStatus } from "@agentsales/storage";

/** Cuánto vale una lectura del estado en R2 (spec F8 §4.9): `/health` no va a R2 en cada consulta. */
export const BACKUP_STATUS_CACHE_MS = 60_000;

/**
 * Guarda el último resultado de `read` por `ttlMs`. Dos consultas a la vez esperan la misma lectura;
 * una lectura que falla no se guarda (la siguiente vuelve a intentar).
 */
export function cachedFor<T>(
  read: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { value: T; at: number } | null = null;
  let pending: Promise<T> | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    pending ??= read()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/**
 * El estado del respaldo para `/health` y la agenda: con `BACKUP_TARGET=r2`, `system/` del bucket
 * principal (con la caché de 1 min); si no, el archivo de la carpeta (F6). La API nunca abre el
 * bucket de respaldos: no tiene su token (`withoutBackupCredentials`).
 */
export function backupStatusReader(
  options:
    | { target: "local"; dir: string }
    | { target: "r2"; storage: Pick<MediaStorage, "get">; now?: () => number },
): () => Promise<BackupStatus | null> {
  if (options.target === "local") return () => readBackupStatus(options.dir);
  return cachedFor(
    () => readStoredBackupStatus(options.storage),
    BACKUP_STATUS_CACHE_MS,
    options.now,
  );
}
