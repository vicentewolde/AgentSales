import { defineConfig } from "drizzle-kit";

// `generate` solo lee el esquema: no necesita DATABASE_URL. Las migraciones se aplican con
// `pnpm db:migrate` (src/scripts/migrate.ts), que valida el entorno con @agentsales/config.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
