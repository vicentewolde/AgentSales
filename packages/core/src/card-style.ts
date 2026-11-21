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

/** Un usuario de una red en el pie: letras, números, punto y guion bajo (con o sin «@»). */
const footerHandle = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9._]{1,30}$/u, "un usuario como agentpey (letras, números, . y _)");

/**
 * El pie de las láminas (arreglo de las láminas del servidor): el sitio, el usuario de Instagram y
 * el de X. Cada uno es opcional: lo que falta lo completa `cardFooterParts` con los datos de la
 * marca y de sus cuentas conectadas, y lo que no está en ninguna parte no va.
 */
export const cardFooterSchema = z.strictObject({
  website: z
    .string()
    .trim()
    .regex(/^[^\s{}<>]{3,80}$/u, "un sitio como agentpey.com, sin espacios")
    .nullable()
    .default(null),
  instagram: footerHandle.nullable().default(null),
  x: footerHandle.nullable().default(null),
});
export type CardFooter = z.infer<typeof cardFooterSchema>;

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
  /** El pie de las láminas; sin él, sale de los datos de la marca y de sus cuentas. */
  footer: cardFooterSchema.optional(),
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

/** Lo que va en el pie: el sitio y los usuarios, ya limpios (sin «https://» ni «@»). */
export type CardFooterParts = {
  website: string | null;
  instagram: string | null;
  x: string | null;
};

const cleanSite = (value: string | null | undefined): string | null => {
  const site = value
    ?.trim()
    .replace(/^https?:\/\//iu, "")
    .replace(/^www\./iu, "")
    .replace(/\/+$/u, "");
  return site === undefined || !/^[^\s{}<>]{3,80}$/u.test(site) ? null : site;
};

const cleanHandle = (value: string | null | undefined): string | null => {
  const handle = value?.trim().replace(/^@/u, "");
  return handle === undefined || !/^[A-Za-z0-9._]{1,30}$/u.test(handle) ? null : handle;
};

/**
 * El pie de las láminas desde los datos de la marca, sin inventar nada: cada parte sale del pie
 * del estilo (`style.footer`); si falta ahí, el sitio y el Instagram de la marca (`website`,
 * `instagramHandle`) y, después, el usuario de su cuenta conectada de Instagram o de X (la de
 * Instagram puede ser «a mano», con su usuario). Una cuenta revocada no cuenta.
 */
export function cardFooterParts(params: {
  footer: CardFooter | null | undefined;
  broker: { website: string | null; instagramHandle: string | null };
  accounts: readonly { platform: string; displayName: string; status: string }[];
}): CardFooterParts {
  const accountHandle = (platform: string) => {
    const usable = params.accounts.filter(
      (account) => account.platform === platform && account.status !== "revoked",
    );
    const sorted = [
      ...usable.filter((account) => account.status === "connected"),
      ...usable.filter((account) => account.status !== "connected"),
    ];
    for (const account of sorted) {
      const handle = cleanHandle(account.displayName);
      if (handle !== null) return handle;
    }
    return null;
  };
  return {
    website: cleanSite(params.footer?.website) ?? cleanSite(params.broker.website),
    instagram:
      cleanHandle(params.footer?.instagram) ??
      cleanHandle(params.broker.instagramHandle) ??
      accountHandle("instagram"),
    x: cleanHandle(params.footer?.x) ?? accountHandle("x"),
  };
}

/**
 * El texto del pie para el dibujante: «agentpey.com · {instagram} agentpey · {x} agentpeyai» (los
 * marcadores `{instagram}` y `{x}` se dibujan como íconos). Solo lo que hay; `null` si no hay nada.
 */
export function cardFooterText(parts: CardFooterParts): string | null {
  const pieces = [
    ...(parts.website === null ? [] : [parts.website]),
    ...(parts.instagram === null ? [] : [`{instagram} ${parts.instagram}`]),
    ...(parts.x === null ? [] : [`{x} ${parts.x}`]),
  ];
  return pieces.length === 0 ? null : pieces.join(" · ");
}
