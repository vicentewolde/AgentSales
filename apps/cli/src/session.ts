import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// La sesión de la CLI (spec F7 §4.10, ADR-0021): el token que dio `agentsales login`, en
// `~/.agentsales/cli-session.json` (fuera del proyecto, carpeta `0700` y archivo `0600`). Nunca se
// imprime ni se loguea; Claude no lee este archivo (CLAUDE.md). Desde F8-T08 (spec F8 §4.5) guarda
// también el servidor que emitió el token.

const sessionSchema = z.object({
  token: z.string().min(1),
  email: z.string(),
  savedAt: z.string(),
  /**
   * El servidor de `agentsales login --api` (su origen, sin `/api`). Falta en una sesión de la API
   * local, y en las de F7, que siguen siendo locales.
   */
  apiUrl: z.string().optional(),
});
export type CliSession = z.infer<typeof sessionSchema>;

export type SessionStore = {
  /** Dónde vive (para los mensajes). */
  readonly path: string;
  /** La sesión guardada; `null` si no hay o el archivo no se puede leer. */
  read(): CliSession | null;
  write(session: CliSession): void;
  clear(): void;
};

/** `~/.agentsales/cli-session.json`. */
export const cliSessionPath = (home: string = homedir()) =>
  join(home, ".agentsales", "cli-session.json");

export function createFileSessionStore(path: string = cliSessionPath()): SessionStore {
  return {
    path,
    read() {
      try {
        // Si alguien le abrió los permisos, se vuelven a cerrar antes de leer.
        if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
        const parsed = sessionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write(session) {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      // Se escribe aparte y se renombra: nunca queda un archivo a medias ni con otros permisos.
      const partial = `${path}.${process.pid}.partial`;
      try {
        writeFileSync(partial, `${JSON.stringify(session)}\n`, { mode: 0o600 });
        chmodSync(partial, 0o600);
        renameSync(partial, path);
      } finally {
        rmSync(partial, { force: true });
      }
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

/** Una sesión en memoria (los tests de los comandos). */
export function createMemorySessionStore(initial: CliSession | null = null): SessionStore {
  let current = initial;
  return {
    path: "(memoria)",
    read: () => current,
    write: (session) => {
      current = session;
    },
    clear: () => {
      current = null;
    },
  };
}
