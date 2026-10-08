import {
  accountListResponseSchema,
  accountRefreshResponseSchema,
  accountResponseSchema,
  mercadoLibreAuthorizeUrlResponseSchema,
  type PlatformAccountView,
} from "@agentsales/api/contracts";
import {
  MERCADOLIBRE_REFRESH_AGE_MS,
  PLATFORM_ACCOUNT_STATUS_TEXT,
  PLATFORM_TEXT,
  tokenStdinCommand,
} from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, formatDateTime, guarded, type Io, renderTable } from "../output.js";
import { brokerSlugOf, fetchBrokers } from "./shared.js";

export type AccountsDeps = Io &
  Pick<Terminal, "stdinIsTty" | "readStdin" | "openUrl"> & {
    client: ApiClient;
    /** Para avisar de un vencimiento cercano. */
    now: () => Date;
  };

/** El mismo tope que `connectTokenBodySchema` de la API. */
const TOKEN_MAX_LENGTH = 4096;

/** Con 10 días o menos, el panel y la CLI avisan (spec F3 §4.6). */
const EXPIRY_WARNING_MS = 10 * 24 * 60 * 60 * 1000;

function expiryText(account: PlatformAccountView, now: Date, c: Colors): string {
  if (account.tokenExpiresAt === null) return "—";
  const text =
    formatDateTime(account.tokenExpiresAt) + (account.tokenExpiryEstimated ? " (estimado)" : "");
  if (account.status !== "connected") return c.dim(text);
  const left = account.tokenExpiresAt.getTime() - now.getTime();
  return left <= EXPIRY_WARNING_MS ? c.yellow(text) : text;
}

function paintStatus(account: PlatformAccountView, c: Colors): string {
  const text = PLATFORM_ACCOUNT_STATUS_TEXT[account.status];
  if (account.status === "connected") return c.green(text);
  if (account.status === "revoked") return c.dim(text);
  return c.red(text);
}

/** `agentsales accounts` (spec F3 §4.9): las cuentas conectadas, con su estado y vencimiento. */
export function runAccounts(deps: AccountsDeps) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const [brokers, { accounts }] = await Promise.all([
      fetchBrokers(deps.client),
      unwrap(deps.client.accounts.$get(), accountListResponseSchema),
    ]);
    if (accounts.length === 0) {
      deps.print(c.yellow("No hay cuentas conectadas"));
      deps.print(
        c.dim(
          "→ Conecta Instagram con: pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin",
        ),
      );
      deps.print(
        c.dim(
          "→ Conecta Mercado Libre con: pnpm -s cli accounts connect mercadolibre --broker <slug>",
        ),
      );
      return 0;
    }
    const now = deps.now();
    deps.print(
      renderTable(
        ["ID", "CORREDOR", "CANAL", "CUENTA", "ESTADO", "VENCE", "ÚLTIMO REFRESCO"],
        accounts.map((account) => [
          account.id,
          brokers.get(account.brokerId)?.slug ?? account.brokerId,
          PLATFORM_TEXT[account.platform],
          account.displayName,
          paintStatus(account, c),
          expiryText(account, now, c),
          account.tokenRefreshedAt === null ? "—" : formatDateTime(account.tokenRefreshedAt),
        ]),
        c,
      ),
    );
    if (accounts.some((account) => account.status === "expired" || account.status === "error")) {
      deps.print(c.dim("→ Una cuenta vencida o con error se reconecta con accounts connect"));
    }
    return 0;
  });
}

export type ConnectOptions = { broker?: string; tokenStdin?: boolean; urlStdin?: boolean };

/** El largo máximo de la dirección de vuelta pegada (la API acepta hasta 4096 por valor). */
const PASTED_URL_MAX_LENGTH = 8192;

/** El comando que pega la dirección de vuelta de Mercado Libre (spec F4 §4.2, paso 3). */
const urlStdinCommand = (broker: string) =>
  `pbpaste | pnpm -s cli accounts connect mercadolibre --broker ${broker} --url-stdin`;

/** La dirección sin query ni fragmento, para comparar con la registrada. */
const withoutQuery = (url: URL) => `${url.origin}${url.pathname}`;

