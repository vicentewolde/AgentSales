import {
  type AbortSignalLike,
  accessTokenProvider,
  type Broker,
  isAppError,
  isMercadoLibreRejectedAfterRefresh,
  type MercadoLibreTokenDeps,
  type PlatformAccountRepository,
} from "@agentsales/core";
import {
  type MercadoLibreTestUser,
  type MercadoLibreTestUsers,
  withMercadoLibreToken,
} from "@agentsales/publishers";
import { z } from "zod";
import { HINTS, REJECTED_AFTER_REFRESH_HINT } from "./ml-smoke.js";

// `pnpm ml:test-user --broker <slug>` (spec F4-T25): crea **un** usuario de prueba de Mercado Libre
// Chile con el token de la cuenta real conectada al corredor (`POST /users/test_user`). Lo corre el
// operador. La clave sale una sola vez: va al portapapeles, nunca a la salida, a un log ni a la
// base. Antes de crear nada revisa que el portapapeles funcione (sin él, la clave se perdería).

/** Si la cuenta conectada ya es un usuario de prueba (`meta.testUser`, F4-T06). */
const testUserMetaSchema = z.object({ testUser: z.boolean().optional().catch(undefined) });

export type MlTestUserDeps = {
  accounts: Pick<
    PlatformAccountRepository,
    "list" | "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  >;
  brokers: { list(): Promise<Pick<Broker, "id" | "slug">[]> };
  /** El refresco de Mercado Libre, o `null` sin `ML_APP_ID` y `ML_CLIENT_SECRET`. */
  mercadoLibre: MercadoLibreTokenDeps["mercadoLibre"];
  testUsers: MercadoLibreTestUsers;
  /** Si se puede copiar al portapapeles (se revisa antes de crear). */
  clipboardReady(): Promise<boolean>;
  copyToClipboard(text: string): Promise<void>;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
};

export type MlTestUserOptions = { brokerSlug: string; signal?: AbortSignalLike };

/** Los errores de una llamada que pudo crear el usuario sin que se supiera (la clave se perdió). */
const MAYBE_CREATED = new Set(["ML_UNAVAILABLE", "ML_UNEXPECTED_RESPONSE"]);

/**
 * Crea el usuario de prueba y deja la clave en el portapapeles. Sale con 0 solo si se creó y se
 * copió la clave; con 1 en cualquier otro caso (sin crear nada, salvo lo que se dice).
 */
export async function runMlTestUser(
  deps: MlTestUserDeps,
  options: MlTestUserOptions,
): Promise<number> {
  const fail = (code: string, message: string, hint?: string) => {
    deps.printError(`✗ ${code}: ${message}`);
    if (hint !== undefined) deps.printError(`  → ${hint}`);
    return 1;
  };
  const broker = (await deps.brokers.list()).find((item) => item.slug === options.brokerSlug);
  if (broker === undefined) {
    return fail("BROKER_NOT_FOUND", `No existe el corredor ${options.brokerSlug}`);
  }
  const account = (await deps.accounts.list()).find(
    (candidate) =>
      candidate.platform === "portal_inmobiliario" &&
      candidate.brokerId === broker.id &&
      candidate.status === "connected" &&
      candidate.hasCredentials,
  );
  if (account === undefined) {
    return fail(
      "ACCOUNT_NOT_CONNECTED",
      `${broker.slug} no tiene una cuenta de Mercado Libre conectada`,
      `Conecta tu cuenta real (con pnpm dev): pnpm -s cli accounts connect mercadolibre --broker ${broker.slug}`,
    );
  }
  if (testUserMetaSchema.safeParse(account.meta).data?.testUser === true) {
    return fail(
      "ACCOUNT_IS_TEST_USER",
      `La cuenta conectada a ${broker.slug} (${account.displayName}) ya es un usuario de prueba`,
      "Los usuarios de prueba se crean desde tu cuenta real: reconéctala y vuelve a correrlo",
    );
  }
  if (!(await deps.clipboardReady())) {
    return fail(
      "CLIPBOARD_UNAVAILABLE",
      "No se puede usar el portapapeles (pbcopy): no se creó nada, porque la clave no se puede recuperar",
      "Corre el comando en la terminal de tu Mac",
    );
  }

  deps.print(
    `Creando un usuario de prueba de Mercado Libre Chile con la cuenta ${account.displayName}…`,
  );
  let created: MercadoLibreTestUser;
  try {
    created = await withMercadoLibreToken(
      {
        accessToken: accessTokenProvider(
          { platformAccounts: deps.accounts, mercadoLibre: deps.mercadoLibre, now: deps.now },
          account.id,
        ),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (token, signal) =>
        deps.testUsers.create(token, "MLC", signal === undefined ? {} : { signal }),
    );
  } catch (error) {
    if (!isAppError(error)) throw error;
    const inFlight = error.code === "ML_ABORTED" && error.details?.reason !== "not_sent";
    if (MAYBE_CREATED.has(error.code) || inFlight) {
      return fail(
        error.code,
        `${error.message}. El usuario pudo haberse creado, pero su clave no llegó y no se recupera`,
        "Si más adelante aparece, ignóralo: crea otro con este mismo comando (hasta 10 por cuenta)",
      );
    }
    const hint = isMercadoLibreRejectedAfterRefresh(error)
      ? REJECTED_AFTER_REFRESH_HINT
      : HINTS[error.code];
    return fail(error.code, error.message, hint);
  }

  try {
    await deps.copyToClipboard(created.password);
  } catch {
    return fail(
      "CLIPBOARD_UNAVAILABLE",
      `Se creó el usuario ${created.nickname} (id ${created.id}), pero su clave no se pudo copiar y no se recupera`,
      "Crea otro con este mismo comando (hasta 10 por cuenta)",
    );
  }
  deps.print(`✓ Usuario de prueba creado: ${created.nickname} (id ${created.id})`);
  deps.print(
    "  La clave quedó en tu portapapeles: pégala YA en tu gestor de claves junto con el id y el apodo. No se puede recuperar.",
  );
  deps.print(
    "  Sigue con la checklist (docs/07-checklist-cuentas.md, usuario de prueba, paso 2): entrar en una ventana privada y pedir la activación a soporte.",
  );
  return 0;
}
