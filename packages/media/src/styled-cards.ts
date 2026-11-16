import {
  type CardBrand,
  type CardBrandStyle,
  type CardSpec,
  type CardStyle,
  type CardTheme,
  POST_IMAGE_SIZES,
  type PostImageFormat,
  themeOfPost,
} from "@agentsales/core";
import sharp from "sharp";
import { type ResolvedFont, resolveFont } from "./fonts.js";

// Las láminas con el estilo de la marca (spec F9.7 B6, ADR-0043 punto 5): el manual de la marca
// (`CardStyle`) dibujado con sharp + SVG, sin navegador, en dos composiciones:
// - «Anuncio» (`announce`): el logo y el nombre arriba, un objeto central (una medalla con el logo
//   o, en un punto, su número), el titular (la segunda mitad con el degradado de la marca), el
//   subtítulo y el contacto abajo.
// - «Explicar» (`explain`): el logo arriba, el titular y el subtítulo, y una grilla de tarjetas
//   (una héroe ancha, dos medianas y una ancha) con sus etiquetas.
// En 4:5, 1:1 y 9:16 (con la zona segura de los reels). El texto se achica hasta caber; si ni así
// cabe, la lámina lo dice (`fits: false`) y el worker lo informa.

type Size = { width: number; height: number };
type Block = { input: Buffer; width: number; height: number; fits: boolean };
type Layer = { input: Buffer; top: number; left: number };

/** Lo que dibuja la lámina y si todo el texto cupo. */
export type StyledCardResult = { png: Buffer; fits: boolean };

const num = (value: number) => Math.round(value * 10) / 10;

const svg = (size: Size, body: string, defs = "") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${defs === "" ? "" : `<defs>${defs}</defs>`}${body}</svg>`,
  );

const escapeMarkup = (text: string) =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** Los márgenes de cada proporción: en 9:16, la zona segura de Instagram y TikTok. */
function marginsOf(style: CardStyle, format: PostImageFormat) {
  const { side, top, bottom } = style.margins;
  if (format === "9:16") return { side, top: Math.max(top, 220), bottom: Math.max(bottom, 290) };
  // En 1:1 el perfil de Instagram muestra el centro (3:4, el 75 % del ancho): el texto queda dentro.
  if (format === "1:1") {
    return {
      side: Math.max(side, 135),
      top: Math.round(top * 0.7),
      bottom: Math.round(bottom * 0.7),
    };
  }
  return { side, top, bottom };
}

/**
 * Un bloque de texto transparente que cabe en `width` × `maxHeight`: parte en `size` y se achica
 * hasta caber (o hasta `minSize`; entonces `fits: false`).
 */
async function textBlock(
  text: string,
  options: {
    font: ResolvedFont;
    weight: number;
    size: number;
    color: string;
    width: number;
    maxHeight: number;
    align: "left" | "centre";
    tracking?: number;
    leading?: number;
    minSize?: number;
    /** Partes del texto con su color; `null` = invisible (ocupa su lugar pero no se pinta). */
    spans?: { text: string; color: string | null }[];
  },
): Promise<Block> {
  const minSize = options.minSize ?? 22;
  let size = options.size;
  for (;;) {
    const tracking =
      options.tracking === undefined || options.tracking === 0
        ? ""
        : ` letter_spacing="${Math.round(options.tracking * size * 1024)}"`;
    const inner =
      options.spans === undefined
        ? escapeMarkup(text)
        : options.spans
            .map((span) =>
              span.color === null
                ? `<span alpha="1">${escapeMarkup(span.text)}</span>`
                : `<span foreground="${span.color}">${escapeMarkup(span.text)}</span>`,
            )
            .join("");
    const markup = `<span font_family="${options.font.family}" font_weight="${options.weight}" size="${Math.round(size * 1024)}" foreground="${options.color}"${tracking}>${inner}</span>`;
    const { data, info } = await sharp({
      text: {
        text: markup,
        ...(options.font.file === null ? {} : { fontfile: options.font.file }),
        width: options.width,
        dpi: 72,
        rgba: true,
        wrap: "word",
        align: options.align,
        spacing: Math.round(size * (options.leading ?? 0.12)),
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    const fits = info.height <= options.maxHeight && info.width <= options.width + 2;
    if (fits || size <= minSize) {
      return { input: data, width: info.width, height: info.height, fits };
    }
    size = Math.max(minSize, Math.floor(size * 0.92));
  }
}

/** Pinta un bloque de texto blanco con un degradado horizontal (la frase destacada del titular). */
async function gradientFill(block: Block, from: string, to: string): Promise<Block> {
  const size = { width: block.width, height: block.height };
  // El degradado va de la primera a la última columna con tinta (no de todo el ancho del bloque).
  const { data, info } = await sharp(block.input)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let first = info.width;
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    if ((data[i] ?? 0) > 16) {
      const x = i % info.width;
      if (x < first) first = x;
      if (x > last) last = x;
    }
  }
  if (last <= first) {
    first = 0;
    last = info.width;
  }
  const fill = await sharp(
    svg(
      size,
      `<rect width="100%" height="100%" fill="url(#g)"/>`,
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${first}" y1="0" x2="${last}" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
    ),
  )
    .composite([{ input: block.input, blend: "dest-in" }])
    .png()
    .toBuffer();
  return { ...block, input: fill };
}

/** El fondo del tema, con un brillo detrás del objeto central si el tema lo tiene. */
async function backgroundOf(theme: CardTheme, size: Size, glowAt: { x: number; y: number } | null) {
  const bg = theme.background;
  let defs = "";
  let fill: string;
  if (bg.kind === "solid") fill = bg.color;
  else if (bg.kind === "linear") {
    const radians = ((bg.angle - 90) * Math.PI) / 180;
    const x = Math.cos(radians) / 2;
    const y = Math.sin(radians) / 2;
    defs += `<linearGradient id="bg" x1="${num(0.5 - x)}" y1="${num(0.5 - y)}" x2="${num(0.5 + x)}" y2="${num(0.5 + y)}"><stop offset="0" stop-color="${bg.from}"/><stop offset="1" stop-color="${bg.to}"/></linearGradient>`;
    fill = "url(#bg)";
  } else {
    defs += `<radialGradient id="bg" cx="0.5" cy="0.3" r="0.9"><stop offset="0" stop-color="${bg.from}"/>${bg.via === null ? "" : `<stop offset="0.55" stop-color="${bg.via}"/>`}<stop offset="1" stop-color="${bg.to}"/></radialGradient>`;
    fill = "url(#bg)";
  }
  let glow = "";
  if (theme.glow !== null && glowAt !== null) {
    const r = size.width * 0.5;
    defs += `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${num(glowAt.x)}" cy="${num(glowAt.y)}" r="${num(r)}"><stop offset="0" stop-color="${theme.glow.color}" stop-opacity="${theme.glow.opacity}"/><stop offset="1" stop-color="${theme.glow.color}" stop-opacity="0"/></radialGradient>`;
    glow = `<rect width="100%" height="100%" fill="url(#glow)"/>`;
  }
  return sharp(svg(size, `<rect width="100%" height="100%" fill="${fill}"/>${glow}`, defs))
    .png()
    .toBuffer();
}

