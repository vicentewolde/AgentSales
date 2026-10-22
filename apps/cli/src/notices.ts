import { colors } from "./colors.js";

/** Los avisos van a stderr (`console.error`), nunca a stdout. */
const toStderr = (text: string) => console.error(colors.yellow(`⚠ ${text}`));

/**
 * Avisos que no son la salida del comando (spec F9.5 §4.2): la CLI y el servidor son de versiones
 * distintas, o el servidor mandó un valor que esta CLI no conoce. Van a stderr, así no ensucian
 * stdout ni `--json`, y cada uno sale una vez por comando (cada comando es un proceso: lo que
 * espera con varias lecturas no lo repite).
 */
let write: (text: string) => void = toStderr;
const shown = new Set<string>();

/** Muestra el aviso `key` si todavía no salió en este comando. */
export function noticeOnce(key: string, text: string): void {
  if (shown.has(key)) return;
  shown.add(key);
  write(text);
}

/** Solo para tests: guarda los avisos (sin color) en vez de escribirlos, y olvida los ya mostrados. */
export function captureNotices(): string[] {
  const lines: string[] = [];
  shown.clear();
  write = (text) => lines.push(text);
  return lines;
}

/** Solo para tests: vuelve a escribir en stderr, y olvida los ya mostrados. */
export function resetNotices(): void {
  shown.clear();
  write = toStderr;
}
