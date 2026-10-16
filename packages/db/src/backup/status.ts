import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BackupStatus, backupStatusSchema } from "@agentsales/core";

/** El archivo del estado del último respaldo, en la carpeta de los respaldos (sin tabla). */
export const BACKUP_STATUS_FILE = "estado-respaldo.json";

/**
 * Lee el estado del último respaldo; `null` si no hay (nunca se respaldó) o no se puede leer (un
 * archivo roto no rompe `/health`: cuenta como sin respaldo).
 */
export async function readBackupStatus(dir: string): Promise<BackupStatus | null> {
  let text: string;
  try {
    text = await readFile(join(dir, BACKUP_STATUS_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = backupStatusSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Escribe el estado de una vez (un temporal que se renombra), con permisos `0600`. */
export async function writeBackupStatus(dir: string, status: BackupStatus): Promise<void> {
  const path = join(dir, BACKUP_STATUS_FILE);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
