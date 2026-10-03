// Versión mínima de ffmpeg y su lectura, y el estado de Chromium (spec F2 §4.2 y §4.8): los usan
// el procesador, el renderizador y `agentsales doctor`. Va en su propia entrada
// (`@agentsales/media/tools`) para que la CLI no cargue sharp ni Playwright en cada comando.

/** Desde 8.1, ffmpeg arma las fotos HEIC del iPhone hechas de mosaicos (`heic-conversion.md`). */
export const FFMPEG_MIN_VERSION = { major: 8, minor: 1 } as const;

/** El comando que se sugiere cuando falta ffmpeg o es viejo (macOS con Homebrew). */
export const FFMPEG_INSTALL_HINT =
  "Instala ffmpeg 8.1 o más nuevo (brew install ffmpeg, o brew upgrade ffmpeg) o ajusta FFMPEG_PATH y FFPROBE_PATH en .env";

/**
 * La versión de la primera línea de `ffmpeg -version` (o `ffprobe -version`): `ffmpeg version
 * 9.0.1 Copyright…` (Homebrew) o `ffmpeg version n9.0.1-11-ge47273f4d9 …` (builds estáticos).
 * `null` si no se reconoce, por ejemplo un build de desarrollo (`N-12345-g…`).
 */
export function parseFfmpegVersion(output: string): { major: number; minor: number } | null {
  const match = /\bversion\s+n?(\d+)\.(\d+)/.exec(output.split("\n")[0] ?? "");
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `true` si la versión alcanza el mínimo; una versión que no se reconoce se acepta. */
export function isSupportedFfmpeg(version: { major: number; minor: number } | null): boolean {
  if (version === null) return true;
  return (
    version.major > FFMPEG_MIN_VERSION.major ||
    (version.major === FFMPEG_MIN_VERSION.major && version.minor >= FFMPEG_MIN_VERSION.minor)
  );
}

/** El comando que instala el Chromium que pide la versión de Playwright del proyecto. */
export const CHROMIUM_INSTALL_COMMAND =
  "pnpm --filter @agentsales/media exec playwright install chromium";
export const CHROMIUM_INSTALL_HINT = `Instala el Chromium de Playwright: ${CHROMIUM_INSTALL_COMMAND}`;

/**
 * El Chromium que pide el Playwright instalado y si está (para `doctor`). Los renders sin ventana
 * usan el `chromium_headless_shell` de la misma revisión, así que se revisan los dos. Playwright se
 * carga recién al llamarla.
 */
export async function chromiumStatus(): Promise<{ path: string; installed: boolean }> {
  const { existsSync } = await import("node:fs");
  const { chromium } = await import("playwright");
  const path = chromium.executablePath();
  const revision = /[/\\]chromium-(\d+)[/\\]/.exec(path);
  const shellDir =
    revision === null
      ? null
      : path.slice(0, revision.index) +
        `${path[revision.index]}chromium_headless_shell-${revision[1]}`;
  const installed = existsSync(path) && (shellDir === null || existsSync(shellDir));
  return { path, installed };
}
