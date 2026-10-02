import { type ApiClient, createApiClient } from "./api-client.js";
import { colors } from "./colors.js";
import { apiPort, loadEnvironment } from "./env.js";
import type { Io } from "./output.js";

/** Lo que comparten los comandos al registrarse en `index.ts`. */
export type CliContext = Io & {
  /** Cliente de la API en el puerto del `.env`; se crea al usarlo (tras cargar el `.env`). */
  api: () => ApiClient;
  /**
   * Carpeta desde la que el operador corrió el comando: `pnpm cli` cambia a `apps/cli`, pero deja
   * la original en `INIT_CWD` (spec F1 §4.1).
   */
  cwd: string;
};

export function createContext(): CliContext {
  return {
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
    colors,
    api: () => createApiClient(apiPort(loadEnvironment())),
    cwd: process.env.INIT_CWD ?? process.cwd(),
  };
}

/** Fija el código de salida del proceso con el resultado de la acción. */
export async function exitWith(run: () => Promise<number>): Promise<void> {
  process.exitCode = await run();
}
