import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Los temporales de más de esto se borran al arrancar (spec F2 §4.4). */
export const CONTENT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Solo directorios con nombre de uuid: nada que no haya creado el worker. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/** La evidencia de Marketplace se borra a los 7 días (spec F5 §4.5): trae datos personales. */
export const MARKETPLACE_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `<workspace>/tmp/marketplace`: la evidencia de cada formulario, por publicación (spec F5 §4.4). */
export const marketplaceTmpRootOf = (workspaceRoot: string) =>
  join(workspaceRoot, "tmp", "marketplace");

/** `<workspace>/tmp/content`: los temporales de las corridas de contenido (spec F2 §4.4). */
export const contentTmpRootOf = (workspaceRoot: string) => join(workspaceRoot, "tmp", "content");

export type AttemptDir = {
  /** `<raíz>/{contentRunId}/{uuid-del-intento}/`, ya creado. */
  path: string;
  /** Lo borra entero, y también el de la corrida si quedó vacío. No falla si ya no existe. */
  remove(): Promise<void>;
};

/**
 * El directorio temporal de **un** intento: dos intentos solapados de la misma corrida (uno que
 * expiró y siguió corriendo) no se pisan. El procesador de medios deja aquí sus archivos.
 */
export async function createAttemptDir(root: string, contentRunId: string): Promise<AttemptDir> {
  // El id viene validado como uuid (`JOB_PAYLOADS`); se revisa igual porque arma una ruta.
  if (!UUID.test(contentRunId)) throw new Error(`Id de corrida inválido: ${contentRunId}`);
  const runDir = join(root, contentRunId);
  const path = join(runDir, randomUUID());
  await mkdir(path, { recursive: true });
  return {
    path,
    async remove() {
      await rm(path, { recursive: true, force: true });
      // Otro intento de la misma corrida puede seguir usando el directorio: entonces queda.
      await rmdir(runDir).catch((error: unknown) => {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errorCode(error) ?? "")) throw error;
      });
    },
  };
}

/**
 * Borra los directorios de corridas de más de `maxAgeMs` (24 h por defecto; la evidencia de
 * Marketplace usa 7 días) por la fecha de su último
 * cambio): restos de un worker que murió sin llegar al `finally`. Un intento dura a lo más 30 min,
 * así que ninguno vivo tiene 24 h. Un error en un directorio no corta el barrido. Devuelve los ids
 * borrados.
 */
export async function cleanContentTmp(
  root: string,
  now = Date.now(),
  maxAgeMs = CONTENT_TMP_MAX_AGE_MS,
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    try {
      if (now - (await stat(dir)).mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // Se reintenta en el próximo arranque.
    }
  }
  return removed;
}
