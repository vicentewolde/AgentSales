import {
  type UserLinkResponse,
  type UserView,
  userLinkResponseSchema,
  userResponseSchema,
  usersResponseSchema,
} from "@agentsales/api/contracts";
import { userStateText } from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, formatDateTime, guarded, type Io, renderTable } from "../output.js";
import { brokerSlugOf, fetchBrokers } from "./shared.js";

// F7-T16 (spec F7 §4.10, ADR-0021): los usuarios, solo el administrador. El enlace de invitación
// o de restablecer es un secreto: va al portapapeles, **nunca** a la pantalla ni a un error.

export type UsersDeps = Io & Pick<Terminal, "copyToClipboard"> & { client: ApiClient };

/** Un enlace de invitación (`<panel>/invitacion#<token>`), sin espacios. */
const INVITATION_LINK = /^https?:\/\/\S+\/invitacion#\S+$/;

/** El usuario por su correo (los comandos lo reciben así; la API usa el id). */
async function userByEmail(client: ApiClient, email: string): Promise<UserView> {
  const wanted = email.trim().toLowerCase();
  const { users } = await unwrap(client.users.$get(), usersResponseSchema);
  const user = users.find((candidate) => candidate.email === wanted);
  if (user === undefined) throw new CliError("USER_NOT_FOUND", `No existe el usuario ${wanted}`);
  return user;
}

/**
 * Copia el enlace y dice que se copió, sin mostrarlo. Si el portapapeles falla, lo dice y cómo
 * generar otro (el enlace queda sin usar y vence solo).
 */
export async function deliverLink(deps: UsersDeps, link: UserLinkResponse): Promise<number> {
  const c = deps.colors;
  const failed = (reason: string) => {
    deps.printError(c.red(`✗ ${reason}: el enlace no se muestra aquí`));
    deps.printError(`  ${c.dim(`→ Genera otro con: pnpm -s cli users reset ${link.user.email}`)}`);
    return 1;
  };
  // Un enlace que no es de invitación (una respuesta rara) no se copia: sería un falso "copiado".
  if (!INVITATION_LINK.test(link.invitationUrl)) {
    return failed("La API no entregó un enlace de invitación válido");
  }
  try {
    await deps.copyToClipboard(link.invitationUrl);
  } catch {
    return failed("No se pudo copiar el enlace al portapapeles");
  }
  deps.print(
    `${c.green("✓")} Enlace copiado al portapapeles (vence ${formatDateTime(link.expiresAt)}): envíaselo a ${link.user.email} por correo o por otro canal privado`,
  );
  return 0;
}

/** `agentsales users list`: los usuarios con su rol, su corredor y su estado. */
export function runUsersList(deps: UsersDeps) {
  return guarded(deps, async () => {
    const [{ users }, brokers] = await Promise.all([
      unwrap(deps.client.users.$get(), usersResponseSchema),
      fetchBrokers(deps.client),
    ]);
    if (users.length === 0) {
      deps.print("No hay usuarios.");
      return 0;
    }
    deps.print(
      renderTable(
        ["Correo", "Nombre", "Rol", "Corredor", "Estado"],
        users.map((user) => [
          user.email,
          user.name,
          user.role === "admin" ? "administrador" : "corredor",
          user.brokerId === null ? "—" : (brokers.get(user.brokerId)?.slug ?? user.brokerId),
          userStateText(user),
        ]),
        deps.colors,
      ),
    );
    return 0;
  });
}

export type InviteOptions = { email?: string; name?: string; broker?: string; admin?: boolean };

/**
 * `agentsales users invite --email <correo> --name <nombre> (--broker <slug> | --admin)`: crea el
 * usuario y copia su enlace de invitación al portapapeles.
 */
