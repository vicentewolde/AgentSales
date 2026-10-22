import {
  type LoginResponse,
  loginResponseSchema,
  loginStepResponseSchema,
  meResponseSchema,
} from "@agentsales/api/contracts";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import {
  describeServer,
  isLocalServer,
  localServerUrl,
  logoutTarget,
  parseServerUrl,
  resolveServer,
  type ServerTarget,
  ServerUrlError,
} from "../server.js";
import type { CliSession, SessionStore } from "../session.js";

// F7-T06 (spec F7 §4.10, ADR-0021): entrar, salir y quién soy. El token va al archivo de sesión
// (`0600`, fuera del proyecto) y nunca a la pantalla. Desde F8-T08 (spec F8 §4.5), `--api` elige
// el servidor y la sesión lo guarda.

export type LoginDeps = Io &
  Pick<Terminal, "readPassword"> & {
    /** Un cliente para ese servidor, con un token (cerrar la sesión anterior) o sin él (entrar). */
    clientFor: (server: string, token?: string) => ApiClient;
    session: SessionStore;
    /** `AGENTSALES_API_URL`, si viene. */
    envUrl: string | undefined;
    /** El puerto de la API local del `.env`. */
    localPort: number;
  };

/** `--api`, `AGENTSALES_API_URL` o la local; `save` si la sesión debe guardar la dirección. */
function loginTarget(
  deps: Pick<LoginDeps, "envUrl" | "localPort">,
  api: string | undefined,
): { url: string; save: boolean } {
  const [raw, where] =
    api !== undefined
      ? [api, "--api"]
      : (deps.envUrl?.trim() ?? "") !== ""
        ? [deps.envUrl ?? "", "AGENTSALES_API_URL"]
        : [null, ""];
  // Sin dirección, la local de hoy: la sesión no la guarda (sigue el `API_PORT` del `.env`).
  if (raw === null) return { url: localServerUrl(deps.localPort), save: false };
  try {
    const url = parseServerUrl(raw);
    // Una dirección local tampoco se guarda: sigue el `API_PORT` del `.env` si cambia.
    return { url, save: !isLocalServer(url) };
  } catch (error) {
    if (!(error instanceof ServerUrlError)) throw error;
    throw new CliError(
      "API_URL_INVALID",
      `${where}: ${error.message}`,
      "Ejemplo: agentsales login --email tu@correo.cl --api https://agentsales.agentpey.com",
    );
  }
}

/** El servidor de una sesión guardada, con la regla de siempre (`null` si ya no es válido). */
function sessionServer(session: CliSession, localPort: number): string | null {
  const resolved = resolveServer({ envUrl: undefined, session, localPort });
  return resolved.ok ? resolved.target.sessionUrl : null;
}

const ROLE_TEXT = { admin: "administrador", broker: "corredor" } as const;

/** Cuántas veces se puede escribir el código antes de tener que entrar de nuevo. */
const TOTP_ATTEMPTS = 3;

/**
 * El segundo paso (spec F8 §4.8, F8-T16): pide el código de la app (sin mostrarlo, como la
 * contraseña) y lo manda con el desafío. Un código equivocado se puede corregir hasta 3 veces con
 * el mismo desafío (cada fallo cuenta para el bloqueo del usuario).
 */
async function secondStep(
  deps: Pick<LoginDeps, "readPassword" | "printError" | "colors">,
  client: ApiClient,
  challenge: string,
): Promise<LoginResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const input = await deps.readPassword("Código de tu app de claves (o uno de recuperación): ");
    if (input === null) {
      throw new CliError(
        "LOGIN_NEEDS_TERMINAL",
        "El código se escribe en una terminal interactiva",
        "Corre agentsales login en tu terminal",
      );
    }
    if (input.cancelled) throw new CliError("LOGIN_CANCELLED", "Cancelaste: no se entró");
    try {
      return await unwrap(
        client.auth.login.totp.$post({
          json: { challenge, code: input.value, client: "cli" },
        }),
        loginResponseSchema,
      );
    } catch (error) {
      if (
        !(error instanceof ApiCallError) ||
        error.code !== "TOTP_CODE_INVALID" ||
        attempt >= TOTP_ATTEMPTS
      ) {
        throw error;
      }
      deps.printError(deps.colors.yellow("  El código no sirve o ya se usó: escribe el siguiente"));
    }
  }
}

/**
 * `agentsales login --email <correo> [--api https://<dominio>]`: pide la contraseña sin mostrarla.
 * El pedido de entrar va sin el token anterior: ese token es de su servidor y no viaja a otro.
 */