/** El logo del estilo en un color (SVG con `currentColor`) o el PNG, de `height` de alto. */
async function logoOf(style: CardStyle, color: string, height: number): Promise<Block | null> {
  if (style.logo === null) return null;
  try {
    const source =
      style.logo.kind === "svg"
        ? Buffer.from(style.logo.svg.replace(/currentColor/gu, color))
        : Buffer.from(style.logo.base64, "base64");
    const { data, info } = await sharp(source, { density: 300, limitInputPixels: 4096 * 4096 })
      .resize({ height, fit: "inside" })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { input: data, width: info.width, height: info.height, fits: true };
  } catch {
    return null;
  }
}

/** Un rectángulo redondeado de un color. */
const roundedRect = (size: Size, radius: number, color: string) =>
  sharp(
    svg(
      size,
      `<rect width="${size.width}" height="${size.height}" rx="${radius}" fill="${color}"/>`,
    ),
  )
    .png()
    .toBuffer();

/** La medalla de «Anuncio»: aro metálico, disco con degradado y una sombra suave. */
async function medalOf(theme: CardTheme, diameter: number): Promise<Block> {
  const margin = Math.round(diameter * 0.35);
  const full = diameter + margin * 2;
  const c = full / 2;
  const ring = diameter / 2;
  const disc = ring * 0.835;
  const [r1, r2] = theme.medal.ring;
  const [d1, d2] = theme.medal.disc;
  const defs = `<linearGradient id="ring" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="${r1}"/><stop offset="0.35" stop-color="${r2}"/><stop offset="0.55" stop-color="${r1}"/><stop offset="1" stop-color="${r2}"/></linearGradient><radialGradient id="disc" cx="0.5" cy="0.22" r="0.85"><stop offset="0" stop-color="${d1}"/><stop offset="1" stop-color="${d2}"/></radialGradient><filter id="blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${num(diameter * 0.09)}"/></filter>`;
  const body = `<circle cx="${c}" cy="${num(c + diameter * 0.1)}" r="${num(ring * 0.95)}" fill="#000000" fill-opacity="0.55" filter="url(#blur)"/><circle cx="${c}" cy="${c}" r="${num(ring)}" fill="url(#ring)"/><circle cx="${c}" cy="${c}" r="${num(disc)}" fill="url(#disc)"/>`;
  const input = await sharp(svg({ width: full, height: full }, body, defs))
    .png()
    .toBuffer();
  return { input, width: full, height: full, fits: true };
}

