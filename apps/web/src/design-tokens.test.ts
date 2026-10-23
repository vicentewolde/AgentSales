import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALERT_TONE, BADGE_TONE, buttonClasses } from "./components/ui/styles.js";

// F9.5-T26: la paleta acogedora pasa AA (WCAG 2.2, 1.4.3) con los valores reales de `index.css`, y
// no queda ningún color del diseño anterior (la paleta por defecto de Tailwind) en el panel.

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/** Los colores del tema: `--color-brand-700: #a8532f;` → `brand-700` → `#a8532f`. */
const TOKENS: ReadonlyMap<string, string> = new Map(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
    ([, name, hex]) => [name as string, (hex as string).toLowerCase()] as const,
  ),
);

const hex = (token: string): string => {
  const value = TOKENS.get(token);
  if (value === undefined) throw new Error(`Falta el color --color-${token} en index.css`);
  return value;
};

/** Luminancia relativa de un color `#rrggbb` (WCAG 2.2). */
function luminance(color: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** El contraste entre dos colores, de 1 a 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Texto normal: 4,5:1. Íconos y bordes que dan información: 3:1 (1.4.11). */
const TEXT = 4.5;
const GRAPHIC = 3;

/** Saca el color de una utilidad (`bg-success-50` → `success-50`) de una lista de clases. */
const utility = (classes: string, prefix: "bg" | "text"): string => {
  const match = classes.split(/\s+/).find((name) => name.startsWith(`${prefix}-`));
  if (match === undefined) throw new Error(`Sin ${prefix}- en «${classes}»`);
  return match.slice(prefix.length + 1);
};

describe("la paleta (F9.5-T26)", () => {
  it("tiene los valores aprobados", () => {
    expect(hex("canvas")).toBe("#f6f0e6");
    expect(hex("surface")).toBe("#fffcf7");
    expect(hex("sand")).toBe("#efe5d6");
    expect(hex("sand-strong")).toBe("#e4d6c1");
    expect(hex("line-strong")).toBe("#dccdb8");
    expect(hex("fg")).toBe("#2b231d");
    expect(hex("fg-muted")).toBe("#4a3d32");
    expect(hex("fg-subtle")).toBe("#6b5d50");
    // El botón primario, el enlace y el enlace al pasar el cursor.
    expect(hex("brand-700")).toBe("#a8532f");
    expect(hex("brand-800")).toBe("#9a4a29");
    expect(hex("brand-900")).toBe("#7a3a1f");
    expect(hex("success-50")).toBe("#e3eadf");
    expect(hex("success-800")).toBe("#4d6248");
    expect(hex("warning-50")).toBe("#f6e7cc");
    expect(hex("warning-800")).toBe("#7a4e10");
  });

  // [texto, fondo]: cada par que el panel usa para escribir.
  const pairs: readonly (readonly [string, string])[] = [
    // El texto sobre el fondo, las tarjetas, la barra lateral y su nota.
    ...["fg", "fg-muted", "fg-subtle"].flatMap((text) =>
      ["canvas", "surface", "sand"].map((bg) => [text, bg] as const),
    ),
    ["fg", "sand-strong"],
    ["fg-muted", "sand-strong"],
    // Botones: primario, primario al pasar el cursor, peligro, y el banner en vivo.
    ["surface", "brand-700"],
    ["surface", "brand-800"],
    ["surface", "danger-700"],
    ["surface", "danger-800"],
    ["surface", "fg"],
    // Enlaces (los de siempre en 700, los nuevos en 800, al pasar el cursor en 900).
    ...["brand-700", "brand-800", "brand-900"].flatMap((text) =>
      ["canvas", "surface"].map((bg) => [text, bg] as const),
    ),
    ["brand-800", "sand"],
    ["brand-800", "brand-50"],
    // Los estados como texto suelto (errores, avisos, «publicado»).
    ...["danger-700", "danger-800", "warning-700", "warning-800", "success-700", "success-800"]
      .concat(["info-700", "info-800", "accent-700", "accent-800"])
      .flatMap((text) => ["canvas", "surface"].map((bg) => [text, bg] as const)),
    ["danger-700", "danger-50"],
    ["warning-700", "warning-50"],
    ["warning-800", "sand"],
  ];

  it.each(pairs)("%s sobre %s pasa AA", (text, bg) => {
    expect(contrast(hex(text), hex(bg))).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(Object.entries(BADGE_TONE))("la insignia %s pasa AA", (_tone, { badge }) => {
    expect(contrast(hex(utility(badge, "text")), hex(utility(badge, "bg")))).toBeGreaterThanOrEqual(
      TEXT,
    );
  });

  it.each(Object.entries(ALERT_TONE))("el aviso %s pasa AA", (_tone, { box, icon, title }) => {
    const bg = hex(utility(box, "bg"));
    expect(contrast(hex(utility(box, "text")), bg)).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(hex(utility(title, "text")), bg)).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(hex(utility(icon, "text")), bg)).toBeGreaterThanOrEqual(GRAPHIC);
  });

  it.each(["primary", "danger"] as const)("el botón %s pasa AA", (variant) => {
    const classes = buttonClasses(variant);
    expect(
      contrast(hex(utility(classes, "text")), hex(utility(classes, "bg"))),
    ).toBeGreaterThanOrEqual(TEXT);
  });

  it("el foco se ve sobre el fondo y las tarjetas", () => {
    for (const bg of ["canvas", "surface", "sand"]) {
      expect(contrast(hex("brand-700"), hex(bg))).toBeGreaterThanOrEqual(GRAPHIC);
    }
  });
});

describe("sin colores del diseño anterior (F9.5-T26)", () => {
  // La paleta por defecto de Tailwind (y el blanco y el negro puros) no se usa: todo pasa por los
  // tokens del tema.
  const OLD =
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|via|to|accent|decoration|placeholder|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/;
  const root = new URL("./", import.meta.url);
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(
    (path) => /\.(tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path),
  );

  it("encuentra los archivos del panel", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)("%s", (path) => {
    const source = readFileSync(new URL(path, root), "utf8");
    expect(source.match(OLD)?.[0]).toBeUndefined();
  });

  it("index.html no pone clases de color en el body", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/<body[^>]*class=/);
  });
});