export function runLogin(deps: LoginDeps, options: { email?: string; api?: string }) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const email = options.email?.trim();
    if (email === undefined || email === "") {
      throw new CliError(
        "EMAIL_REQUIRED",
        "Falta el correo: agentsales login --email tu@correo.cl",
      );
    }
    const target = loginTarget(deps, options.api);
    const input = await deps.readPassword(`Contraseña de ${email}: `);
    if (input === null) {
      throw new CliError(
        "LOGIN_NEEDS_TERMINAL",
        "La contraseña se escribe en una terminal interactiva",
        "Corre agentsales login en tu terminal",
      );
    }
    if (input.cancelled) throw new CliError("LOGIN_CANCELLED", "Cancelaste: no se entró");
    const password = input.value;
    const previous = deps.session.read();
    const client = deps.clientFor(target.url);
    const step = await unwrap(
      client.auth.login.$post({ json: { email, password, client: "cli" } }),
      loginStepResponseSchema,
    );
    // Con el doble factor activo, la contraseña da un desafío: falta el código (F8-T16).
    const { user, token } =
      "totpRequired" in step ? await secondStep(deps, client, step.challenge) : step;
    if (token === undefined) {
      throw new CliError("LOGIN_NO_TOKEN", "La API no entregó la sesión de la CLI");
    }
    deps.session.write({
      token,
      email: user.email,
      savedAt: new Date().toISOString(),
      ...(target.save ? { apiUrl: target.url } : {}),
    });
    // La sesión anterior de esta CLI se cierra en su servidor (con su token, solo allí): no queda
    // una sesión huérfana válida por 30 días. Si no responde, vence sola.
    const previousServer = previous === null ? null : sessionServer(previous, deps.localPort);
    if (previous !== null && previousServer !== null && previous.token !== token) {
      await deps
        .clientFor(previousServer, previous.token)
        .auth.logout.$post()
        .catch(() => undefined);
    }
    const where = isLocalServer(target.url) ? "" : ` en ${target.url}`;
    deps.print(
      `${c.green("✓")} Entraste como ${user.email} (${ROLE_TEXT[user.role] ?? user.role})${where}`,
    );
    deps.print(
      c.dim(
        target.save
          ? `  La sesión y la dirección del servidor quedaron en ${deps.session.path}: los comandos van allí`
          : `  La sesión quedó en ${deps.session.path}`,
      ),
    );
    return 0;
  });
}

/** `agentsales logout`: cierra la sesión en la API (si responde) y borra el archivo igual. */
export function runLogout(deps: Io & { client: ApiClient; session: SessionStore }) {
  const c = deps.colors;
  return guarded(deps, async () => {
    if (deps.session.read() === null) {
      // Un archivo roto tampoco es una sesión: se borra igual.
      deps.session.clear();
      deps.print("No había una sesión abierta en esta CLI");
      return 0;
    }
    let reached = true;
    try {
      // Salir es idempotente en la API: 204 aunque la sesión ya no valga.
      await deps.client.auth.logout.$post();
    } catch {
      reached = false;
    }
    deps.session.clear();
    deps.print(`${c.green("✓")} Saliste: la sesión de la CLI se borró`);
    if (!reached) {
      deps.printError(
        c.yellow(
          "  La API no respondió: en el servidor la sesión sigue válida hasta que venza (7 días sin uso)",
        ),
      );
    }
    return 0;
  });
}

/** `agentsales whoami`: el usuario de la sesión y el servidor (spec F8 §4.5). */
export function runWhoami(deps: Io & { client: ApiClient; target?: ServerTarget }) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const server = deps.target;
    if (server !== undefined) {
      deps.print(`Servidor: ${describeServer(server)}`);
      if (server.sessionUrl !== null && server.sessionUrl !== server.url) {
        // El token no viaja a otro servidor (`tokenFor`): aquí la CLI va sin sesión.
        deps.printError(
          c.yellow(`  Tu sesión es de ${server.sessionUrl}: con este servidor vas sin sesión`),
        );
      }
    }
    const { user } = await unwrap(deps.client.auth.me.$get(), meResponseSchema);
    const broker = user.broker === null ? "" : ` · corredor ${user.broker.slug}`;
    deps.print(`${user.name} <${user.email}> · ${ROLE_TEXT[user.role] ?? user.role}${broker}`);
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("login")
    .description(
      "Entra con tu correo y tu contraseña (la pide sin mostrarla) y, si tienes el doble factor, el código de tu app",
    )
    .requiredOption("--email <correo>", "tu correo")
    .option(
      "--api <dirección>",
      "el servidor, con https:// (por ejemplo https://agentsales.agentpey.com); sin ella, la API local",
    )
    .action((options: { email: string; api?: string }) =>
      exitWith(() =>
        runLogin(
          {
            ...ctx,
            clientFor: ctx.apiFor,
            localPort: ctx.localPort(),
            envUrl: ctx.envApiUrl,
          },
          options,
        ),
      ),
    );
  program
    .command("logout")
    .description("Cierra la sesión de la CLI")
    .action(() =>
      exitWith(() =>
        runLogout({
          ...ctx,
          client: ctx.clientFrom(logoutTarget(ctx.server(), ctx.session.read()?.token)),
        }),
      ),
    );
  program
    .command("whoami")
    .description("Muestra con qué usuario estás y en qué servidor")
    .action(() =>
      exitWith(() => {
        const resolved = ctx.server();
        return runWhoami({
          ...ctx,
          client: ctx.api(),
          ...(resolved.ok ? { target: resolved.target } : {}),
        });
      }),
    );
}
