import type { Operation, SlideImage } from "@agentsales/core";

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

/** Blanco o casi negro, el que se lea mejor sobre `background` (luminancia relativa). */
export function readableOn(background: string): string {
  const channel = (offset: number) => {
    const value = Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "#111827" : "#FFFFFF";
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png"]);

/** Una imagen como `data:` (sin red); un mime que no es JPEG ni PNG no se incrusta. */
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
