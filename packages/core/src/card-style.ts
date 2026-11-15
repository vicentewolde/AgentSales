import { z } from "zod";
import { AppError } from "./errors.js";

// El estilo de las imágenes de una marca (spec F9.7 B4, ADR-0043 punto 4, D3): el «manual de
// diseño» como datos acotados que el dibujante sabe usar. Un manual nuevo se traduce a este
// esquema (para AgentPey, `docs/marca/agentpey/estilo.json`, de `DISENO.md`).

/** Las fuentes incluidas en el sistema (archivos OFL que el dibujante trae consigo). */
export const CARD_FONTS = ["inter-tight", "inter"] as const;
export type CardFont = (typeof CARD_FONTS)[number];

/** Los pesos que se pueden pedir. */
export const CARD_FONT_WEIGHTS = [400, 500, 600, 700] as const;

/** Cuántos temas puede rotar una marca (B4). */
export const CARD_STYLE_MAX_THEMES = 4;

/** Las composiciones de las láminas (B6). */
export const CARD_COMPOSITIONS = ["announce", "explain"] as const;
export type CardComposition = (typeof CARD_COMPOSITIONS)[number];

/** Topes del logo del estilo (va dentro del JSON). */
export const CARD_STYLE_LIMITS = { svgChars: 20_000, pngBase64Chars: 400_000 } as const;

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "un color #RRGGBB");
const weight = z.union(CARD_FONT_WEIGHTS.map((value) => z.literal(value)));

/** El fondo de un tema: plano, degradado lineal (ángulo en grados) o radial (centro arriba). */
const backgroundSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("solid"), color }),
  z.strictObject({
    kind: z.literal("linear"),
    from: color,
    to: color,
    angle: z.number().min(0).max(360).default(180),
  }),
  z.strictObject({ kind: z.literal("radial"), from: color, via: color.nullable(), to: color }),
]);

/** Un tema de color (B4): hasta 4 por marca, que se rotan uno por post. */
export const cardThemeSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  background: backgroundSchema,
  /** El titular y el texto principal. */
  text: color,
  /** Subtítulos, etiquetas y pie. */
  secondary: color,
  /** El acento de la marca (palabras resaltadas, el disco del objeto central). */
  accent: color,
  /** El degradado del titular (una frase por imagen); `null` = el acento plano. */
  headlineGradient: z.strictObject({ from: color, to: color }).nullable(),
  /** Las tarjetas de la grilla («Explicar»). */
  card: z.strictObject({ background: color, text: color, label: color }),
  /** La tarjeta héroe (la primera, ancha) y su palabra resaltada. */
  hero: z.strictObject({ background: color, text: color, label: color, accent: color }),
  /** El objeto central de «Anuncio»: un aro y un disco con degradado. */
  medal: z.strictObject({ ring: z.tuple([color, color]), disc: z.tuple([color, color]) }),
  /** Un brillo detrás del objeto central, con su opacidad; `null` = sin brillo. */
  glow: z.strictObject({ color, opacity: z.number().min(0).max(0.6) }).nullable(),
});
export type CardTheme = z.infer<typeof cardThemeSchema>;

/** El logo del estilo: SVG (con `currentColor` para tomar el color del texto) o PNG transparente. */
const logoSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("svg"), svg: z.string().max(CARD_STYLE_LIMITS.svgChars) }),
    z.strictObject({
      kind: z.literal("png"),
      base64: z
        .string()
        .max(CARD_STYLE_LIMITS.pngBase64Chars)
        .regex(/^[A-Za-z0-9+/=]+$/u),
    }),
  ])
  .nullable();

/** El estilo de las imágenes de una marca (`brand_card_styles.style`). */
export const cardStyleSchema = z.strictObject({
  version: z.literal(1),
  fonts: z.strictObject({
    headline: z.strictObject({
      family: z.enum(CARD_FONTS),
      weight,
      /** El espaciado de letras en em (DISENO.md: nunca más apretado que -0,03). */
      tracking: z.number().min(-0.03).max(0.05),
    }),
    body: z.strictObject({ family: z.enum(CARD_FONTS), weight }),
  }),
  /** Márgenes en píxeles sobre un lienzo de 1080 de ancho. */
  margins: z.strictObject({
    side: z.number().int().min(40).max(200),
    top: z.number().int().min(40).max(260),
    bottom: z.number().int().min(40).max(260),
  }),
  /** Radio de las tarjetas de la grilla, en píxeles. */
  cardRadius: z.number().int().min(0).max(80),
  logo: logoSchema,
  /** Si junto al logo va el nombre de la marca. */
  showBrandName: z.boolean(),
  themes: z.array(cardThemeSchema).min(1).max(CARD_STYLE_MAX_THEMES),
});
export type CardStyle = z.infer<typeof cardStyleSchema>;

