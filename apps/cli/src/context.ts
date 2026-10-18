import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { copyToClipboard } from "@agentsales/config";
import { type ApiClient, createApiClient, invalidServerClient } from "./api-client.js";
import { colors } from "./colors.js";
import { apiPort, loadEnvironment } from "./env.js";
import type { Io } from "./output.js";
import { clientTarget, localServerUrl, resolveServer, type ServerResolution } from "./server.js";
import { createFileSessionStore, type SessionStore } from "./session.js";

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
  /**
   * Pide una contraseña mostrando un punto por carácter (F7, `agentsales login`). `null` sin una
   * terminal interactiva; `{ cancelled: true }` si el operador cancela (Ctrl+C).
   */
  readPassword: (prompt: string) => Promise<PasswordInput | null>;
  /**
   * Copia al portapapeles (`pbcopy`, F7): los enlaces de invitación nunca se imprimen (ADR-0021).
   * Rechaza si no se puede (sin `pbcopy`).
   */
  copyToClipboard: (text: string) => Promise<void>;
};

/** Lo que comparten los comandos al registrarse en `index.ts`. */
export type CliContext = Io &
  Terminal & {
    /**
     * Cliente de la API del servidor de `server()`, con la sesión de `agentsales login` si es la de
     * ese servidor; se crea al usarlo (tras cargar el `.env`).
     */
    api: () => ApiClient;
    /**
     * A qué servidor habla (spec F8 §4.5): `AGENTSALES_API_URL`, el guardado con la sesión o la API
     * local del `.env`.
     */
    server: () => ServerResolution;
    /** La API local del `.env` (`http://127.0.0.1:<API_PORT>`) y su puerto. */
    localServer: () => string;
    localPort: () => number;
    /** `AGENTSALES_API_URL` de la terminal, leída antes de cargar el `.env`. */
    envApiUrl: string | undefined;
    /** Un cliente para un servidor dado (ya validado), con un token o sin él (`login`). */
    apiFor: (server: string, token?: string) => ApiClient;
    /** El cliente de un destino ya elegido (`clientTarget`, `logoutTarget`). */
    clientFrom: (target: ReturnType<typeof clientTarget>) => ApiClient;
    /** La sesión de la CLI (`~/.agentsales/cli-session.json`, F7). */
    session: SessionStore;
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

/** Lo que escribió el operador, o que canceló. */
export type PasswordInput = { cancelled: false; value: string } | { cancelled: true };

/** El punto que se muestra por cada carácter de la contraseña (nunca el carácter). */
export const PASSWORD_MASK = "•";

/**
 * Una tecla (o un pegado) de la contraseña: el valor nuevo, lo que se escribe en la terminal (un
 * punto por carácter, o borrar el último) y si terminó (Enter) o se canceló (Ctrl+C, Ctrl+D). Las
 * flechas y otras secuencias de escape no cuentan.
 */
export function passwordKeystroke(
  value: string,
  chunk: string,
): { value: string; echo: string; done: "enter" | "cancel" | null } {
  if (chunk.startsWith("\u001b")) return { value, echo: "", done: null };
  let next = value;
  let echo = "";
  for (const char of chunk) {
    if (char === "\r" || char === "\n") return { value: next, echo, done: "enter" };
    if (char === "\u0003" || char === "\u0004") return { value: next, echo, done: "cancel" };
    if (char === "\u007f" || char === "\b") {
      if (next.length > 0) {
        next = [...next].slice(0, -1).join("");
        echo += "\b \b";
      }
    } else if (char >= " ") {
      next += char;
      echo += PASSWORD_MASK;
    }
  }
  return { value: next, echo, done: null };
}

async function readPassword(prompt: string): Promise<PasswordInput | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    const finish = (result: PasswordInput) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(result);
    };
    // Cada tecla se lee cruda: se muestra un punto por carácter, nunca la letra.
    const onData = (chunk: string) => {
      const step = passwordKeystroke(value, chunk);
      value = step.value;
      if (step.echo !== "") process.stderr.write(step.echo);
      if (step.done === "enter") finish({ cancelled: false, value });
      else if (step.done === "cancel") finish({ cancelled: true });
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

export function createContext(): CliContext {
  const session = createFileSessionStore();
  // `AGENTSALES_API_URL` se lee antes de cargar el `.env`: es de la terminal (una prueba puntual),
  // no de un archivo de entorno.
  const envApiUrl = process.env.AGENTSALES_API_URL;
  const localPort = () => apiPort(loadEnvironment());
  const localServer = () => localServerUrl(localPort());
  const server = (): ServerResolution =>
    resolveServer({
      envUrl: envApiUrl,
      session: session.read(),
      localPort: localPort(),
    });
  const apiFor = (url: string, token?: string) =>
    createApiClient(url, token === undefined ? {} : { token });
  const clientFrom = (target: ReturnType<typeof clientTarget>) =>
    target.ok ? apiFor(target.url, target.token) : invalidServerClient(target.error.message);
  return {
    envApiUrl,
    server,
    localPort,
    localServer,
    apiFor,
    readPassword,
    copyToClipboard,
    session,
    confirm,
    stdinIsTty: () => process.stdin.isTTY === true,
    readStdin,
    openUrl,
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
    colors,
    api: () => clientFrom(clientTarget(server(), session.read()?.token)),
    clientFrom,
    cwd: process.env.INIT_CWD ?? process.cwd(),
  };
}

/** Fija el código de salida del proceso con el resultado de la acción. */
export async function exitWith(run: () => Promise<number>): Promise<void> {
  process.exitCode = await run();
}
