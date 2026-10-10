import {
  accountListResponseSchema,
  accountRefreshResponseSchema,
  accountResponseSchema,
  marketplaceLoginResponseSchema,
  mercadoLibreAuthorizeUrlResponseSchema,
  type PlatformAccountView,
} from "@agentsales/api/contracts";
import {
  accountDisconnectText,
  currentMarketplaceLoginError,
  MARKETPLACE_LOGIN_CLIENT_WAIT_MS,
  MARKETPLACE_WAIT_MAX_POLL_FAILURES,
  MERCADOLIBRE_REFRESH_AGE_MS,
  marketplaceConnectCommand,
  marketplaceLoginErrorText,
  marketplaceLoginOutcome,
  mercadoLibreConnectCommands,
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
import { brokerSlugOf, fetchBrokers, manualConfirmHint } from "./shared.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

export type AccountsDeps = Io &
  Pick<Terminal, "stdinIsTty" | "readStdin" | "openUrl" | "confirm"> & {
    client: ApiClient;
    /** Para avisar de un vencimiento cercano. */
    now: () => Date;
    /** La espera del inicio de sesión de Marketplace (`waitForRun`). */
    sleep: WaitDeps["sleep"];
    /** Reloj monótono en milisegundos, para el tope de esa espera. */
    clock: WaitDeps["now"];
    wait?: WaitDeps["wait"];
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

/**
 * La última revisión: en Marketplace, cuándo el worker vio la sesión abierta (no hay token que
 * refrescar); en las demás, el último refresco del token.
 */
function lastCheckText(account: PlatformAccountView): string {
  const when =
    account.platform === "fb_marketplace" ? account.sessionCheckedAt : account.tokenRefreshedAt;
  return when === null ? "—" : formatDateTime(when);
}

/**
 * `agentsales accounts` (spec F3 §4.9, F5 §4.12): las cuentas conectadas, con su estado y
 * vencimiento; en Marketplace, la última sesión vista y, debajo, el último inicio de sesión que
 * falló.
 */
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
      deps.print(
        c.dim(
          "→ Conecta Marketplace con: pnpm -s cli accounts connect marketplace --broker <slug>",
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
          lastCheckText(account),
        ]),
        c,
      ),
    );
    for (const account of accounts) {
      const error = currentMarketplaceLoginError(account);
      if (error === null) continue;
      deps.print(
        c.yellow(
          `  ${account.displayName}: el inicio de sesión del ${formatDateTime(error.at)} falló: ${error.message}`,
        ),
      );
    }
    if (accounts.some((account) => account.status === "expired" || account.status === "error")) {
      deps.print(c.dim("→ Una cuenta vencida o con error se reconecta con accounts connect"));
    }
    return 0;
  });
}

export type ConnectOptions = {
  broker?: string;
  tokenStdin?: boolean;
  urlStdin?: boolean;
  /** Marketplace: el nombre de la cuenta (por defecto "Facebook de <corredor>"). */
  label?: string;
};

/** El largo máximo de la dirección de vuelta pegada (la API acepta hasta 4096 por valor). */
const PASTED_URL_MAX_LENGTH = 8192;