/**
 * `agentsales accounts connect mercadolibre --broker <slug> [--url-stdin]` (spec F4 §4.2 y §4.12):
 * - sin `--url-stdin`: pide a la API el enlace de autorización (con el `state` firmado, 10 min),
 *   lo imprime, lo abre y explica el paso siguiente;
 * - con `--url-stdin`: lee la dirección de vuelta pegada (`pbpaste | …`, nunca de un argumento),
 *   revisa que sea la registrada, saca el `code` y el `state` y conecta. Nunca muestra la dirección
 *   ni el código, ni los pone en un error.
 */
function runConnectMercadoLibre(deps: AccountsDeps, broker: string, urlStdin: boolean) {
  const c = deps.colors;
  const pipeCommand = urlStdinCommand(broker);
  return guarded(deps, async () => {
    if (!urlStdin) {
      const { url } = await unwrap(
        deps.client.accounts.mercadolibre["authorize-url"].$post({ json: { broker } }),
        mercadoLibreAuthorizeUrlResponseSchema,
      );
      deps.print(`Abre este enlace y autoriza con la cuenta administradora: ${url}`);
      deps.openUrl(url);
      deps.print(
        c.dim(
          "→ Después de autorizar, el navegador muestra un error de conexión: es lo esperado. Copia la dirección completa de la barra (vale 10 min) y corre:",
        ),
      );
      deps.print(`  ${pipeCommand}`);
      return 0;
    }

    if (deps.stdinIsTty()) {
      throw new CliError(
        "URL_STDIN_REQUIRED",
        "La dirección va por la entrada estándar, no escrita en la terminal",
        `Copia la dirección de la barra y corre: ${pipeCommand}`,
      );
    }
    const pasted = (await deps.readStdin()).trim();
    if (pasted === "") {
      throw new CliError(
        "URL_MISSING",
        "No llegó ninguna dirección por la entrada estándar",
        pipeCommand,
      );
    }
    let url: URL | null = null;
    if (pasted.length <= PASTED_URL_MAX_LENGTH && !/\s/.test(pasted)) {
      try {
        url = new URL(pasted);
      } catch {
        url = null;
      }
    }
    // Sin mostrar lo recibido: puede traer el código.
    if (url === null) {
      throw new CliError(
        "URL_INVALID",
        "Lo que llegó por la entrada estándar no parece una dirección (tiene espacios o saltos de línea, o es demasiado largo)",
        "Copia solo la dirección de la barra después de autorizar y vuelve a intentarlo",
      );
    }
    const { connect } = await unwrap(deps.client.accounts.$get(), accountListResponseSchema);
    const expected = new URL(connect.mercadolibre.redirectUri);
    if (withoutQuery(url) !== withoutQuery(expected)) {
      throw new CliError(
        "URL_NOT_REDIRECT",
        `La dirección pegada no es la de vuelta registrada (${connect.mercadolibre.redirectUri})`,
        "Copia la dirección de la pestaña que quedó con el error de conexión, después de autorizar",
      );
    }
    if (url.searchParams.has("error")) {
      throw new CliError(
        "OAUTH_DENIED",
        "Mercado Libre no entregó la autorización (se canceló o se rechazó)",
        `Pide el enlace de nuevo con: pnpm -s cli accounts connect mercadolibre --broker ${broker}`,
      );
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || code === "" || state === null || state === "") {
      throw new CliError(
        "URL_INCOMPLETE",
        "A la dirección pegada le falta el código o el state: cópiala completa, después de autorizar",
        `Pide el enlace de nuevo con: pnpm -s cli accounts connect mercadolibre --broker ${broker}`,
      );
    }
    const { account } = await unwrap(
      deps.client.accounts.mercadolibre.connect.$post({ json: { broker, code, state } }),
      accountResponseSchema,
    );
    deps.print(`${c.green("✓")} Conectada ${account.displayName} (${broker})`);
    if (account.permissions !== null) {
      deps.print(c.dim(`  Permisos: ${account.permissions.join(", ")}`));
    }
    if (account.tokenExpiresAt !== null) {
      deps.print(
        c.dim(
          `  El acceso se renueva solo; si no se usa, vence ${formatDateTime(account.tokenExpiresAt)} (estimado)`,
        ),
      );
    }
    return 0;
  });
}