/** La cabecera: el logo y, si el estilo lo pide, el nombre de la marca, centrados. */
async function headerOf(
  style: CardStyle,
  theme: CardTheme,
  brandName: string,
  width: number,
  scale: number,
): Promise<Block> {
  const logo = await logoOf(style, theme.text, Math.round(40 * scale));
  const name = style.showBrandName
    ? await textBlock(brandName, {
        font: resolveFont(style.fonts.headline.family, 600),
        weight: 600,
        size: Math.round(34 * scale),
        color: theme.text,
        width: Math.round(width * 0.8),
        maxHeight: Math.round(60 * scale),
        align: "left",
        tracking: -0.02,
      })
    : null;
  const gap = Math.round(16 * scale);
  const parts = [logo, name].filter((part): part is Block => part !== null);
  const total = parts.reduce((sum, part) => sum + part.width, 0) + gap * (parts.length - 1);
  const height = Math.max(1, ...parts.map((part) => part.height));
  const layers: Layer[] = [];
  let x = 0;
  for (const part of parts) {
    layers.push({ input: part.input, top: Math.round((height - part.height) / 2), left: x });
    x += part.width + gap;
  }
  const input = await sharp({
    create: {
      width: Math.max(1, total),
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
  return { input, width: Math.max(1, total), height, fits: name?.fits ?? true };
}

/**
 * El titular centrado: la primera parte en el color del texto y la última con el degradado.
 * Se dibuja en UNA sola pasada de texto (el interlineado es el mismo en todas las líneas, aunque
 * una parte lleve degradado): una capa con la parte normal visible y otra, idéntica, con solo la
 * parte destacada, que se pinta con el degradado y se pone encima.
 */
async function headlineOf(
  text: string,
  style: CardStyle,
  theme: CardTheme,
  options: { width: number; maxHeight: number; size: number; align: "left" | "centre" },
): Promise<Block> {
  const words = text.trim().split(/\s+/u);
  const highlightCount =
    theme.headlineGradient === null
      ? 0
      : words.length <= 2
        ? words.length
        : Math.min(3, Math.ceil(words.length / 2));
  const lead = words.slice(0, words.length - highlightCount).join(" ");
  const highlight = words.slice(words.length - highlightCount).join(" ");
  const font = resolveFont(style.fonts.headline.family, style.fonts.headline.weight);
  const common = {
    font,
    weight: style.fonts.headline.weight,
    width: options.width,
    align: options.align,
    tracking: style.fonts.headline.tracking,
    leading: -0.02,
    maxHeight: options.maxHeight,
    minSize: 40,
  };
  const leadText = highlight === "" ? lead : `${lead} `;
  // El tamaño que cabe con el texto completo (se achica junto).
  let size = options.size;
  for (;;) {
    const probe = await textBlock(text, { ...common, size, color: theme.text, minSize: size });
    if (probe.fits || size <= 40) break;
    size = Math.max(40, Math.floor(size * 0.92));
  }
  // Líneas parejas: se angosta el ancho mientras el titular siga con las mismas líneas (así no
  // queda una palabra sola abajo).
  const full = await textBlock(text, { ...common, size, color: theme.text, minSize: size });
  let wrapWidth = options.width;
  for (let step = 1; step <= 8; step++) {
    const narrower = Math.round(options.width * (1 - step * 0.05));
    const probe = await textBlock(text, {
      ...common,
      size,
      width: narrower,
      color: theme.text,
      minSize: size,
    });
    if (probe.height !== full.height || !probe.fits) break;
    wrapWidth = narrower;
  }
  common.width = wrapWidth;
  // Sin parte destacada (o sin degradado en el tema): un solo bloque, todo en el color del texto.
  if (highlight === "" || theme.headlineGradient === null) {
    return textBlock(text, { ...common, size, minSize: size, color: theme.text });
  }
  const spans = (visible: "lead" | "highlight") => [
    ...(lead === "" ? [] : [{ text: leadText, color: visible === "lead" ? theme.text : null }]),
    { text: highlight, color: visible === "highlight" ? "#FFFFFF" : null },
  ];
  const lower = await textBlock(text, {
    ...common,
    size,
    minSize: size,
    color: theme.text,
    spans: spans("lead"),
  });
  const upper = await textBlock(text, {
    ...common,
    size,
    minSize: size,
    color: "#FFFFFF",
    spans: spans("highlight"),
  });
  const painted = await gradientFill(upper, theme.headlineGradient.from, theme.headlineGradient.to);
  const width = Math.max(lower.width, painted.width);
  const height = Math.max(lower.height, painted.height);
  const input = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: lower.input, top: 0, left: Math.round((width - lower.width) / 2) },
      { input: painted.input, top: 0, left: Math.round((width - painted.width) / 2) },
    ])
    .png()
    .toBuffer();
  return { input, width, height, fits: lower.fits && painted.fits };
}