/** El comando que pega la dirección de vuelta de Mercado Libre (spec F4 §4.2, paso 3; core). */
const urlStdinCommand = (broker: string) => mercadoLibreConnectCommands(broker).paste;

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
async function connectMercadoLibre(
  deps: AccountsDeps,
  broker: string,
  urlStdin: boolean,
): Promise<number> {
  const c = deps.colors;
  const pipeCommand = urlStdinCommand(broker);
  if (!urlStdin) {
    const { url } = await unwrap(
      deps.client.accounts.mercadolibre["authorize-url"].$post({ json: { broker } }),
      mercadoLibreAuthorizeUrlResponseSchema,
    );
    deps.print(`Abre este enlace y autoriza con la cuenta administradora: ${url}`);
    deps.openUrl(url);
    deps.print(
      c.dim(
        "→ Después de autorizar, el navegador muestra un error de conexión: es lo esperado. Si en cambio muestra un aviso de certificado, no continúes. En los dos casos, copia la dirección completa de la barra (vale 10 min) y corre:",
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
}

/** Lo que se espera del inicio de sesión de Marketplace: el resultado y la cuenta, si conectó. */
type LoginWait = { status: "pending" | "connected" | "failed"; code?: string; name?: string };

/**
 * `agentsales accounts connect marketplace --broker <slug> [--label <nombre>]` (spec F5 §4.2 y
 * §4.12): pide al worker abrir una ventana de Chromium con Facebook, donde el operador inicia
 * sesión **a mano** (también la verificación, si la pide), y espera mirando `GET /accounts` hasta
 * que la sesión quede vista o el inicio falle (`marketplaceLoginOutcome`, core), con un tope de
 * unos 11 min. Abre Facebook en cualquier modo: no publica (ADR-0017 punto 7). Sale con 1 si falló
 * o si deja de esperar.
 */
async function connectMarketplace(
  deps: AccountsDeps,
  broker: string,
  label: string | undefined,
): Promise<number> {
  const c = deps.colors;
  const name = label?.trim();
  const { brokerId, requestedAt } = await unwrap(
    deps.client.accounts.marketplace.login.$post({
      json: { broker, ...(name === undefined || name === "" ? {} : { label: name }) },
    }),
    marketplaceLoginResponseSchema,
  ).catch((error: unknown) => {
    if (error instanceof ApiCallError && error.code === "MARKETPLACE_PROFILE_ACTION_PENDING") {
      throw new CliError(
        error.code,
        error.apiMessage ?? error.message,
        `Espera un momento y vuelve a correr ${marketplaceConnectCommand(broker)}`,
      );
    }
    throw error;
  });
  deps.print(
    "Se abrirá una ventana de Chromium con Facebook: inicia sesión ahí a mano (también la verificación, si la pide). Espero hasta 10 min.",
  );
  deps.print(c.dim("  El worker abre la ventana: tiene que estar corriendo (pnpm dev)"));
  // La primera conexión que falla no tiene cuenta donde anotar el motivo: la CLI no lo ve.
  deps.print(
    c.dim("  Si cierras la ventana sin iniciar sesión, corta con Ctrl+C y vuelve a intentarlo"),
  );
  const check = async (): Promise<LoginWait> => {
    const { accounts } = await unwrap(deps.client.accounts.$get(), accountListResponseSchema);
    const result = marketplaceLoginOutcome(accounts, { brokerId, requestedAt });
    if (result.outcome === "failed") return { status: "failed", code: result.code };
    if (result.outcome === "pending") return { status: "pending" };
    const account = accounts.find(
      (item) =>
        item.brokerId === brokerId &&
        item.platform === "fb_marketplace" &&
        item.status === "connected",
    );
    return { status: "connected", ...(account === undefined ? {} : { name: account.displayName }) };
  };
  const done = await waitForRun<LoginWait>(
    {
      ...deps,
      now: deps.clock,
      wait: {
        maxWaitMs: MARKETPLACE_LOGIN_CLIENT_WAIT_MS,
        maxPollFailures: MARKETPLACE_WAIT_MAX_POLL_FAILURES,
        ...deps.wait,
      },
    },
    {
      run: { status: "pending" },
      fetch: check,
      isTerminal: (wait) => wait.status !== "pending",
      progress: () => "esperando el inicio de sesión",
      // La cuenta no tiene `queued`: el aviso de "¿está corriendo el worker?" ya se dio arriba.
      isQueued: () => false,
      laterCommand: "agentsales accounts",
      noun: "el inicio de sesión",
    },
  );
  if (done === null) {
    deps.printError(
      c.dim(
        `→ Si la ventana nunca se abrió, revisa que el worker esté corriendo (pnpm dev) y vuelve a correr ${marketplaceConnectCommand(broker)}`,
      ),
    );
    return 1;
  }
  if (done.status === "failed") {
    deps.printError(c.red(`✗ ${marketplaceLoginErrorText(done.code ?? "")}`));
    deps.printError(c.dim(`→ Vuelve a intentarlo con ${marketplaceConnectCommand(broker)}`));
    return 1;
  }
  deps.print(`${c.green("✓")} Conectada ${done.name ?? "la cuenta de Marketplace"} (${broker})`);
  deps.print(
    c.dim(
      "  La sesión queda en un perfil de Chromium de este equipo; AgentSales no guarda tu clave",
    ),
  );
  return 0;
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
  return guarded(deps, async () => {
    if (channel !== "instagram" && channel !== "mercadolibre" && channel !== "marketplace") {
      throw new CliError(
        "PLATFORM_INVALID",
        `Se conecta instagram, mercadolibre o marketplace: "${platform}"`,
      );
    }
    // Una opción de otro canal no se ignora en silencio.
    const foreign =
      options.tokenStdin && channel !== "instagram"
        ? "--token-stdin"
        : options.urlStdin && channel !== "mercadolibre"
          ? "--url-stdin"
          : options.label !== undefined && channel !== "marketplace"
            ? "--label"
            : null;
    if (foreign !== null) {
      throw new CliError(
        "OPTION_NOT_FOR_PLATFORM",
        `${foreign} no es para ${channel}: Instagram usa --token-stdin; Mercado Libre, --url-stdin; Marketplace, --label`,
      );
    }
    if (options.broker === undefined) {
      throw new CliError("BROKER_REQUIRED", "Falta --broker <slug>: el corredor de la cuenta");
    }
    const broker = brokerSlugOf(options.broker);
    if (channel === "mercadolibre")
      return connectMercadoLibre(deps, broker, options.urlStdin === true);
    if (channel === "marketplace") return connectMarketplace(deps, broker, options.label);
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
    const accountId = accountIdOf(id);
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

export type DisconnectOptions = { yes?: boolean };

/** El id de una cuenta: un uuid, como lo muestra `agentsales accounts`. */
function accountIdOf(id: string): string {
  const accountId = id.trim();
  if (!z.uuid().safeParse(accountId).success) {
    throw new CliError(
      "ACCOUNT_ID_INVALID",
      `"${id}" no es el id de una cuenta`,
      "Mira los ids con agentsales accounts",
    );
  }
  return accountId;
}

/**
 * `agentsales accounts disconnect <id> [--yes]` (spec F3 §4.6, F5 §4.2 y §4.12): pregunta antes
 * (salvo `--yes`) y desconecta. En Marketplace además borra el perfil de Chromium con la sesión de
 * Facebook (lo hace el worker); con una publicación esperando el clic final, la API lo impide
 * (`MANUAL_CONFIRM_PENDING`) y aquí se dicen los dos comandos para cerrarla.
 */
export function runDisconnect(deps: AccountsDeps, id: string, options: DisconnectOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const accountId = accountIdOf(id);
    const { accounts } = await unwrap(deps.client.accounts.$get(), accountListResponseSchema);
    const account = accounts.find((item) => item.id === accountId);
    if (account === undefined) {
      throw new CliError(
        "ACCOUNT_NOT_FOUND",
        `No existe la cuenta ${accountId}`,
        "Mira los ids con agentsales accounts",
      );
    }
    const marketplace = account.platform === "fb_marketplace";
    if (!options.yes) {
      const confirmed = await deps.confirm(
        `¿Desconectar ${account.displayName} (${PLATFORM_TEXT[account.platform]})? ${accountDisconnectText(account.platform)}`,
      );
      if (!confirmed) {
        deps.printError(c.yellow("No se desconectó: confirma en la terminal o usa --yes"));
        return 1;
      }
    }
    const { account: disconnected } = await unwrap(
      deps.client.accounts[":id"].disconnect.$post({
        param: { id: accountId },
        json: { confirmed: true },
      }),
      accountResponseSchema,
    ).catch((error: unknown) => {
      if (!(error instanceof ApiCallError)) throw error;
      const message = error.apiMessage ?? error.message;
      if (error.code === "MANUAL_CONFIRM_PENDING") {
        throw new CliError(error.code, message, manualConfirmHint(error.publicationId));
      }
      const hints: Record<string, string> = {
        PUBLICATION_IN_PROGRESS:
          "Espera a que termine de llenarse el formulario y vuelve a intentarlo",
        MARKETPLACE_PROFILE_ACTION_PENDING: "Espera un momento y vuelve a intentarlo",
      };
      const hint = error.code === undefined ? undefined : hints[error.code];
      if (hint === undefined) throw error;
      throw new CliError(error.code ?? "API_ERROR", message, hint);
    });
    deps.print(`${c.green("✓")} Desconectada ${disconnected.displayName}`);
    if (marketplace) {
      deps.print(
        c.dim(
          "  El worker borra el perfil de Chromium. La sesión sigue abierta en Facebook: ciérrala allá si quieres",
        ),
      );
    }
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): AccountsDeps => ({
    ...ctx,
    client: ctx.api(),
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    clock: () => performance.now(),
  });
  const accounts = program
    .command("accounts")
    .description(
      "Cuentas conectadas (Instagram, Mercado Libre y Marketplace): estado y vencimiento",
    )
    .action(() => exitWith(() => runAccounts(deps())));
  accounts
    .command("connect")
    .description(
      "Conecta una cuenta: Instagram con el token de Generate token; Mercado Libre con el enlace y la dirección de vuelta pegada; Marketplace iniciando sesión en una ventana de Chromium",
    )
    .argument("<canal>", "instagram, mercadolibre o marketplace")
    .option("--broker <slug>", "corredor de la cuenta")
    .option(
      "--label <nombre>",
      "Marketplace: el nombre de la cuenta (por defecto, Facebook de <corredor>)",
    )
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
  accounts
    .command("disconnect")
    .description(
      "Desconecta una cuenta (pide confirmación; en Marketplace borra el perfil de Chromium con la sesión)",
    )
    .argument("<id>", "id de la cuenta (agentsales accounts)")
    .option("--yes", "no pide confirmación")
    .action((id: string, options: DisconnectOptions) =>
      exitWith(() => runDisconnect(deps(), id, options)),
    );
}
