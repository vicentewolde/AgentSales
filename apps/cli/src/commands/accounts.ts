import {
  accountListResponseSchema,
  accountRefreshResponseSchema,
  accountResponseSchema,
  type PlatformAccountView,
} from "@agentsales/api/contracts";
import { PLATFORM_ACCOUNT_STATUS_TEXT, PLATFORM_TEXT, tokenStdinCommand } from "@agentsales/core";
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

export type ConnectOptions = { broker?: string; tokenStdin?: boolean };

/**
 * `agentsales accounts connect instagram --broker <slug> --token-stdin` (spec F3 §4.6 y D4): lee el
 * token largo de Generate token desde la entrada estándar (`pbpaste | …`), nunca de un argumento,
 * y no lo muestra ni lo pone en un error. Sin `--token-stdin`, solo si la API ofrece el OAuth
 * (`https`, F7), imprime el enlace de conexión y lo abre en el navegador.
 */
export function runConnect(deps: AccountsDeps, platform: string, options: ConnectOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    if (platform.trim().toLowerCase() !== "instagram") {
      throw new CliError("PLATFORM_INVALID", `Por ahora solo se conecta instagram: "${platform}"`);
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

/**
 * `agentsales accounts refresh <id> [--force]` (spec F3 §4.6): renueva el token de una cuenta y
 * espera el resultado. `--force` salta solo el tope de 30 días, nunca el mínimo de 24 h. Sale con 1
 * si la cuenta quedó vencida.
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
    if (result.outcome === "skipped") {
      const when = formatDateTime(result.refreshableAt);
      deps.print(
        result.reason === "too_recent"
          ? `Sin cambios: ${account.displayName} se renovó o conectó hace menos de 24 h; se puede desde ${when}`
          : `Sin cambios: a ${account.displayName} le quedan más de 30 días${expiry}. Usa --force para renovarlo igual`,
      );
      return 0;
    }
    deps.printError(
      c.red(
        result.reason === "token_expired"
          ? `✗ El acceso de ${account.displayName} ya había vencido: la cuenta quedó vencida`
          : `✗ Instagram rechazó el acceso de ${account.displayName}: la cuenta quedó vencida`,
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
    .description("Cuentas conectadas (Instagram): estado y vencimiento")
    .action(() => exitWith(() => runAccounts(deps())));
  accounts
    .command("connect")
    .description("Conecta una cuenta (F3: el token de Generate token por la entrada estándar)")
    .argument("<canal>", "instagram")
    .option("--broker <slug>", "corredor de la cuenta")
    .option("--token-stdin", "lee el token largo desde la entrada estándar (pbpaste | …)")
    .action((platform: string, options: ConnectOptions) =>
      exitWith(() => runConnect(deps(), platform, options)),
    );
  accounts
    .command("refresh")
    .description("Renueva el acceso de una cuenta (--force sin esperar a que falten 30 días)")
    .argument("<id>", "id de la cuenta (agentsales accounts)")
    .option("--force", "renueva aunque le queden más de 30 días (nunca antes de 24 h)")
    .action((id: string, options: RefreshOptions) =>
      exitWith(() => runRefresh(deps(), id, options)),
    );
}
