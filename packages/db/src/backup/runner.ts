import { spawn } from "node:child_process";
import type { AbortSignalLike } from "@agentsales/core";

/** Lo que devolvió un proceso: el código de salida (`null` si lo cortó una señal) y su salida. */
export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string };

/**
 * Corre un proceso sin shell (los argumentos van tal cual) con el entorno dado. Lanza si no se
 * puede iniciar (por ejemplo `ENOENT`); corta el proceso al vencer `timeoutMs` o con `signal`.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignalLike },
) => Promise<ProcessResult>;

/** Tope de lo que se guarda de cada salida: el listado de `pg_restore` puede ser largo. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export const spawnProcess: ProcessRunner = (command, args, { env, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) =>
      current.length >= MAX_OUTPUT_CHARS
        ? current
        : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (exitCode) => {
      done();
      resolve({ exitCode, stdout, stderr });
    });
  });
