import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  type CardBrand,
  type CardRenderer,
  type CardSpec,
  isAppError,
  POST_IMAGE_SIZES,
} from "@agentsales/core";
import sharp from "sharp";
import { throwIfAborted } from "./run.js";

// Las tarjetas de la marca de un post (F9.5-T25, ADR-0038 §1.1): el texto del post sobre el color y
// el logo de la marca, dibujado con sharp (Pango) con Inter (OFL, `@fontsource/inter`), sin red ni
// navegador. En Linux (la CI y el servidor) Pango usa el archivo de Inter; en macOS, la fuente del
// sistema (`USE_FONT_FILE`): el tamaño y el corte de líneas pueden variar un poco.

/** Versión del dibujo: cambiarla cambia los bytes (y el sha256) de las tarjetas. */
export const CARD_RENDER_VERSION = "1";

/** Inter en los pesos que usan las tarjetas (latín básico: ñ, tildes y ü). */
const fontFile = (weight: 400 | 600 | 800) =>
  fileURLToPath(import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`));

/**
 * En macOS, Pango dibuja con CoreText, que no lee `fontfile`, y registrar el archivo hace que
 * fontconfig recorra las fuentes del sistema (unos 30 s por proceso): ahí se usa la del sistema.
 */
const USE_FONT_FILE = process.platform !== "darwin";

/** Márgenes y medidas, en píxeles (las tarjetas miden 1080 de ancho). */
const LAYOUT = {
  pad: 96,
  /** La franja de abajo con el color secundario. */
  bar: 22,
  /** El logo arriba a la izquierda (portada y puntos) y al centro (cierre), dentro de un chip. */
  logoBox: { width: 240, height: 120 },
  closingLogoBox: { width: 560, height: 280 },
  chipPad: 22,
  /** Tamaños de letra de partida (se achican hasta caber) y el mínimo. */
  coverSize: { "4:5": 92, "9:16": 104 },
  pointSize: { "4:5": 66, "9:16": 74 },
  minSize: 30,
} as const;

type Rgb = { r: number; g: number; b: number };

/** `#RRGGBB` → RGB; un color que no calza (no debería: core lo valida) es gris oscuro. */
function rgbOf(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  const value = match?.[1] === undefined ? 0x1f2937 : Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Luminancia relativa (WCAG) de un color. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** El texto en blanco o casi negro, el que contraste más con el fondo. */
export function textColorOn(background: string): string {
  const l = luminance(rgbOf(background));
  // Contraste con blanco: 1,05 / (l + 0,05); con #111827 (l ≈ 0,0123): (l + 0,05) / 0,0623.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0623 ? "#FFFFFF" : "#111827";
}

/** Escapa un texto para el marcado de Pango. */
const escapeMarkup = (text: string) =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

type TextBlock = { input: Buffer; width: number; height: number };

/**
 * Un bloque de texto transparente que cabe en `width` × `maxHeight`: parte en `size` y se achica
 * hasta caber (o hasta `LAYOUT.minSize`).
 */
async function textBlock(
  text: string,
  options: {
    weight: 400 | 600 | 800;
    size: number;
    color: string;
    width: number;
    maxHeight: number;
    align: "left" | "centre";
    alpha?: number;
  },
): Promise<TextBlock> {
  let size = options.size;
  for (;;) {
    const alpha = options.alpha === undefined ? "" : ` fgalpha="${options.alpha}%"`;
    const markup = `<span font_family="Inter" font_weight="${options.weight}" size="${size * 1024}" foreground="${options.color}"${alpha}>${escapeMarkup(text)}</span>`;
    const { data, info } = await sharp({
      text: {
        text: markup,
        ...(USE_FONT_FILE ? { fontfile: fontFile(options.weight) } : {}),
        width: options.width,
        dpi: 72,
        rgba: true,
        wrap: "word-char",
        align: options.align,
        spacing: Math.round(size * 0.22),
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (info.height <= options.maxHeight || size <= LAYOUT.minSize) {
      return { input: data, width: info.width, height: info.height };
    }
    size = Math.max(LAYOUT.minSize, Math.floor(size * 0.88));
  }
}

/** El logo dentro de un chip blanco redondeado (se lee sobre cualquier color); `null` si no sirve. */
async function logoChip(
  logo: Uint8Array | null,
  box: { width: number; height: number },
): Promise<TextBlock | null> {
  if (logo === null) return null;
  try {
    const resized = await sharp(logo, { limitInputPixels: 4096 * 4096 })
      .resize({ width: box.width, height: box.height, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer({ resolveWithObject: true });
    const width = resized.info.width + LAYOUT.chipPad * 2;
    const height = resized.info.height + LAYOUT.chipPad * 2;
    const chip = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="24" fill="#FFFFFF"/></svg>`,
    );
    const input = await sharp(chip)
      .composite([{ input: resized.data, top: LAYOUT.chipPad, left: LAYOUT.chipPad }])
      .png()
      .toBuffer();
    return { input, width, height };
  } catch {
    // Un logo que no se lee: la tarjeta sale con el nombre de la marca.
    return null;
  }
}

/** Las capas de una tarjeta, en orden, con su posición. */
type Layer = { input: Buffer; top: number; left: number };

async function layersOf(
  card: CardSpec,
  brand: CardBrand,
  size: { width: number; height: number },
  format: "4:5" | "9:16",
): Promise<Layer[]> {
  const color = textColorOn(brand.primaryColor);
  const inner = size.width - LAYOUT.pad * 2;
  const bottom = size.height - LAYOUT.bar - LAYOUT.pad;
  const layers: Layer[] = [];

  if (card.role === "closing") {
    const logo = await logoChip(brand.logo, LAYOUT.closingLogoBox);
    const name = await textBlock(card.text, {
      weight: 800,
      size: 76,
      color,
      width: inner,
      maxHeight: 260,
      align: "centre",
    });
    const contact =
      card.detail === null
        ? null
        : await textBlock(card.detail, {
            weight: 600,
            size: 46,
            color,
            width: inner,
            maxHeight: 120,
            align: "centre",
          });
    const gap = 48;
    const total =
      (logo === null ? 0 : logo.height + gap) +
      name.height +
      (contact === null ? 0 : gap / 2 + contact.height);
    let top = Math.max(LAYOUT.pad, Math.round((size.height - LAYOUT.bar - total) / 2));
    for (const block of [logo, name, contact]) {
      if (block === null) continue;
      layers.push({ input: block.input, top, left: Math.round((size.width - block.width) / 2) });
      top += block.height + (block === logo ? gap : gap / 2);
    }
    return layers;
  }

  // Arriba: el logo (o el nombre de la marca) y, en un punto, «2/6» a la derecha.
  const logo = await logoChip(brand.logo, LAYOUT.logoBox);
  const header =
    logo ??
    (await textBlock(brand.brandName, {
      weight: 600,
      size: 34,
      color,
      width: Math.round(inner * 0.7),
      maxHeight: 90,
      align: "left",
    }));
  layers.push({ input: header.input, top: LAYOUT.pad, left: LAYOUT.pad });
  if (card.role === "point") {
    const counter = await textBlock(`${card.position}/${card.total}`, {
      weight: 600,
      size: 34,
      color,
      width: 200,
      maxHeight: 60,
      align: "left",
      alpha: 75,
    });
    layers.push({
      input: counter.input,
      top: LAYOUT.pad,
      left: size.width - LAYOUT.pad - counter.width,
    });
  }

  // El texto, centrado en lo que queda.
  const areaTop = LAYOUT.pad + header.height + 64;
  const body = await textBlock(card.text, {
    weight: card.role === "cover" ? 800 : 600,
    size: card.role === "cover" ? LAYOUT.coverSize[format] : LAYOUT.pointSize[format],
    color,
    width: inner,
    maxHeight: bottom - areaTop,
    align: "left",
  });
  const top = areaTop + Math.max(0, Math.round((bottom - areaTop - body.height) / 2));
  layers.push({ input: body.input, top, left: LAYOUT.pad });
  return layers;
}

/**
 * `CardRenderer` con sharp: fondo del color principal de la marca, una franja abajo con el
 * secundario, el logo en un chip blanco (o el nombre de la marca) y el texto en blanco o casi negro
 * según el contraste. JPEG sin metadatos, del tamaño exacto de la proporción.
 */
export function createCardRenderer(): CardRenderer {
  return {
    version: CARD_RENDER_VERSION,
    async render(card, { format, brand }, signal) {
      throwIfAborted(signal);
      const size = POST_IMAGE_SIZES[format];
      try {
        const bar = await sharp({
          create: {
            width: size.width,
            height: LAYOUT.bar,
            channels: 3,
            background: rgbOf(brand.secondaryColor),
          },
        })
          .png()
          .toBuffer();
        const layers = [
          ...(await layersOf(card, brand, size, format)),
          { input: bar, top: size.height - LAYOUT.bar, left: 0 },
        ];
        throwIfAborted(signal);
        const bytes = new Uint8Array(
          await sharp({
            create: {
              width: size.width,
              height: size.height,
              channels: 3,
              background: rgbOf(brand.primaryColor),
            },
          })
            .composite(layers)
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer(),
        );
        return {
          bytes,
          width: size.width,
          height: size.height,
          mime: "image/jpeg",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (cause) {
        if (isAppError(cause)) throw cause;
        throw new AppError("MEDIA_CARD_FAILED", "No se pudo dibujar una tarjeta", { cause });
      }
    },
  };
}
