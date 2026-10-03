import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunCommand } from "./checks.js";

const execFileAsync = promisify(execFile);

/**
 * Ejecuta un comando con timeout y devuelve stdout (o stderr, si el programa escribe ahí). Con
 * `env`, el proceso recibe solo ese entorno.
 */
export const runCommand: RunCommand = async (command, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: 10_000,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return stdout || stderr;
};
