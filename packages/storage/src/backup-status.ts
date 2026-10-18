import {
  type BackupStatus,
  backupStatusSchema,
  isAppError,
  type MediaStorage,
} from "@agentsales/core";

/**
 * Dónde queda el estado del respaldo cuando va a R2 (spec F8 §4.9): en el bucket principal, que la
 * API ya lee (el de respaldos solo lo abre el worker). El mismo esquema que el archivo de F6. Aquí y
 * no en `packages/db/backup`, para que `db` no dependa del almacenamiento.
 */
export const BACKUP_STATUS_PATH = "system/estado-respaldo.json";

/**
 * Lee el estado del respaldo del almacenamiento; `null` si no hay (nunca se respaldó) o no se lee
 * (un archivo roto cuenta como sin respaldo, como en F6). Un error del almacenamiento (R2 caído)
 * se lanza: quien lee decide (`/health` lo informa como sin dato, el respaldo no pisa el estado).
 */
export async function readStoredBackupStatus(
  storage: Pick<MediaStorage, "get">,
): Promise<BackupStatus | null> {
  let bytes: Uint8Array;
  try {
    bytes = await storage.get(BACKUP_STATUS_PATH);
  } catch (error) {
    if (isAppError(error) && error.code === "STORAGE_NOT_FOUND") return null;
    throw error;
  }
  try {
    const parsed = backupStatusSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Guarda el estado del respaldo en el almacenamiento (un `put` reemplaza el anterior entero). */
export async function writeStoredBackupStatus(
  storage: Pick<MediaStorage, "put">,
  status: BackupStatus,
): Promise<void> {
  await storage.put(
    BACKUP_STATUS_PATH,
    Buffer.from(`${JSON.stringify(status, null, 2)}\n`, "utf8"),
    "application/json",
  );
}
