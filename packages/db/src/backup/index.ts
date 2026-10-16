// `@agentsales/db/backup`: el respaldo local (spec F6 §4.11) sin cargar `pg` ni Drizzle, para que la
// CLI (`doctor`) y la API (`/health`) lo usen sin abrir la base.
export { childEnv, pgEnvFromUrl } from "./connection.js";
export {
  BACKUP_CHECK_TIMEOUT_MS,
  BACKUP_DUMP_TIMEOUT_MS,
  BACKUP_KEEP,
  BACKUP_LOCK_FILE,
  type BackupDeps,
  type BackupResult,
  backupFileName,
  runBackup,
} from "./run-backup.js";
export { type ProcessResult, type ProcessRunner, spawnProcess } from "./runner.js";
export { BACKUP_STATUS_FILE, readBackupStatus, writeBackupStatus } from "./status.js";
export {
  canDumpServer,
  DEFAULT_LIBPQ_BIN_DIR,
  findPgTool,
  type PgTool,
  type PgVersion,
  parsePgToolVersion,
  parseServerVersion,
} from "./tools.js";