/** El subtítulo y el pie, en el cuerpo de texto del estilo. */
function bodyText(
  text: string,
  style: CardStyle,
  color: string,
  options: {
    width: number;
    maxHeight: number;
    size: number;
    align: "left" | "centre";
    weight?: number;
  },
) {
  const weight = options.weight ?? style.fonts.body.weight;
  return textBlock(text, {
    font: resolveFont(style.fonts.body.family, weight),
    weight,
    size: options.size,
    color,
    width: options.width,
    maxHeight: options.maxHeight,
    align: options.align,
    leading: 0.18,
  });
}

/** El contenido de una tarjeta de la grilla (etiqueta y título), medido a un tamaño de letra. */
type CardContent = { label: Block; title: Block; height: number };

async function cardContent(
  item: { label: string; text: string },
  style: CardStyle,
  colors: { text: string; label: string },
  width: number,
  titleSize: number,
  pad: number,
): Promise<CardContent> {
  const inner = width - pad * 2;
  const label = await bodyText(item.label, style, colors.label, {
    width: inner,
    maxHeight: 60,
    size: Math.max(20, Math.round(titleSize * 0.58)),
    align: "left",
    weight: 600,
  });
  const title = await textBlock(item.text, {
    font: resolveFont(style.fonts.headline.family, style.fonts.headline.weight),
    weight: style.fonts.headline.weight,
    size: titleSize,
    color: colors.text,
    width: inner,
    maxHeight: 10_000,
    align: "left",
    tracking: -0.01,
    leading: -0.02,
    minSize: titleSize,
  });
  return {
    label,
    title,
    height: pad * 2 + label.height + Math.round(titleSize * 0.3) + title.height,
  };
}

/** Una tarjeta de la grilla: la etiqueta arriba y el título debajo, a la izquierda. */
async function gridCard(
  content: CardContent,
  style: CardStyle,
  background: string,
  size: Size,
  top: number,
  titleSize: number,
  left: number,
): Promise<Buffer> {
  // El contenido va centrado en el alto de la tarjeta (`top`), a la izquierda (`left`).
  return sharp(await roundedRect(size, style.cardRadius, background))
    .composite([
      { input: content.label.input, top, left },
      {
        input: content.title.input,
        top: top + content.label.height + Math.round(titleSize * 0.3),
        left,
      },
    ])
    .png()
    .toBuffer();
}

