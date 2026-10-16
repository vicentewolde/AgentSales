import { homedir } from "node:os";
import {
  createLogger,
  EnvError,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
  resolveBackupDir,
} from "@agentsales/config";
import { isAppError } from "@agentsales/core";
import { runBackup } from "../backup/index.js";

// `pnpm db:backup` (spec F6 §4.11): un respaldo a pedido, sin `pnpm dev`. Muestra el archivo y la
// carpeta (es la del operador); nunca la conexión ni la contraseña.

loadEnvFile();
try {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });
  const dir = resolveBackupDir(env.BACKUP_DIR, {
    homeDir: homedir(),
    workspaceRoot: findWorkspaceRoot(),
  });
  try {
    const result = await runBackup({
      dir,
      databaseUrl: env.DATABASE_URL,
      ...(env.PG_BIN_DIR === undefined ? {} : { binDir: env.PG_BIN_DIR }),
    });
    logger.info(
      {
        file: result.file,
        kb: Math.round(result.bytes / 1024),
        dir,
        deleted: result.deleted.length,
        ...(result.pruneFailed ? { pruneFailed: true } : {}),
      },
      "respaldo listo",
    );
  } catch (error) {
    const code = isAppError(error) ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ code }, `el respaldo falló: ${message}`);
    process.exitCode = 1;
  }
} catch (error) {
  // Un `.env` inválido: el mensaje nombra las variables, nunca sus valores.
  console.error(error instanceof EnvError ? error.message : error);
  process.exitCode = 1;
}
