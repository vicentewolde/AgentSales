import { fileURLToPath } from "node:url";

/** Carpeta de migraciones SQL generadas por drizzle-kit (`pnpm db:generate`). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