export function runUsersInvite(deps: UsersDeps, options: InviteOptions) {
  return guarded(deps, async () => {
    if (options.email === undefined || options.name === undefined) {
      throw new CliError("USER_FIELDS_REQUIRED", "Faltan --email <correo> y --name <nombre>");
    }
    if ((options.broker === undefined) === (options.admin !== true)) {
      throw new CliError(
        "USER_ROLE_REQUIRED",
        "Indica --broker <slug> (un corredor) o --admin (otro administrador), uno de los dos",
      );
    }
    let brokerId: string | null = null;
    if (options.broker !== undefined) {
      const slug = brokerSlugOf(options.broker);
      const broker = [...(await fetchBrokers(deps.client)).values()].find((b) => b.slug === slug);
      if (broker === undefined)
        throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
      brokerId = broker.id;
    }
    let link: UserLinkResponse;
    try {
      link = await unwrap(
        deps.client.users.$post({
          json: {
            email: options.email,
            name: options.name,
            role: brokerId === null ? "admin" : "broker",
            brokerId,
          },
        }),
        userLinkResponseSchema,
      );
    } catch (error) {
      // Sin respuesta (o una rara) después de pedirlo: el usuario puede haber quedado creado.
      if (
        error instanceof ApiCallError &&
        (error.code === "TIMEOUT" || error.code === "UNEXPECTED_RESPONSE")
      ) {
        throw new CliError(
          "INVITE_UNCONFIRMED",
          "No se pudo confirmar la invitación: puede que el usuario se haya creado",
          `Revisa con: pnpm -s cli users list; si está, pnpm -s cli users reset ${options.email}`,
        );
      }
      throw error;
    }
    deps.print(`${deps.colors.green("✓")} Usuario creado: ${link.user.email}`);
    return deliverLink(deps, link);
  });
}

/** `agentsales users reset <correo>`: un enlace nuevo para elegir contraseña, al portapapeles. */
export function runUsersReset(deps: UsersDeps, email: string) {
  return guarded(deps, async () => {
    const user = await userByEmail(deps.client, email);
    const link = await unwrap(
      deps.client.users[":id"].reset.$post({ param: { id: user.id } }),
      userLinkResponseSchema,
    );
    return deliverLink(deps, link);
  });
}

/** `agentsales users disable|enable <correo>`: desactivar (cierra sus sesiones) o reactivar. */
export function runUsersToggle(deps: UsersDeps, email: string, action: "disable" | "enable") {
  return guarded(deps, async () => {
    const user = await userByEmail(deps.client, email);
    const route = deps.client.users[":id"][action];
    const { user: updated } = await unwrap(
      route.$post({ param: { id: user.id } }),
      userResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} ${updated.email}: ${updated.disabled ? "desactivado (sus sesiones se cerraron)" : "activo"}`,
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): UsersDeps => ({ ...ctx, client: ctx.api() });
  const users = program
    .command("users")
    .description(
      "Usuarios (solo el administrador): el enlace va al portapapeles, nunca a la pantalla",
    );
  users
    .command("list")
    .description("Los usuarios con su rol, su corredor y su estado")
    .action(() => exitWith(() => runUsersList(deps())));
  users
    .command("invite")
    .description("Crea un usuario y copia su enlace de invitación al portapapeles")
    .option("--email <correo>", "su correo")
    .option("--name <nombre>", "su nombre")
    .option("--broker <slug>", "el corredor del usuario")
    .option("--admin", "otro administrador (sin corredor)")
    .action((options: InviteOptions) => exitWith(() => runUsersInvite(deps(), options)));
  users
    .command("reset")
    .description("Copia al portapapeles un enlace nuevo para elegir la contraseña")
    .argument("<correo>", "el correo del usuario")
    .action((email: string) => exitWith(() => runUsersReset(deps(), email)));
  for (const action of ["disable", "enable"] as const) {
    users
      .command(action)
      .description(
        action === "disable"
          ? "Desactiva un usuario y cierra sus sesiones"
          : "Reactiva un usuario desactivado",
      )
      .argument("<correo>", "el correo del usuario")
      .action((email: string) => exitWith(() => runUsersToggle(deps(), email, action)));
  }
}
