import { ensureAdmin, isAppError, type UserAdminDeps } from "@agentsales/core";

// `pnpm auth:admin --email <correo>` (spec F7 §4.2, F7-T05): crea el primer administrador o le da
// un enlace de restablecer, y deja el enlace en el portapapeles, sin imprimirlo. Habla directo con
// la base (como `db:seed`): sirve aunque la API no esté corriendo o el operador haya quedado fuera.

export type AuthAdminDeps = Omit<UserAdminDeps, "brokers"> & {
  /** La URL del panel (`http://localhost:<WEB_PORT>`). */
  panelUrl: string;
  clipboardReady(): Promise<boolean>;
  copyToClipboard(text: string): Promise<void>;
  print(line: string): void;
  printError(line: string): void;
};

/** Devuelve el código de salida (0 bien, 1 si algo falló). */
export async function runAuthAdmin(
  deps: AuthAdminDeps,
  args: { email: string | undefined; name: string | undefined },
): Promise<number> {
  if (args.email === undefined || args.email.trim() === "") {
    deps.printError('Falta el correo: pnpm auth:admin --email tu@correo.cl [--name "Tu nombre"]');
    return 1;
  }
  // Sin portapapeles no se crea nada: el enlace no se imprime y no se podría recuperar.
  if (!(await deps.clipboardReady())) {
    deps.printError(
      "No se puede usar el portapapeles (pbcopy): no se hizo nada. Corre el comando en la terminal de tu Mac",
    );
    return 1;
  }
  try {
    const link = await ensureAdmin(deps, {
      email: args.email,
      ...(args.name === undefined ? {} : { name: args.name }),
    });
    await deps.copyToClipboard(`${deps.panelUrl}/invitacion#${link.token}`);
    deps.print(
      link.created
        ? `✓ Administrador ${link.user.email} creado.`
        : `✓ ${link.user.email} ya existía: se generó un enlace para elegir otra contraseña (sus sesiones se cerraron y, si lo tenía, se quitó el doble factor).`,
    );
    deps.print(
      `  El enlace quedó en el portapapeles: ábrelo en el navegador (con pnpm dev corriendo) antes de ${link.expiresAt.toLocaleString("es-CL", { timeZone: "America/Santiago" })}.`,
    );
    return 0;
  } catch (error) {
    deps.printError(
      isAppError(error)
        ? `✗ ${error.code}: ${error.message}`
        : `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