/** «Anuncio»: logo, objeto central, titular con la frase destacada, subtítulo y contacto. */
async function announceLayers(
  card: CardSpec,
  style: CardStyle,
  theme: CardTheme,
  size: Size,
  format: PostImageFormat,
  header: Block,
  footer: Block | null,
): Promise<{ layers: Layer[]; fits: boolean; glow: { x: number; y: number } }> {
  const m = marginsOf(style, format);
  const inner = size.width - m.side * 2;
  const short = format === "1:1";
  const medalSize = Math.round((short ? 230 : 340) * (card.role === "point" ? 0.8 : 1));
  const medal = await medalOf(theme, medalSize);
  // Dentro de la medalla: el logo (portada y cierre) o el número del punto.
  const inside =
    card.role === "point"
      ? await textBlock(String(card.position - 1).padStart(2, "0"), {
          font: resolveFont(style.fonts.headline.family, 700),
          weight: 700,
          size: Math.round(medalSize * 0.36),
          color: "#FFFFFF",
          width: medalSize,
          maxHeight: medalSize,
          align: "centre",
          tracking: -0.02,
        })
      : await logoOf(style, "#FFFFFF", Math.round(medalSize * 0.33));
  const medalLayers: Layer[] = [];
  if (inside !== null) {
    medalLayers.push({
      input: inside.input,
      top: Math.round((medal.height - inside.height) / 2),
      left: Math.round((medal.width - inside.width) / 2),
    });
  }
  const medalBlock: Block = {
    ...medal,
    input: await sharp(medal.input).composite(medalLayers).png().toBuffer(),
  };
  const headline = await headlineOf(card.text, style, theme, {
    width: inner,
    maxHeight: short ? 260 : format === "9:16" ? 420 : 330,
    size: short ? 84 : 106,
    align: "centre",
  });
  const subtitleText = card.role === "closing" ? (card.detail ?? "") : (card.subtitle ?? "");
  const subtitle =
    subtitleText === ""
      ? null
      : await bodyText(subtitleText, style, theme.secondary, {
          width: Math.round(inner * 0.82),
          maxHeight: short ? 110 : 150,
          size: short ? 34 : 40,
          align: "centre",
        });
  // El espacio libre es el que queda entre la cabecera y el pie; el bloque visible (medalla,
  // titular y subtítulo) se centra ahí, con el mismo aire arriba y abajo. La medalla trae un
  // margen transparente (para su sombra) que no cuenta como aire ni como contenido.
  const areaTop = m.top + header.height;
  const areaBottom = size.height - m.bottom - (footer === null ? 0 : footer.height);
  const inset = Math.round(medalSize * 0.35);
  const visibleGap = short ? 44 : 56;
  const blocks = [
    { block: medalBlock, gapAfter: visibleGap - inset },
    { block: headline, gapAfter: subtitle === null ? 0 : short ? 30 : 40 },
    ...(subtitle === null ? [] : [{ block: subtitle, gapAfter: 0 }]),
  ];
  const used = blocks.reduce((sum, item) => sum + item.block.height + item.gapAfter, 0) - inset;
  const spare = areaBottom - areaTop - used;
  let y = areaTop + Math.round(Math.max(0, spare) / 2) - inset;
  const placed: Layer[] = [];
  for (const item of blocks) {
    placed.push({
      input: item.block.input,
      top: y,
      left: Math.round((size.width - item.block.width) / 2),
    });
    y += item.block.height + item.gapAfter;
  }
  const medalTop = placed[0]?.top ?? areaTop;
  return {
    layers: placed,
    // Al menos 40 px de aire arriba y abajo del bloque.
    fits: headline.fits && (subtitle?.fits ?? true) && spare >= 80,
    glow: { x: size.width / 2, y: medalTop + medal.height / 2 },
  };
}