/** El estilo guardado de una marca. */
export type BrandCardStyle = {
  brokerId: string;
  style: CardStyle;
  /** Sube con cada cambio. */
  version: number;
  updatedAt: Date;
};

/** Lo que un SVG de logo no puede traer: scripts, referencias externas ni entidades. */
const UNSAFE_SVG =
  /<\s*script|<\s*foreignObject|<!\s*(DOCTYPE|ENTITY)|\bon[a-z]+\s*=|(?:xlink:)?href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)|<\s*image\b|@import/iu;

/**
 * Valida un estilo (D3): el esquema y, además, que el SVG del logo sea un SVG sin nada que cargue
 * algo de afuera ni ejecute código, y que el PNG sea un PNG. `CARD_STYLE_INVALID` (400) con la lista
 * de lo que hay que corregir.
 */
export function parseCardStyle(input: unknown): CardStyle {
  const parsed = cardStyleSchema.safeParse(input);
  const issues: { field: string; message: string }[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "(raíz)",
        message: issue.message,
      }));
  const style = parsed.success ? parsed.data : null;
  if (style?.logo?.kind === "svg") {
    const svg = style.logo.svg.trim();
    if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(svg) || !/<\/svg>\s*$/iu.test(svg)) {
      issues.push({ field: "logo.svg", message: "no es un SVG (debe empezar con <svg y cerrar)" });
    } else if (UNSAFE_SVG.test(svg)) {
      issues.push({
        field: "logo.svg",
        message: "trae scripts, enlaces o imágenes externas: solo formas y máscaras propias",
      });
    }
  }
  if (style?.logo?.kind === "png" && !style.logo.base64.startsWith("iVBORw0KGgo")) {
    issues.push({ field: "logo.base64", message: "no es un PNG" });
  }
  if (issues.length > 0 || style === null) {
    throw new AppError(
      "CARD_STYLE_INVALID",
      `Revisa el estilo de imágenes: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
      { details: { issues } },
    );
  }
  return style;
}

/**
 * El tema que le toca al próximo post (rotación, B4): el siguiente al último usado por la marca,
 * vuelta a empezar al llegar al final. Sin ninguno usado, el primero.
 */
export function nextCardTheme(lastUsed: number | null, themes: number): number {
  if (themes <= 0) return 0;
  if (lastUsed === null || lastUsed < 0) return 0;
  return (lastUsed + 1) % themes;
}

/** El tema de un post dentro de los del estilo (si el estilo cambió y tiene menos, se ajusta). */
export const themeOfPost = (cardTheme: number, themes: number): number =>
  themes <= 0 ? 0 : ((cardTheme % themes) + themes) % themes;

/** Luminancia relativa (WCAG) de un `#RRGGBB`. */
function luminanceOf(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** El contraste WCAG entre dos colores `#RRGGBB` (de 1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminanceOf(a);
  const y = luminanceOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** El contraste mínimo del texto de las láminas (WCAG AA para texto normal). */
export const CARD_MIN_CONTRAST = 4.5;

/**
 * Los pares de texto y fondo de un tema (B6): cada texto contra cada color de su fondo (los dos
 * extremos de un degradado y su punto medio). Las pruebas y la API los revisan contra 4,5:1.
 */
export function themeContrastPairs(
  theme: CardTheme,
): { what: string; text: string; background: string }[] {
  const bg = theme.background;
  const backgrounds =
    bg.kind === "solid"
      ? [bg.color]
      : bg.kind === "linear"
        ? [bg.from, bg.to]
        : [bg.from, ...(bg.via === null ? [] : [bg.via]), bg.to];
  const onBackground = [
    { what: "texto", text: theme.text },
    { what: "secundario", text: theme.secondary },
    ...(theme.headlineGradient === null
      ? [{ what: "acento", text: theme.accent }]
      : [
          { what: "degradado (inicio)", text: theme.headlineGradient.from },
          { what: "degradado (fin)", text: theme.headlineGradient.to },
        ]),
  ];
  return [
    ...onBackground.flatMap((item) => backgrounds.map((background) => ({ ...item, background }))),
    { what: "tarjeta: texto", text: theme.card.text, background: theme.card.background },
    { what: "tarjeta: etiqueta", text: theme.card.label, background: theme.card.background },
    { what: "héroe: texto", text: theme.hero.text, background: theme.hero.background },
    { what: "héroe: etiqueta", text: theme.hero.label, background: theme.hero.background },
  ];
}

/** Los pares de un tema que no llegan a 4,5:1 (vacío si todos llegan). */
export const lowContrastPairs = (theme: CardTheme) =>
  themeContrastPairs(theme).filter(
    (pair) => contrastRatio(pair.text, pair.background) < CARD_MIN_CONTRAST,
  );
