import { type Operation, SLIDE_IMAGE_MIMES, type SlideImage } from "@agentsales/core";

/** Escapa un texto para HTML: los datos vienen del Excel, que escribe un tercero. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Un color `#RRGGBB` válido, o el de respaldo (un valor raro no puede romper el CSS). */
export const safeColor = (color: string, fallback: string) =>
  HEX.test(color) ? color.toUpperCase() : fallback;

const WHITE = "#FFFFFF";
const DARK = "#111827";

/** Luminancia relativa de un color `#RRGGBB` (WCAG). */
function luminance(color: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contraste WCAG entre dos colores (de 1 a 21). */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Blanco o casi negro: el de mayor contraste sobre `background`. */
export function readableOn(background: string): string {
  return contrast(WHITE, background) >= contrast(DARK, background) ? WHITE : DARK;
}

const IMAGE_MIMES: ReadonlySet<string> = new Set(SLIDE_IMAGE_MIMES);

/** Una imagen como `data:` (sin red); un mime que no es JPEG, PNG ni WebP no se incrusta. */
export function dataUrl(image: SlideImage): string | null {
  if (!IMAGE_MIMES.has(image.mime)) return null;
  return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export const OPERATION_LABEL: Readonly<Record<Operation, string>> = {
  sale: "Venta",
  rent: "Arriendo",
};

/** `Departamento · Ñuñoa`, escapado. */
export const place = (propertyType: string, comuna: string | null) =>
  escapeHtml(comuna === null ? propertyType : `${propertyType} · ${comuna}`);

/** El documento completo, con el tamaño exacto del render y la fuente incrustada. */
export function documentOf(options: {
  width: number;
  height: number;
  fontCss: string;
  css: string;
  body: string;
  transparent?: boolean;
}): string {
  const background = options.transparent ? "transparent" : "#000";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
${options.fontCss}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${options.width}px;height:${options.height}px;overflow:hidden;background:${background}}
body{font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
svg{flex:none}
${options.css}
</style></head>
<body>${options.body}</body></html>`;
}