/** «Explicar»: titular y subtítulo arriba y una grilla de tarjetas. */
async function explainLayers(
  card: CardSpec,
  style: CardStyle,
  theme: CardTheme,
  size: Size,
  format: PostImageFormat,
  header: Block,
  footer: Block | null,
): Promise<{ layers: Layer[]; fits: boolean }> {
  const m = marginsOf(style, format);
  const inner = size.width - m.side * 2;
  const short = format === "1:1";
  const headline = await headlineOf(card.text, style, theme, {
    width: inner,
    maxHeight: short ? 190 : 260,
    size: short ? 92 : 112,
    align: "centre",
  });
  const subtitleText = card.role === "closing" ? (card.detail ?? "") : (card.subtitle ?? "");
  const subtitle =
    subtitleText === "" || card.role === "point"
      ? null
      : await bodyText(subtitleText, style, theme.secondary, {
          width: Math.round(inner * 0.82),
          maxHeight: short ? 100 : 130,
          size: short ? 34 : 40,
          align: "centre",
        });
  const gap = 22;
  const top = m.top + header.height + (short ? 64 : 70);
  const layers: Layer[] = [
    { input: headline.input, top, left: Math.round((size.width - headline.width) / 2) },
  ];
  let y = top + headline.height + 30;
  if (subtitle !== null) {
    layers.push({
      input: subtitle.input,
      top: y,
      left: Math.round((size.width - subtitle.width) / 2),
    });
    y += subtitle.height;
  }
  let fits = headline.fits && (subtitle?.fits ?? true);
  y += short ? 30 : 64;
  const bottom = size.height - m.bottom - (footer === null ? 0 : footer.height + 34);
  const available = bottom - y;
  // Las tarjetas: en un punto, una héroe con su subtítulo; en la portada, los puntos en grilla.
  const items: { label: string; text: string }[] =
    card.role === "point"
      ? [{ label: String(card.position - 1).padStart(2, "0"), text: card.subtitle ?? "" }].filter(
          (item) => item.text !== "",
        )
      : (card.items ?? []).slice(0, short ? 3 : 4);
  if (items.length === 0 || available < 120) return { layers, fits };
  const rows: { items: typeof items; wide: boolean }[] = [];
  const [first, ...rest] = items;
  if (first !== undefined) rows.push({ items: [first], wide: true });
  if (rest.length >= 2) rows.push({ items: rest.slice(0, 2), wide: false });
  else if (rest.length === 1) rows.push({ items: rest, wide: true });
  if (rest.length >= 3) rows.push({ items: rest.slice(2, 3), wide: true });
  const colorsOf = (index: number) =>
    index === 0
      ? { background: theme.hero.background, text: theme.hero.text, label: theme.hero.label }
      : theme.card;
  const widthOf = (row: (typeof rows)[number]) =>
    row.wide ? inner : Math.floor((inner - gap) / 2);
  // Todas las tarjetas con el mismo tamaño de letra. Primero se achica hasta que la grilla cabe;
  // si sobra alto (un solo punto o pocos), se agranda hasta un tope para llenar mejor el lienzo.
  const measureAt = async (titleSize: number) => {
    const pad = Math.round(Math.max(26, titleSize * 0.95));
    const rowsMeasured: { contents: CardContent[]; height: number }[] = [];
    for (const [index, row] of rows.entries()) {
      const contents: CardContent[] = [];
      for (const item of row.items) {
        contents.push(
          await cardContent(item, style, colorsOf(index), widthOf(row), titleSize, pad),
        );
      }
      rowsMeasured.push({
        contents,
        height: Math.max(...contents.map((content) => content.height)),
      });
    }
    const total = rowsMeasured.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
    return { titleSize, pad, rows: rowsMeasured, total };
  };
  const start = card.role === "point" ? (short ? 50 : 60) : short ? 36 : 42;
  const tall = format === "9:16";
  const largest = card.role === "point" ? (short ? 72 : 92) : short ? 46 : tall ? 70 : 60;
  let measured = await measureAt(start);
  while (measured.total > available && measured.titleSize > 24) {
    measured = await measureAt(Math.floor(measured.titleSize * 0.9));
  }
  fits &&= measured.total <= available;
  // Agrandar mientras quepa con aire (el 85 % del espacio libre), hasta el tope.
  while (measured.total <= available && measured.titleSize < largest) {
    const bigger = await measureAt(Math.min(largest, Math.round(measured.titleSize * 1.12)));
    if (bigger.total > available * 0.85) break;
    measured = bigger;
  }
  const { titleSize, pad } = measured;
  // Lo que sobra: una parte alarga las tarjetas (repartida entre las filas) y el resto queda
  // alrededor, con el grupo un poco arriba del centro del espacio entre el titular y el pie.
  const spare = Math.max(0, available - measured.total);
  const grow = Math.round((spare * (rows.length === 1 ? 0.5 : 0.45)) / rows.length);
  const groupHeight = measured.total + grow * rows.length;
  y += Math.max(0, Math.round((available - groupHeight) * 0.45));
  for (const [index, row] of rows.entries()) {
    const measuredRow = measured.rows[index];
    const height = (measuredRow?.height ?? 0) + grow;
    let x = m.side;
    for (const content of measuredRow?.contents ?? []) {
      const width = widthOf(row);
      const input = await gridCard(
        content,
        style,
        colorsOf(index).background,
        { width, height },
        pad + Math.round((height - content.height) / 2),
        titleSize,
        pad,
      );
      layers.push({ input, top: y, left: x });
      x += width + gap;
    }
    y += height + gap;
  }
  return { layers, fits };
}

/**
 * La lámina ancha (16:9, para X y LinkedIn): el logo arriba a la izquierda, el titular y el
 * subtítulo en la columna izquierda y, a la derecha, la medalla («Anuncio») o la grilla de
 * tarjetas («Explicar»); el contacto abajo a la izquierda.
 */
