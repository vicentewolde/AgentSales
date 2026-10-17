import { loginResponseSchema, meResponseSchema } from "@agentsales/api/contracts";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import type { SessionStore } from "../session.js";

// F7-T06 (spec F7 §4.10, ADR-0021): entrar, salir y quién soy. El token va al archivo de sesión
// (`0600`, fuera del proyecto) y nunca a la pantalla.

export type LoginDeps = Io &
  Pick<Terminal, "readPassword"> & { client: ApiClient; session: SessionStore };

const ROLE_TEXT = { admin: "administrador", broker: "corredor" } as const;

/** `agentsales login --email <correo>`: pide la contraseña sin mostrarla. */
export function runLogin(deps: LoginDeps, options: { email?: string }) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const email = options.email?.trim();
    if (email === undefined || email === "") {
      throw new CliError(
        "EMAIL_REQUIRED",
        "Falta el correo: agentsales login --email tu@correo.cl",
      );
    }
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
    const { user, token } = await unwrap(
      deps.client.auth.login.$post({ json: { email, password, client: "cli" } }),
      loginResponseSchema,
    );
    if (token === undefined) {
      throw new CliError("LOGIN_NO_TOKEN", "La API no entregó la sesión de la CLI");
    }
    deps.session.write({ token, email: user.email, savedAt: new Date().toISOString() });
    // La sesión anterior de esta CLI se cierra en la API (el cliente todavía la lleva): no queda
    // una sesión huérfana válida por 30 días. Si la API no responde, vence sola.
    if (previous !== null && previous.token !== token) {
      await deps.client.auth.logout.$post().catch(() => undefined);
    }
    deps.print(`${c.green("✓")} Entraste como ${user.email} (${ROLE_TEXT[user.role]})`);
    deps.print(c.dim(`  La sesión quedó en ${deps.session.path}`));
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

/** `agentsales whoami`: el usuario de la sesión. */
export function runWhoami(deps: Io & { client: ApiClient }) {
  return guarded(deps, async () => {
    const { user } = await unwrap(deps.client.auth.me.$get(), meResponseSchema);
    const broker = user.broker === null ? "" : ` · corredor ${user.broker.slug}`;
    deps.print(`${user.name} <${user.email}> · ${ROLE_TEXT[user.role]}${broker}`);
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("login")
    .description("Entra con tu correo y tu contraseña (la pide sin mostrarla)")
    .requiredOption("--email <correo>", "tu correo")
    .action((options: { email: string }) =>
      exitWith(() => runLogin({ ...ctx, client: ctx.api() }, options)),
    );
  program
    .command("logout")
    .description("Cierra la sesión de la CLI")
    .action(() => exitWith(() => runLogout({ ...ctx, client: ctx.api() })));
  program
    .command("whoami")
    .description("Muestra con qué usuario estás")
    .action(() => exitWith(() => runWhoami({ ...ctx, client: ctx.api() })));
}
