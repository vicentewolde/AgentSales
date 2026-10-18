import type { SecretBox } from "@agentsales/core";
import { isNotNull, sql } from "drizzle-orm";
import type { SchemaDatabase } from "./client.js";
import { withDbErrors } from "./errors.js";
import { credentialsAad } from "./repositories/platform-accounts.js";
import { platformAccounts } from "./schema.js";

// `pnpm db:dev-scrub` (spec F8 §4.6): la rama de desarrollo de Neon copia las cuentas de producción
// con sus tokens cifrados. Si el worker del Mac los leyera, `tokens.refresh` rotaría el token de
// Mercado Libre e invalidaría el de producción (ADR-0015). Este script borra esas credenciales y deja
// las cuentas desconectadas, y se niega a correr contra lo que parece producción: la misma base que
// `.env.production`, la misma clave, o credenciales que la clave de `.env` sí abre.

export type DevScrubDeps = {
  db: SchemaDatabase;
  /** Con la `APP_ENCRYPTION_KEY` de `.env` (la de desarrollo). */
  secretBox: SecretBox;
  databaseUrl: string;
  appEncryptionKey: string;
  nodeEnv: string;
  /** `ENV_FILE` de la terminal: este script usa siempre `.env`. */
  envFile: string | undefined;
  /** `DATABASE_URL` y `APP_ENCRYPTION_KEY` de `.env.production`; `null` si no existe. */
  production: { databaseUrl?: string | undefined; appEncryptionKey?: string | undefined } | null;
  confirm(question: string): Promise<boolean>;
  print(line: string): void;
  printError(line: string): void;
};

type Target = { host: string; port: string; database: string };

/**
 * Host, puerto y base de una conexión, sin usuario ni contraseña. En Neon, la conexión con pooler
 * (`ep-…-pooler.…`) y la directa (`ep-….…`) son la misma base: se comparan sin `-pooler`.
 */
export function databaseTarget(url: string): Target | null {
  try {
    const parsed = new URL(url);
    const [first = "", ...rest] = parsed.hostname.toLowerCase().split(".");
    return {
      host: [first.replace(/-pooler$/, ""), ...rest].join("."),
      port: parsed.port === "" ? "5432" : parsed.port,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

const sameTarget = (a: Target, b: Target) =>
  a.host === b.host && a.port === b.port && a.database === b.database;

const describeTarget = (target: Target | null) =>
  target === null ? "(conexión ilegible)" : `${target.host}/${target.database}`;

/** Devuelve el código de salida (0 bien o nada que hacer, 1 si se negó o algo falló). */
export async function runDevScrub(deps: DevScrubDeps, args: { yes: boolean }): Promise<number> {
  const refuse = (reason: string) => {
    deps.printError(`✗ No se borró nada: ${reason}`);
    return 1;
  };
  if (deps.envFile !== undefined && deps.envFile.trim() !== "") {
    return refuse(
      `ENV_FILE=${deps.envFile.trim()}: este script usa solo .env (la rama de desarrollo); quita ENV_FILE de la terminal`,
    );
  }
  if (deps.nodeEnv === "production") {
    return refuse("NODE_ENV=production: este script es solo para la base de desarrollo");
  }
  const target = databaseTarget(deps.databaseUrl);
  if (deps.production === null) {
    deps.print(
      "  No hay .env.production para comparar: se revisa solo con la clave de .env (abajo).",
    );
  } else {
    const productionTarget =
      deps.production.databaseUrl === undefined
        ? null
        : databaseTarget(deps.production.databaseUrl);
    if (target !== null && productionTarget !== null && sameTarget(target, productionTarget)) {
      return refuse(
        "la DATABASE_URL de .env es la misma base que la de .env.production; apunta .env a la rama dev de Neon",
      );
    }
    if (deps.production.appEncryptionKey === deps.appEncryptionKey) {
      return refuse(
        "la APP_ENCRYPTION_KEY de .env es la misma que la de .env.production; pon en .env una clave nueva para desarrollo",
      );
    }
  }

  const rows = await withDbErrors(() =>
    deps.db
      .select({
        id: platformAccounts.id,
        brokerId: platformAccounts.brokerId,
        platform: platformAccounts.platform,
        externalAccountId: platformAccounts.externalAccountId,
        credentialsEncrypted: platformAccounts.credentialsEncrypted,
      })
      .from(platformAccounts)
      .where(isNotNull(platformAccounts.credentialsEncrypted)),
  );
  if (rows.length === 0) {
    deps.print(`✓ ${describeTarget(target)} no tiene credenciales guardadas: nada que borrar.`);
    return 0;
  }
  // Si la clave de `.env` abre alguna, esta base no es una copia hecha con otra clave: o es
  // producción, o `.env` sigue con la clave de producción. En los dos casos, no se toca.
  const readable = rows.filter((row) => {
    try {
      deps.secretBox.decrypt(row.credentialsEncrypted ?? "", credentialsAad(row));
      return true;
    } catch {
      return false;
    }
  });
  if (readable.length > 0) {
    return refuse(
      `la APP_ENCRYPTION_KEY de .env abre ${readable.length} de las credenciales de ${describeTarget(target)}: parece producción, o .env sigue con la clave de producción`,
    );
  }

  const byPlatform = new Map<string, number>();
  for (const row of rows) byPlatform.set(row.platform, (byPlatform.get(row.platform) ?? 0) + 1);
  const summary = [...byPlatform].map(([platform, count]) => `${platform} ${count}`).join(", ");
  deps.print(`  Base: ${describeTarget(target)}`);
  deps.print(
    `  Se borrarán las credenciales de ${rows.length} cuenta(s) (${summary}) y quedarán desconectadas.`,
  );
  if (!args.yes && !(await deps.confirm("¿Borrarlas? [s/N] "))) {
    deps.print("No se borró nada.");
    return 1;
  }
  const scrubbed = await withDbErrors(() =>
    deps.db
      .update(platformAccounts)
      .set({ credentialsEncrypted: null, status: "revoked", updatedAt: sql`now()` })
      .where(isNotNull(platformAccounts.credentialsEncrypted))
      .returning({ id: platformAccounts.id }),
  );
  deps.print(
    `✓ Credenciales borradas en ${scrubbed.length} cuenta(s). Para usar una en desarrollo, conéctala de nuevo.`,
  );
  return 0;
}