/**
 * `agentsales accounts connect instagram --broker <slug> --token-stdin` (spec F3 §4.6 y D4): lee el
 * token largo de Generate token desde la entrada estándar (`pbpaste | …`), nunca de un argumento,
 * y no lo muestra ni lo pone en un error. Sin `--token-stdin`, solo si la API ofrece el OAuth
 * (`https`, F7), imprime el enlace de conexión y lo abre en el navegador.
 */
export function runConnect(deps: AccountsDeps, platform: string, options: ConnectOptions = {}) {
  const c = deps.colors;
  const channel = platform.trim().toLowerCase();
  if (channel === "mercadolibre" && options.broker !== undefined) {
    return runConnectMercadoLibre(deps, brokerSlugOf(options.broker), options.urlStdin === true);
  }
  return guarded(deps, async () => {
    if (channel !== "instagram" && channel !== "mercadolibre") {
      throw new CliError("PLATFORM_INVALID", `Se conecta instagram o mercadolibre: "${platform}"`);
    }
    if (options.broker === undefined) {
      throw new CliError("BROKER_REQUIRED", "Falta --broker <slug>: el corredor de la cuenta");
    }
    const broker = brokerSlugOf(options.broker);
    const pipeCommand = tokenStdinCommand(broker);

    if (!options.tokenStdin) {
      const { connect } = await unwrap(deps.client.accounts.$get(), accountListResponseSchema);
      if (!connect.instagram.oauth) {
        throw new CliError(
          "OAUTH_UNAVAILABLE",
          "Meta no acepta la conexión por OAuth con http://localhost: conecta con el token del panel de Meta (Generate token)",
          `Copia el token y corre: ${pipeCommand}`,
        );
      }
      // El host lo decide la API (el de la URI de retorno: la cookie del `state` lo distingue).
      const url = `${connect.instagram.startUrl}?broker=${encodeURIComponent(broker)}`;
      deps.print(`Abre este enlace para conectar Instagram: ${url}`);
      deps.openUrl(url);
      deps.print(c.dim("→ Al terminar, revisa la cuenta con: agentsales accounts"));
      return 0;
    }

    if (deps.stdinIsTty()) {
      throw new CliError(
        "TOKEN_STDIN_REQUIRED",
        "El token va por la entrada estándar, no escrito en la terminal",
        `Copia el token de Generate token y corre: ${pipeCommand}`,
      );
    }
    const token = (await deps.readStdin()).trim();
    if (token === "") {
      throw new CliError(
        "TOKEN_MISSING",
        "No llegó ningún token por la entrada estándar",
        pipeCommand,
      );
    }
    // Sin mostrar lo recibido: un pegado de varias líneas o de otra cosa no se manda a la API.
    if (token.length > TOKEN_MAX_LENGTH || /\s/.test(token)) {
      throw new CliError(
        "TOKEN_INVALID",
        "Lo que llegó por la entrada estándar no parece un token (tiene espacios o saltos de línea, o es demasiado largo)",
        "Copia solo el token de Generate token y vuelve a intentarlo",
      );
    }
    const { account } = await unwrap(
      deps.client.accounts["connect-token"].$post({
        json: { broker, platform: "instagram", token },
      }),
      accountResponseSchema,
    );
    deps.print(`${c.green("✓")} Conectada ${account.displayName} (${broker})`);
    if (account.tokenExpiresAt !== null) {
      deps.print(
        c.dim(
          `  Vence ${formatDateTime(account.tokenExpiresAt)}${account.tokenExpiryEstimated ? " (estimado: se conoce el real al renovarlo, desde mañana)" : ""}`,
        ),
      );
    }
    return 0;
  });
}

