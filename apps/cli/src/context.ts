import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { type ApiClient, createApiClient } from "./api-client.js";
import { colors } from "./colors.js";
import { apiPort, loadEnvironment } from "./env.js";
import type { Io } from "./output.js";

/** Lo que la CLI pide a la terminal: confirmar, leer la entrada estándar y abrir un enlace. */
export type Terminal = {
  /**
   * Pregunta sí o no por stderr. Sin una terminal interactiva (un script, una tubería) devuelve
   * `false`: el comando pide entonces `--yes`.
   */
  confirm: (question: string) => Promise<boolean>;
  /** Si la entrada estándar es una terminal (nadie le pasó nada por una tubería). */
  stdinIsTty: () => boolean;
  /** Lee la entrada estándar completa (un token pasado con `pbpaste | …`). */
  readStdin: () => Promise<string>;
  /** Abre un enlace en el navegador; si no puede, no falla (el enlace ya se imprimió). */
  openUrl: (url: string) => void;
};

/** Lo que comparten los comandos al registrarse en `index.ts`. */
export type CliContext = Io &
  Terminal & {
    /** Cliente de la API en el puerto del `.env`; se crea al usarlo (tras cargar el `.env`). */
    api: () => ApiClient;
    /**
     * Carpeta desde la que el operador corrió el comando: `pnpm cli` cambia a `apps/cli`, pero deja
     * la original en `INIT_CWD` (spec F1 §4.1).
     */
    cwd: string;
  };

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Ctrl+C o el fin de la entrada cierran la pregunta: es un "no" (sale con 1, sin publicar).
    const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
    const answer = await Promise.race([rl.question(`${question} (s/N) `), closed]);
    return /^(s|si|sí|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Tope de lo que se lee de la entrada estándar: un token largo tiene unos 200 caracteres. */
export const STDIN_MAX_BYTES = 16 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    bytes += buffer.length;
    // Algo mucho más largo que un token no es un token: no se sigue leyendo (lo leído ya supera el
    // largo máximo, y `accounts connect` lo rechaza sin mostrarlo).
    if (bytes > STDIN_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

export function createContext(): CliContext {
  return {
    confirm,
    stdinIsTty: () => process.stdin.isTTY === true,
    readStdin,
    openUrl,
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