async function wideLayers(
  card: CardSpec,
  style: CardStyle,
  theme: CardTheme,
  size: Size,
  composition: "announce" | "explain",
  header: Block,
  footer: Block | null,
): Promise<{ layers: Layer[]; fits: boolean; glow: { x: number; y: number } | null }> {
  const side = 72;
  const top = 60;
  const bottom = 56;
  const gutter = 56;
  const explain = composition === "explain" && card.role !== "closing";
  const items: { label: string; text: string }[] = explain
    ? card.role === "point"
      ? [{ label: String(card.position - 1).padStart(2, "0"), text: card.subtitle ?? "" }].filter(
          (item) => item.text !== "",
        )
      : (card.items ?? []).slice(0, 4)
    : [];
  const rightWidth = explain && items.length > 0 ? 560 : 380;
  const leftWidth = size.width - side * 2 - gutter - rightWidth;
  const areaTop = top + header.height;
  const areaBottom = size.height - bottom - (footer === null ? 0 : footer.height + 16);
  const subtitleText = card.role === "closing" ? (card.detail ?? "") : (card.subtitle ?? "");
  const subtitle =
    subtitleText === "" || (explain && card.role === "point")
      ? null
      : await bodyText(subtitleText, style, theme.secondary, {
          width: leftWidth,
          maxHeight: 160,
          size: 28,
          align: "left",
        });
  // El titular ocupa lo que deja el subtítulo, con 40 px de aire bajo la cabecera.
  const headline = await headlineOf(card.text, style, theme, {
    width: leftWidth,
    maxHeight: areaBottom - areaTop - 40 - (subtitle === null ? 0 : subtitle.height + 24),
    size: explain && items.length > 0 ? 70 : 80,
    align: "left",
  });
  const textHeight = headline.height + (subtitle === null ? 0 : 24 + subtitle.height);
  let y = areaTop + Math.max(0, Math.round((areaBottom - areaTop - textHeight) / 2));
  const layers: Layer[] = [{ input: headline.input, top: y, left: side }];
  if (subtitle !== null) {
    layers.push({ input: subtitle.input, top: y + headline.height + 24, left: side });
  }
  let fits = headline.fits && (subtitle?.fits ?? true) && textHeight <= areaBottom - areaTop - 20;
  const rightLeft = size.width - side - rightWidth;
  if (!explain || items.length === 0) {
    // La medalla, centrada en la columna derecha y en el alto de la lámina.
    const medalSize = card.role === "point" ? 220 : 260;
    const medal = await medalOf(theme, medalSize);
    const inside =
      card.role === "point"
        ? await textBlock(String(card.position - 1).padStart(2, "0"), {
            font: resolveFont(style.fonts.headline.family, 700),
            weight: 700,
            size: Math.round(medalSize * 0.36),
            color: "#FFFFFF",
            width: medalSize,
            maxHeight: medalSize,
            align: "centre",
            tracking: -0.02,
          })
        : await logoOf(style, "#FFFFFF", Math.round(medalSize * 0.33));
    const medalInput =
      inside === null
        ? medal.input
        : await sharp(medal.input)
            .composite([
              {
                input: inside.input,
                top: Math.round((medal.height - inside.height) / 2),
                left: Math.round((medal.width - inside.width) / 2),
              },
            ])
            .png()
            .toBuffer();
    const centreX = rightLeft + rightWidth / 2;
    const centreY = size.height / 2;
    layers.push({
      input: medalInput,
      top: Math.round(centreY - medal.height / 2),
      left: Math.round(centreX - medal.width / 2),
    });
    return { layers, fits, glow: { x: centreX, y: centreY } };
  }
  // La grilla a la derecha: la primera tarjeta héroe ancha, y las demás de a dos o anchas.
  const gap = 16;
  const rows: { items: typeof items; wide: boolean }[] = [];
  const [first, ...rest] = items;
  if (first !== undefined) rows.push({ items: [first], wide: true });
  if (rest.length >= 2) rows.push({ items: rest.slice(0, 2), wide: false });
  else if (rest.length === 1) rows.push({ items: rest, wide: true });
  if (rest.length >= 3) rows.push({ items: rest.slice(2, 3), wide: true });
  const colorsOf = (index: number) =>
    index === 0
      ? { background: theme.hero.background, text: theme.hero.text, label: theme.hero.label }
      : theme.card;
  const widthOf = (row: (typeof rows)[number]) =>
    row.wide ? rightWidth : Math.floor((rightWidth - gap) / 2);
  const gridTop = top;
  const available = size.height - bottom - gridTop;
  const measureAt = async (titleSize: number) => {
    const pad = Math.round(Math.max(20, titleSize * 0.8));
    const measuredRows: { contents: CardContent[]; height: number }[] = [];
    for (const [index, row] of rows.entries()) {
      const contents: CardContent[] = [];
      for (const item of row.items) {
        contents.push(
          await cardContent(item, style, colorsOf(index), widthOf(row), titleSize, pad),
        );
      }
      measuredRows.push({ contents, height: Math.max(...contents.map((c) => c.height)) });
    }
    const total = measuredRows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
    return { titleSize, pad, rows: measuredRows, total };
  };
  let measured = await measureAt(card.role === "point" ? 48 : 32);
  while (measured.total > available && measured.titleSize > 20) {
    measured = await measureAt(Math.floor(measured.titleSize * 0.9));
  }
  fits &&= measured.total <= available;
  const spare = Math.max(0, available - measured.total);
  const grow = Math.round((spare * 0.6) / rows.length);
  y = gridTop + Math.round((available - measured.total - grow * rows.length) / 2);
  for (const [index, row] of rows.entries()) {
    const measuredRow = measured.rows[index];
    const height = (measuredRow?.height ?? 0) + grow;
    let x = rightLeft;
    for (const content of measuredRow?.contents ?? []) {
      const width = widthOf(row);
      const input = await gridCard(
        content,
        style,
        colorsOf(index).background,
        { width, height },
        measured.pad + Math.round((height - content.height) / 2),
        measured.titleSize,
        measured.pad,
      );
      layers.push({ input, top: y, left: x });
      x += width + gap;
    }
    y += height + gap;
  }
  return { layers, fits, glow: null };
}

