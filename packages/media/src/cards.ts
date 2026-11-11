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

// Las tarjetas de la marca de un post (F9.5-T25, ADR-0038 §1.1): el texto del post sobre los
// colores y el logo de la marca, dibujado con sharp sin red ni navegador. Las formas (fondo con
// degradado, anillos, brillo, pie con el avance) son SVG; el texto se dibuja con bloques de Pango
// con Inter (OFL, `@fontsource/inter`), porque librsvg no carga la fuente desde un archivo. En Linux
// (la CI y el servidor) Pango usa el archivo de Inter; en macOS, la fuente del sistema
// (`USE_FONT_FILE`): el tamaño y el corte de líneas pueden variar un poco.

/** Versión del dibujo: cambiarla cambia los bytes (y el sha256) de las tarjetas. */
export const CARD_RENDER_VERSION = "2";

/** Inter en los pesos que usan las tarjetas (latín básico: ñ, tildes y ü). */
const fontFile = (weight: Weight) =>
  fileURLToPath(import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`));

/**
 * En macOS, Pango dibuja con CoreText, que no lee `fontfile`, y registrar el archivo hace que
 * fontconfig recorra las fuentes del sistema (unos 30 s por proceso): ahí se usa la del sistema.
 */
const USE_FONT_FILE = process.platform !== "darwin";

type Weight = 400 | 600 | 800;
type Format = "4:5" | "9:16";

/**
 * Medidas, en píxeles (las tarjetas miden 1080 de ancho). En 9:16 el margen de arriba y de abajo
 * es mayor: Instagram y TikTok tapan esas franjas con su interfaz al ver un reel.
 */
const LAYOUT = {
  /** Margen izquierdo y derecho. */
  pad: 88,
  /** Margen de arriba (donde empieza la cabecera) y de abajo (donde termina el pie). */
  top: { "4:5": 84, "9:16": 200 },
  bottom: { "4:5": 84, "9:16": 270 },
  /** Altura de la cabecera (el logo o el nombre) y del pie (contacto y avance). */
  headerHeight: 72,
  footerHeight: 40,
  /** Aire entre la cabecera, el cuerpo y la línea del pie. */
  gap: 56,
  /** Tamaños de letra de partida (se achican hasta caber) y el mínimo. */
  coverSize: { "4:5": 108, "9:16": 120 },
  pointSize: { "4:5": 70, "9:16": 76 },
  numberSize: { "4:5": 168, "9:16": 188 },
  minSize: 30,
  /** El logo de la cabecera cabe en este rectángulo (más el chip); el del cierre, en el grande. */
  logoBox: { width: 230, height: 56 },
  closingLogoBox: { width: 400, height: 150 },
} as const;

// ---------------------------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };

const WHITE = "#FFFFFF";
const INK = "#111827";

/** `#RRGGBB` → RGB; un color que no calza (no debería: core lo valida) es gris oscuro. */
function rgbOf(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  const value = match?.[1] === undefined ? 0x1f2937 : Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function hexOf({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/** Mezcla `a` con `b`: `t = 0` es `a` y `t = 1` es `b`. */
function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

/** Luminancia relativa (WCAG) de un color. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contraste WCAG entre dos colores (de 1 a 21). */
function contrast(a: string, b: string): number {
  const x = luminance(rgbOf(a));
  const y = luminance(rgbOf(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** El texto en blanco o casi negro, el que contraste más con el fondo. */
export function textColorOn(background: string): string {
  return contrast(WHITE, background) >= contrast(INK, background) ? WHITE : INK;
}

/** El contraste que se pide al texto de las tarjetas (WCAG AA para texto normal). */
const MIN_TEXT_CONTRAST = 4.5;
/** El que se pide a lo gráfico y al texto grande (WCAG AA para texto grande y componentes). */
const MIN_GRAPHIC_CONTRAST = 3;

export type CardPalette = {
  /** Los dos extremos del degradado del fondo (el color principal, un poco más claro y más hondo). */
  from: string;
  to: string;
  /** El texto. */
  text: string;
  /** El color de acento (el secundario de la marca, ajustado hasta que se vea sobre el fondo). */
  accent: string;
  /** El texto sobre el acento. */
  onAccent: string;
  /** Opacidad del brillo del acento (la mayor con que el texto aún contrasta bien). */
  glow: number;
};

/**
 * Los colores de una tarjeta a partir de los de la marca: un degradado suave del color principal,
 * el texto que contrasta y un acento visible. Con cualquier color de marca (claro, oscuro,
 * saturado o gris medio) el texto contrasta al menos 4,5:1 con todo el fondo, y el acento al menos
 * 3:1. Un color principal de tono medio, donde ni el blanco ni el negro alcanzan, se oscurece o
 * aclara lo justo.
 */
export function paletteOf(primaryColor: string, secondaryColor: string): CardPalette {
  const stops = (base: string, dark: boolean) =>
    dark
      ? { from: mix(base, WHITE, 0.08), to: mix(base, "#000000", 0.38) }
      : { from: mix(base, WHITE, 0.5), to: mix(base, "#000000", 0.08) };
  const worst = (base: string) => {
    const text = textColorOn(base);
    const { from, to } = stops(base, text === WHITE);
    return Math.min(contrast(text, base), contrast(text, from), contrast(text, to));
  };
  let base = hexOf(rgbOf(primaryColor));
  // Un tono medio: se mueve hacia el lado opuesto al texto hasta que alcance el contraste.
  for (let step = 0; step < 40 && worst(base) < MIN_TEXT_CONTRAST + 0.2; step++) {
    base = mix(base, textColorOn(base) === WHITE ? "#000000" : WHITE, 0.05);
  }
  const text = textColorOn(base);
  const { from, to } = stops(base, text === WHITE);

  // El acento: el secundario si se ve sobre todo el fondo; si no, se acerca al color del texto.
  const seen = (color: string) =>
    Math.min(contrast(color, from), contrast(color, base), contrast(color, to));
  let accent = hexOf(rgbOf(secondaryColor));
  for (let step = 0; step < 20 && seen(accent) < MIN_GRAPHIC_CONTRAST + 0.3; step++) {
    accent = mix(accent, text, 0.1);
  }

  // El brillo: se baja hasta que el texto siga contrastando donde el acento se mezcla con el fondo.
  let glow = 0.26;
  const lit = (alpha: number) =>
    Math.min(
      contrast(text, mix(from, accent, alpha)),
      contrast(text, mix(base, accent, alpha)),
      contrast(text, mix(to, accent, alpha)),
    );
  while (glow > 0 && lit(glow) < MIN_TEXT_CONTRAST) glow = Math.round((glow - 0.02) * 100) / 100;

  return { from, to, text, accent, onAccent: textColorOn(accent), glow: Math.max(0, glow) };
}

// ---------------------------------------------------------------------------------------------
// Texto (Pango)
// ---------------------------------------------------------------------------------------------

/** Escapa un texto para el marcado de Pango. */
const escapeMarkup = (text: string) =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

type Block = { input: Buffer; width: number; height: number };

/**
 * Un bloque de texto transparente que cabe en `width` × `maxHeight`: parte en `size` y se achica
 * hasta caber (o hasta `minSize`). `tracking` separa o junta las letras (en píxeles) y `leading`
 * suma o resta interlineado (como fracción del tamaño).
 */
async function textBlock(
  text: string,
  options: {
    weight: Weight;
    size: number;
    color: string;
    width: number;
    maxHeight: number;
    align: "left" | "centre";
    alpha?: number;
    tracking?: number;
    leading?: number;
    minSize?: number;
  },
): Promise<Block> {
  const minSize = options.minSize ?? LAYOUT.minSize;
  let size = options.size;
  for (;;) {
    const alpha = options.alpha === undefined ? "" : ` fgalpha="${options.alpha}%"`;
    const tracking =
      options.tracking === undefined || options.tracking === 0
        ? ""
        : ` letter_spacing="${Math.round(options.tracking * 1024)}"`;
    const markup = `<span font_family="Inter" font_weight="${options.weight}" size="${size * 1024}" foreground="${options.color}"${alpha}${tracking}>${escapeMarkup(text)}</span>`;
    const { data, info } = await sharp({
      text: {
        text: markup,
        ...(USE_FONT_FILE ? { fontfile: fontFile(options.weight) } : {}),
        width: options.width,
        dpi: 72,
        rgba: true,
        wrap: "word-char",
        align: options.align,
        spacing: Math.round(size * (options.leading ?? 0.18)),
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (info.height <= options.maxHeight || size <= minSize) {
      return { input: data, width: info.width, height: info.height };
    }
    size = Math.max(minSize, Math.floor(size * 0.92));
  }
}

// ---------------------------------------------------------------------------------------------
// Formas (SVG)
// ---------------------------------------------------------------------------------------------

type Size = { width: number; height: number };

const svg = (size: Size, body: string, defs = "") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${defs === "" ? "" : `<defs>${defs}</defs>`}${body}</svg>`,
  );

const num = (value: number) => Math.round(value * 10) / 10;

/**
 * Dónde van los anillos y el brillo en cada tarjeta, como fracción del ancho y del alto: rotan por
 * las esquinas con la posición, así que al pasar las tarjetas el dibujo "camina" y no se repite. El
 * cierre los centra.
 */
const ANCHORS: readonly (readonly [number, number])[] = [
  [0.94, 0.1],
  [0.06, 0.92],
  [0.96, 0.84],
  [0.04, 0.12],
];

function anchorOf(card: CardSpec, size: Size): { x: number; y: number } {
  if (card.role === "closing") return { x: size.width / 2, y: size.height * 0.4 };
  const [fx, fy] = ANCHORS[(card.position - 1) % ANCHORS.length] ?? [0.94, 0.1];
  return { x: size.width * fx, y: size.height * fy };
}

/** El fondo: degradado del color de la marca, un brillo del acento y anillos finos. */
async function backgroundOf(card: CardSpec, size: Size, palette: CardPalette): Promise<Buffer> {
  const { x, y } = anchorOf(card, size);
  const reach = size.width * (card.role === "closing" ? 0.78 : 0.7);
  const rings = (card.role === "closing" ? [250, 400, 560, 730, 920] : [230, 390, 560, 760]).map(
    (radius, index) =>
      `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="none" stroke="${palette.text}" stroke-opacity="${index === 0 ? 0.13 : 0.08}" stroke-width="2"/>`,
  );
  const defs = `<linearGradient id="bg" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/></linearGradient><radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${num(x)}" cy="${num(y)}" r="${num(reach)}"><stop offset="0" stop-color="${palette.accent}" stop-opacity="${palette.glow}"/><stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/></radialGradient>`;
  // Un disco pequeño del acento en el primer anillo, como una "órbita": le da un punto de foco.
  const dot =
    card.role === "closing"
      ? ""
      : `<circle cx="${num(x - 230 * Math.SQRT1_2)}" cy="${num(y + (y < size.height / 2 ? 1 : -1) * 230 * Math.SQRT1_2)}" r="11" fill="${palette.accent}"/>`;
  return sharp(
    svg(
      size,
      `<rect width="100%" height="100%" fill="url(#bg)"/><rect width="100%" height="100%" fill="url(#glow)"/>${rings.join("")}${dot}`,
      defs,
    ),
  )
    .png()
    .toBuffer();
}

/** La línea del pie y el avance: un segmento por tarjeta (los vistos, rellenos) y una flecha. */
function footerShapes(
  card: CardSpec,
  size: Size,
  palette: CardPalette,
  format: Format,
): { svg: Buffer; right: number } {
  const lineY = size.height - LAYOUT.bottom[format] - LAYOUT.footerHeight - 30;
  const rightEdge = size.width - LAYOUT.pad;
  const parts: string[] = [
    `<rect x="${LAYOUT.pad}" y="${lineY}" width="${size.width - LAYOUT.pad * 2}" height="2" rx="1" fill="${palette.text}" fill-opacity="0.16"/>`,
  ];
  let right = rightEdge;
  const midY = size.height - LAYOUT.bottom[format] - LAYOUT.footerHeight / 2;
  // La flecha de "sigue" solo en un carrusel (4:5) y mientras haya otra tarjeta.
  if (format === "4:5" && card.total > 1 && card.position < card.total) {
    const r = 26;
    const cx = rightEdge - r;
    parts.push(
      `<circle cx="${cx}" cy="${midY}" r="${r}" fill="${palette.accent}"/>`,
      `<path d="M${cx - 10} ${midY} H${cx + 9} M${cx + 1} ${midY - 9} L${cx + 10} ${midY} L${cx + 1} ${midY + 9}" fill="none" stroke="${palette.onAccent}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    right = cx - r - 28;
  }
  if (card.total > 1) {
    const total = Math.min(card.total, 12);
    const gap = 8;
    const width = Math.min(48, Math.floor(300 / total) - gap);
    const full = total * width + (total - 1) * gap;
    for (let index = 0; index < total; index++) {
      const done = index + 1 <= card.position;
      parts.push(
        `<rect x="${right - full + index * (width + gap)}" y="${midY - 3}" width="${width}" height="6" rx="3" fill="${done ? palette.accent : palette.text}" fill-opacity="${done ? 1 : 0.22}"/>`,
      );
    }
    right -= full + 32;
  }
  return { svg: svg(size, parts.join("")), right };
}

// ---------------------------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------------------------

/** ¿El logo es claro (blanco sobre transparente)? Entonces el chip es oscuro, no blanco. */
async function isLightLogo(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png)
    .resize({ width: 64, height: 64, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let weight = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = (data[i + 3] ?? 0) / 255;
    weight += alpha;
    sum += alpha * luminance({ r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 });
  }
  return weight > 0 && sum / weight > 0.75;
}

type LogoChip = Block & { shadow: Buffer; margin: number };

/**
 * El logo dentro de un chip redondeado con una sombra suave (se lee sobre cualquier color): blanco,
 * u oscuro si el logo es claro. `null` si el logo no se lee.
 */
async function logoChip(
  logo: Uint8Array | null,
  box: { width: number; height: number },
  padding: number,
  radius: number,
): Promise<LogoChip | null> {
  if (logo === null) return null;
  try {
    const resized = await sharp(logo, { limitInputPixels: 4096 * 4096 })
      .resize({ width: box.width, height: box.height, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer({ resolveWithObject: true });
    const width = resized.info.width + padding * 2;
    const height = resized.info.height + padding * 2;
    const fill = (await isLightLogo(resized.data)) ? INK : WHITE;
    const margin = 40;
    const chip = svg(
      { width, height },
      `<rect width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`,
    );
    const shadow = await sharp(
      svg(
        { width: width + margin * 2, height: height + margin * 2 },
        `<rect x="${margin}" y="${margin + 10}" width="${width}" height="${height}" rx="${radius}" fill="#000000" fill-opacity="0.28" filter="url(#blur)"/>`,
        `<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>`,
      ),
    )
      .png()
      .toBuffer();
    const input = await sharp(chip)
      .composite([{ input: resized.data, top: padding, left: padding }])
      .png()
      .toBuffer();
    return { input, width, height, shadow, margin };
  } catch {
    // Un logo que no se lee: la tarjeta sale con el nombre de la marca.
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------------------------

/** Las capas de una tarjeta, en orden, con su posición. */
type Layer = { input: Buffer; top: number; left: number };

/** La inicial de la marca, para el cierre de una marca sin logo. */
const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "";

/** Un rectángulo redondeado de un solo color (rayas y píldoras). */
const roundedBar = (width: number, height: number, color: string) =>
  sharp(
    svg(
      { width, height },
      `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${color}"/>`,
    ),
  )
    .png()
    .toBuffer();

async function closingLayers(
  card: CardSpec,
  brand: CardBrand,
  size: Size,
  format: Format,
  palette: CardPalette,
  areaTop: number,
  areaBottom: number,
): Promise<Layer[]> {
  const inner = size.width - LAYOUT.pad * 2;
  const gap = 44;
  const parts: (Block & { shadow?: Buffer; margin?: number })[] = [];
  // El logo en su chip o, sin logo, la inicial de la marca en un disco del acento.
  const logo = await logoChip(brand.logo, LAYOUT.closingLogoBox, 30, 36);
  if (logo !== null) {
    parts.push(logo);
  } else {
    const disc = 168;
    const letter = await textBlock(initialOf(brand.brandName), {
      weight: 800,
      size: 92,
      color: palette.onAccent,
      width: disc,
      maxHeight: disc,
      align: "centre",
      minSize: 40,
    });
    const mark = await sharp(
      svg(
        { width: disc, height: disc },
        `<circle cx="${disc / 2}" cy="${disc / 2}" r="${disc / 2}" fill="${palette.accent}"/>`,
      ),
    )
      .composite([
        {
          input: letter.input,
          top: Math.round((disc - letter.height) / 2),
          left: Math.round((disc - letter.width) / 2),
        },
      ])
      .png()
      .toBuffer();
    parts.push({ input: mark, width: disc, height: disc });
  }
  parts.push(
    await textBlock(card.text, {
      weight: 800,
      size: format === "4:5" ? 84 : 92,
      color: palette.text,
      width: inner,
      maxHeight: 300,
      align: "centre",
      tracking: -1.2,
      leading: -0.04,
    }),
  );
  parts.push({ input: await roundedBar(96, 8, palette.accent), width: 96, height: 8 });
  if (card.detail !== null) {
    // El contacto en una píldora del acento: la llamada a la acción, sin palabras de más.
    const handle = await textBlock(card.detail, {
      weight: 800,
      size: 46,
      color: palette.onAccent,
      width: inner - 160,
      maxHeight: 80,
      align: "centre",
      minSize: 26,
    });
    const padX = 52;
    const padY = 26;
    const pillW = handle.width + padX * 2;
    const pillH = handle.height + padY * 2;
    const pill = await sharp(await roundedBar(pillW, pillH, palette.accent))
      .composite([{ input: handle.input, top: padY, left: padX }])
      .png()
      .toBuffer();
    parts.push({ input: pill, width: pillW, height: pillH });
  }
  const total = parts.reduce((sum, part) => sum + part.height, 0) + gap * (parts.length - 1);
  let y = Math.max(areaTop, Math.round(areaTop + (areaBottom - areaTop - total) * 0.46));
  const layers: Layer[] = [];
  for (const part of parts) {
    const left = Math.round((size.width - part.width) / 2);
    if (part.shadow !== undefined && part.margin !== undefined) {
      layers.push({ input: part.shadow, top: y - part.margin, left: left - part.margin });
    }
    layers.push({ input: part.input, top: y, left });
    y += part.height + gap;
  }
  return layers;
}

async function layersOf(
  card: CardSpec,
  brand: CardBrand,
  size: Size,
  format: Format,
  palette: CardPalette,
): Promise<Layer[]> {
  const inner = size.width - LAYOUT.pad * 2;
  const layers: Layer[] = [];
  const top = LAYOUT.top[format];

  // El pie: el contacto a la izquierda (si hay) y, a la derecha, el avance.
  const footer = footerShapes(card, size, palette, format);
  layers.push({ input: footer.svg, top: 0, left: 0 });
  const footerTop = size.height - LAYOUT.bottom[format] - LAYOUT.footerHeight;
  const lineY = footerTop - 30;
  if (card.role !== "closing" && card.detail !== null) {
    const contact = await textBlock(card.detail, {
      weight: 600,
      size: 32,
      color: palette.text,
      width: Math.max(160, footer.right - LAYOUT.pad),
      maxHeight: LAYOUT.footerHeight + 10,
      align: "left",
      alpha: 82,
      minSize: 22,
    });
    layers.push({
      input: contact.input,
      top: footerTop + Math.round((LAYOUT.footerHeight - contact.height) / 2),
      left: LAYOUT.pad,
    });
  }

  if (card.role === "closing") {
    layers.push(
      ...(await closingLayers(card, brand, size, format, palette, top, lineY - LAYOUT.gap / 2)),
    );
    return layers;
  }

  // Arriba: el logo en su chip o, sin logo, el nombre de la marca con un punto de acento.
  const logo = await logoChip(brand.logo, LAYOUT.logoBox, 14, 18);
  if (logo !== null) {
    layers.push({ input: logo.shadow, top: top - logo.margin, left: LAYOUT.pad - logo.margin });
    layers.push({ input: logo.input, top, left: LAYOUT.pad });
  } else {
    const dot = 16;
    const name = await textBlock(brand.brandName, {
      weight: 800,
      size: 42,
      color: palette.text,
      width: Math.round(inner * 0.7),
      maxHeight: LAYOUT.headerHeight,
      align: "left",
      tracking: -0.4,
      minSize: 24,
    });
    const nameTop = top + Math.round((LAYOUT.headerHeight - name.height) / 2);
    layers.push({
      input: Buffer.from(
        await sharp(
          svg(
            { width: dot, height: dot },
            `<circle cx="${dot / 2}" cy="${dot / 2}" r="${dot / 2}" fill="${palette.accent}"/>`,
          ),
        )
          .png()
          .toBuffer(),
      ),
      top: nameTop + Math.round(name.height / 2 - dot / 2),
      left: LAYOUT.pad,
    });
    layers.push({ input: name.input, top: nameTop, left: LAYOUT.pad + dot + 16 });
  }

  const areaTop = top + LAYOUT.headerHeight + LAYOUT.gap;
  const areaHeight = lineY - LAYOUT.gap - areaTop;

  if (card.role === "cover") {
    // El título grande, anclado un poco bajo el centro, con la raya de acento encima.
    const barGap = 44;
    const title = await textBlock(card.text, {
      weight: 800,
      size: LAYOUT.coverSize[format],
      color: palette.text,
      width: inner,
      maxHeight: areaHeight - 10 - barGap,
      align: "left",
      tracking: -2,
      leading: -0.08,
    });
    const group = 10 + barGap + title.height;
    const y = areaTop + Math.max(0, Math.round((areaHeight - group) * 0.62));
    layers.push({ input: await roundedBar(84, 10, palette.accent), top: y, left: LAYOUT.pad });
    layers.push({ input: title.input, top: y + 10 + barGap, left: LAYOUT.pad });
    return layers;
  }

  // Un punto: el número grande en el acento y debajo el texto, cómodo de leer.
  const number = await textBlock(String(card.position - 1).padStart(2, "0"), {
    weight: 800,
    size: LAYOUT.numberSize[format],
    color: palette.accent,
    width: inner,
    maxHeight: 260,
    align: "left",
    tracking: -4,
    leading: 0,
  });
  const gapAfter = 52;
  const body = await textBlock(card.text, {
    weight: 600,
    size: LAYOUT.pointSize[format],
    color: palette.text,
    width: inner,
    maxHeight: areaHeight - number.height - gapAfter,
    align: "left",
    tracking: -0.6,
    leading: 0.06,
  });
  const group = number.height + gapAfter + body.height;
  const y = areaTop + Math.max(0, Math.round((areaHeight - group) * 0.45));
  layers.push({ input: number.input, top: y, left: LAYOUT.pad - 4 });
  layers.push({ input: body.input, top: y + number.height + gapAfter, left: LAYOUT.pad });
  return layers;
}

/**
 * `CardRenderer` con sharp: fondo con degradado del color principal de la marca, anillos y un
 * brillo del color secundario, la cabecera con el logo (en un chip) o el nombre de la marca, el
 * texto con una jerarquía clara (portada con título grande, puntos con número, cierre con la marca
 * y su contacto) y un pie con el contacto y el avance. El texto es blanco o casi negro según el
 * contraste. JPEG sin metadatos, del tamaño exacto de la proporción.
 */
export function createCardRenderer(): CardRenderer {
  return {
    version: CARD_RENDER_VERSION,
    async render(card, { format, brand }, signal) {
      throwIfAborted(signal);
      const size = POST_IMAGE_SIZES[format];
      try {
        const palette = paletteOf(brand.primaryColor, brand.secondaryColor);
        const background = await backgroundOf(card, size, palette);
        const layers = await layersOf(card, brand, size, format, palette);
        throwIfAborted(signal);
        const bytes = new Uint8Array(
          await sharp(background)
            .composite(layers)
            .flatten({ background: "#000000" })
            .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
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
