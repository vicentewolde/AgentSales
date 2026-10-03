import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Los pesos de Inter que usan las plantillas (latín básico: incluye ñ, tildes y ü). */
const WEIGHTS = [400, 600, 800] as const;

/**
 * Inter (licencia OFL, `@fontsource/inter`) como `@font-face` con `data:`, sin red (spec F2 §4.2).
 * Los archivos se resuelven con `import.meta.resolve` (seguimiento de ADR-0010) y se leen una vez,
 * al crear las plantillas.
 */
export function interFontCss(): string {
  return WEIGHTS.map((weight) => {
    const url = import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`);
    const base64 = readFileSync(fileURLToPath(url)).toString("base64");
    return `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${base64}) format("woff2")}`;
  }).join("\n");
}