/**
 * Dibuja una lámina con el estilo de la marca: PNG del tamaño de su proporción y si el texto cupo.
 * El tema es el del post (`themeOfPost`); la composición, la pedida.
 */
export async function renderStyledCard(
  card: CardSpec,
  brand: CardBrand,
  styled: CardBrandStyle,
  format: PostImageFormat,
): Promise<StyledCardResult> {
  const { style } = styled;
  const size = POST_IMAGE_SIZES[format];
  const theme = style.themes[themeOfPost(styled.theme, style.themes.length)] ?? style.themes[0];
  if (theme === undefined) throw new Error("El estilo no tiene temas");
  if (format === "16:9") {
    const header = await headerOf(style, theme, brand.brandName, 600, 0.85);
    const footerText = card.role === "closing" ? null : card.detail;
    const footer =
      footerText === null || footerText === undefined || footerText === ""
        ? null
        : await bodyText(footerText, style, theme.secondary, {
            width: 500,
            maxHeight: 50,
            size: 22,
            align: "left",
            weight: 400,
          });
    const built = await wideLayers(card, style, theme, size, styled.composition, header, footer);
    const layers: Layer[] = [{ input: header.input, top: 60, left: 72 }, ...built.layers];
    if (footer !== null) {
      layers.push({ input: footer.input, top: size.height - 56 - footer.height, left: 72 });
    }
    const background = await backgroundOf(theme, size, built.glow);
    const png = await sharp(background).composite(layers).png().toBuffer();
    return { png, fits: built.fits && header.fits && (footer?.fits ?? true) };
  }
  const m = marginsOf(style, format);
  const inner = size.width - m.side * 2;
  const scale = format === "1:1" ? 0.85 : 1;
  const header = await headerOf(style, theme, brand.brandName, inner, scale);
  const footerText = card.role === "closing" ? null : card.detail;
  const footer =
    footerText === null || footerText === undefined || footerText === ""
      ? null
      : await bodyText(footerText, style, theme.secondary, {
          width: inner,
          maxHeight: 60,
          size: format === "1:1" ? 24 : 28,
          align: "centre",
          weight: 400,
        });
  const built =
    styled.composition === "explain" && card.role !== "closing"
      ? { ...(await explainLayers(card, style, theme, size, format, header, footer)), glow: null }
      : await announceLayers(card, style, theme, size, format, header, footer);
  const background = await backgroundOf(theme, size, built.glow);
  const layers: Layer[] = [
    { input: header.input, top: m.top, left: Math.round((size.width - header.width) / 2) },
    ...built.layers,
  ];
  if (footer !== null) {
    layers.push({
      input: footer.input,
      top: size.height - m.bottom - footer.height,
      left: Math.round((size.width - footer.width) / 2),
    });
  }
  const png = await sharp(background).composite(layers).png().toBuffer();
  return { png, fits: built.fits && header.fits && (footer?.fits ?? true) };
}
