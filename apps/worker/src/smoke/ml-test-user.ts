import {
  type AbortSignalLike,
  accessTokenProvider,
  type Broker,
  isAppError,
  isMercadoLibreRejectedAfterRefresh,
  type MercadoLibreTokenDeps,
  mercadoLibreAccountMetaSchema,
  type PlatformAccountRepository,
} from "@agentsales/core";
import {
  itemCreationOutcome,
  type MercadoLibreTestUser,
  type MercadoLibreTestUsers,
  withMercadoLibreToken,
} from "@agentsales/publishers";
import { HINTS, REJECTED_AFTER_REFRESH_HINT } from "./ml-smoke.js";

// `pnpm ml:test-user --broker <slug>` (spec F4-T25): crea **un** usuario de prueba de Mercado Libre
// Chile con el token de la cuenta real conectada al corredor (`POST /users/test_user`). Lo corre el
// operador. La clave sale una sola vez: va al portapapeles, nunca a la salida, a un log ni a la
// base. Antes de crear nada revisa que el portapapeles funcione (sin él, la clave se perdería).

/**
 * Si la cuenta conectada ya es un usuario de prueba (`meta.testUser`, F4-T06), con el esquema de
 * core: un valor que no calza no se toma como "cuenta real".
 */
const testUserMetaSchema = mercadoLibreAccountMetaSchema.pick({ testUser: true }).partial();

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
  const meta = testUserMetaSchema.safeParse(account.meta);
  if (!meta.success) {
    return fail(
      "ACCOUNT_META_UNREADABLE",
      `No se puede saber si la cuenta conectada a ${broker.slug} es la real o una de prueba`,
      `Reconéctala (con pnpm dev): pnpm -s cli accounts connect mercadolibre --broker ${broker.slug}`,
    );
  }
  if (meta.data.testUser === true) {
    return fail(
      "ACCOUNT_IS_TEST_USER",
      `La cuenta conectada a ${broker.slug} (${account.displayName}) ya es un usuario de prueba`,
      "Los usuarios de prueba se crean desde tu cuenta real: reconéctala y vuelve a correrlo",
    );
  }
  // Probar el portapapeles lo vacía (copia un texto vacío): se avisa.
  deps.print("Revisando el portapapeles (queda vacío)…");
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
  // Si el `POST` salió y no se sabe cómo terminó (red, 5xx, tope, corte en vuelo, otra forma), el
  // usuario pudo crearse: la misma regla que crear un ítem (`itemCreationOutcome`). Un error del
  // token o del refresco, antes del `POST`, no creó nada.
  let maybeCreated = false;
  try {
    created = await withMercadoLibreToken(
      {
        accessToken: accessTokenProvider(
          { platformAccounts: deps.accounts, mercadoLibre: deps.mercadoLibre, now: deps.now },
          account.id,
        ),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      async (token, signal) => {
        try {
          return await deps.testUsers.create(token, "MLC", signal === undefined ? {} : { signal });
        } catch (error) {
          if (itemCreationOutcome(error) === "unknown") maybeCreated = true;
          throw error;
        }
      },
    );
  } catch (error) {
    if (!isAppError(error)) throw error;
    if (maybeCreated) {
      return fail(
        error.code,
        `${error.message}. El usuario pudo haberse creado, pero su clave no llegó y no se recupera`,
        "Si más adelante aparece, ignóralo: crea otro con este mismo comando (hasta 10 por cuenta)",
      );
    }
    const hint = isMercadoLibreRejectedAfterRefresh(error)
      ? REJECTED_AFTER_REFRESH_HINT
      : error.code === "ML_REQUEST_REJECTED"
        ? "Mercado Libre admite hasta 10 usuarios de prueba por cuenta: si ya tienes 10, usa uno de ellos"
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
