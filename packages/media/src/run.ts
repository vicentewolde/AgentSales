import { spawn } from "node:child_process";
import { type AbortSignalLike, AppError } from "@agentsales/core";
import { FFMPEG_INSTALL_HINT } from "./tools.js";

/** Tope de la salida de un comando (un JPEG intermedio de una foto de 48 MP pesa ~20 MB). */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export const aborted = () =>
  new AppError("MEDIA_ABORTED", "Se cortó el procesamiento de medios", { retriable: true });

export function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted) throw aborted();
}

/** Un comando que terminó con un código distinto de 0: quien llama decide qué significa. */
export class CommandFailedError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`el comando salió con código ${exitCode}`);
    this.name = "CommandFailedError";
  }
}

/**
 * Corre ffmpeg o ffprobe y devuelve su salida estándar. No usa una shell. Con `signal`, el proceso
 * muere (SIGKILL: ffmpeg no deja hijos) y se lanza `MEDIA_ABORTED`; si el ejecutable no existe,
 * `MEDIA_TOOL_NOT_INSTALLED`. La salida de error no se devuelve: puede traer rutas.
 */
export function runTool(
  command: string,
  args: readonly string[],
  signal?: AbortSignalLike,
): Promise<Buffer> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { ok: Buffer } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if ("ok" in result) resolve(result.ok);
      else reject(result.error);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ error: aborted() });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ error: new CommandFailedError(null) });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") {
        finish({
          error: new AppError(
            "MEDIA_TOOL_NOT_INSTALLED",
            `No se encontró ${command}. ${FFMPEG_INSTALL_HINT}`,
            // Solo el código: el error de spawn trae los argumentos, con rutas del temporal.
            { cause: { code: error.code } },
          ),
        });
      } else {
        finish({ error });
      }
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: Buffer.concat(chunks) });
      else finish({ error: new CommandFailedError(code) });
    });
  });
}