export type RefreshOptions = { force?: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `agentsales accounts refresh <id> [--force]` (spec F3 §4.6 y F4 §4.3): renueva el acceso de una
 * cuenta con la política de su plataforma y espera el resultado. En Instagram, `--force` salta solo
 * el tope de 30 días, nunca el mínimo de 24 h; en Mercado Libre, sin `--force` renueva si pasaron
 * 7 días, y con `--force` siempre. Sale con 1 si la cuenta quedó vencida.
 */
export function runRefresh(deps: AccountsDeps, id: string, options: RefreshOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const accountId = id.trim();
    if (!z.uuid().safeParse(accountId).success) {
      throw new CliError(
        "ACCOUNT_ID_INVALID",
        `"${id}" no es el id de una cuenta`,
        "Mira los ids con agentsales accounts",
      );
    }
    const result = await unwrap(
      deps.client.accounts[":id"].refresh.$post({
        param: { id: accountId },
        json: { force: options.force ?? false },
      }),
      accountRefreshResponseSchema,
    ).catch((error: unknown) => {
      if (error instanceof ApiCallError && error.code === "ACCOUNT_NOT_CONNECTED") {
        throw new CliError(
          "ACCOUNT_NOT_CONNECTED",
          error.apiMessage ?? error.message,
          "Reconéctala con agentsales accounts connect",
        );
      }
      throw error;
    });
    const { account } = result;
    const expiry =
      account.tokenExpiresAt === null ? "" : ` · vence ${formatDateTime(account.tokenExpiresAt)}`;
    if (result.outcome === "refreshed") {
      deps.print(`${c.green("✓")} Acceso de ${account.displayName} renovado${expiry}`);
      return 0;
    }
    const mercadoLibre = account.platform === "portal_inmobiliario";
    if (result.outcome === "skipped") {
      const when = formatDateTime(result.refreshableAt);
      deps.print(
        result.reason === "too_recent"
          ? `Sin cambios: ${account.displayName} se renovó o conectó hace menos de 24 h; se puede desde ${when}`
          : mercadoLibre
            ? `Sin cambios: ${account.displayName} se renovó o conectó hace menos de ${MERCADOLIBRE_REFRESH_AGE_MS / DAY_MS} días; toca desde ${when}. Usa --force para renovarlo igual`
            : `Sin cambios: a ${account.displayName} le quedan más de 30 días${expiry}. Usa --force para renovarlo igual`,
      );
      return 0;
    }
    const platformName = mercadoLibre ? "Mercado Libre" : "Instagram";
    deps.printError(
      c.red(
        result.reason === "token_expired"
          ? `✗ El acceso de ${account.displayName} ya había vencido: la cuenta quedó vencida`
          : `✗ ${platformName} rechazó el acceso de ${account.displayName}: la cuenta quedó vencida`,
      ),
    );
    deps.printError(c.dim("→ Reconéctala con agentsales accounts connect"));
    return 1;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): AccountsDeps => ({
    ...ctx,
    client: ctx.api(),
    now: () => new Date(),
  });
  const accounts = program
    .command("accounts")
    .description("Cuentas conectadas (Instagram y Mercado Libre): estado y vencimiento")
    .action(() => exitWith(() => runAccounts(deps())));
  accounts
    .command("connect")
    .description(
      "Conecta una cuenta: Instagram con el token de Generate token; Mercado Libre con el enlace y la dirección de vuelta pegada",
    )
    .argument("<canal>", "instagram o mercadolibre")
    .option("--broker <slug>", "corredor de la cuenta")
    .option(
      "--token-stdin",
      "Instagram: lee el token largo desde la entrada estándar (pbpaste | …)",
    )
    .option(
      "--url-stdin",
      "Mercado Libre: lee la dirección de vuelta desde la entrada estándar (pbpaste | …)",
    )
    .action((platform: string, options: ConnectOptions) =>
      exitWith(() => runConnect(deps(), platform, options)),
    );
  accounts
    .command("refresh")
    .description(
      "Renueva el acceso de una cuenta (--force sin esperar: 30 días en Instagram, 7 en Mercado Libre)",
    )
    .argument("<id>", "id de la cuenta (agentsales accounts)")
    .option("--force", "renueva aunque no toque todavía (en Instagram, nunca antes de 24 h)")
    .action((id: string, options: RefreshOptions) =>
      exitWith(() => runRefresh(deps(), id, options)),
    );
}
