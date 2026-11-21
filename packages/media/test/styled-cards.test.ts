import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CARD_COMPOSITIONS,
  type CardSpec,
  type CardStyle,
  lowContrastPairs,
  POST_IMAGE_FORMATS,
  POST_IMAGE_SIZES,
  parseCardStyle,
} from "@agentsales/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { familyNameOf, woffToSfnt } from "../src/fonts.js";
import { createCardRenderer } from "../src/index.js";
import { figureOf, renderStyledCard } from "../src/styled-cards.js";
import { pixel } from "./images.js";

// F9.7 B6 (ADR-0043): las láminas con el estilo de AgentPey (`docs/marca/agentpey/estilo.json`),
// de verdad con sharp: el tamaño de cada proporción, el contraste de cada tema y que los textos
// más largos que permite la IA (titular de 8 palabras, subtítulo de 20) caben.

let style: CardStyle;
beforeAll(async () => {
  style = parseCardStyle(
    JSON.parse(
      await readFile(join(import.meta.dirname, "../../../docs/marca/agentpey/estilo.json"), "utf8"),
    ),
  );
});

const BRAND = {
  brandName: "AgentPey",
  primaryColor: "#176bff",
  secondaryColor: "#6df2c0",
  logo: null,
};
const LONG_HEADLINE = "Ocho palabras largas para medir cuánto espacio ocupan";
const LONG_SUBTITLE =
  "Veinte palabras de subtítulo para revisar que el texto más largo que permite la regla cabe sin salirse de la lámina dibujada.";
const cards: CardSpec[] = [
  {
    role: "cover",
    text: LONG_HEADLINE,
    subtitle: LONG_SUBTITLE,
    detail: "@agentpeyai",
    position: 1,
    total: 6,
    items: [1, 2, 3, 4].map((n) => ({ label: `0${n}`, text: LONG_HEADLINE })),
  },
  {
    role: "point",
    text: LONG_HEADLINE,
    subtitle: LONG_SUBTITLE,
    detail: "@agentpeyai",
    position: 2,
    total: 6,
  },
  { role: "closing", text: "AgentPey", detail: "@agentpeyai", position: 6, total: 6 },
];

describe("estilo de AgentPey", () => {
  it("es válido y cada texto de los 4 temas contrasta al menos 4,5:1", () => {
    expect(style.themes).toHaveLength(4);
    for (const theme of style.themes) expect(lowContrastPairs(theme), theme.name).toEqual([]);
  });
});

describe("renderStyledCard", () => {
  it("las dos composiciones en 4:5, 1:1, 9:16 y 16:9: su tamaño, y el texto más largo cabe", async () => {
    for (const format of POST_IMAGE_FORMATS) {
      for (const composition of CARD_COMPOSITIONS) {
        for (const card of cards) {
          const result = await renderStyledCard(
            card,
            BRAND,
            { style, theme: 0, composition },
            format,
          );
          const meta = await sharp(result.png).metadata();
          expect([meta.width, meta.height]).toEqual([
            POST_IMAGE_SIZES[format].width,
            POST_IMAGE_SIZES[format].height,
          ]);
          expect(result.fits, `${format} ${composition} ${card.role}`).toBe(true);
        }
      }
    }
  }, 60_000);

  it("el pie con las redes ({instagram} y {x}) cabe en cada formato y no choca con la grilla", async () => {
    const detail =
      "Kantar Chile, noviembre 2026 · agentpey.com · {instagram} agentpey · {x} agentpeyai";
    const plain = { ...(cards[0] as CardSpec), detail: "@agentpeyai" };
    for (const format of POST_IMAGE_FORMATS) {
      const card = { ...(cards[0] as CardSpec), detail };
      const result = await renderStyledCard(
        card,
        BRAND,
        { style, theme: 0, composition: "explain" },
        format,
      );
      expect(result.fits, format).toBe(true);
      const before = await renderStyledCard(
        plain,
        BRAND,
        { style, theme: 0, composition: "explain" },
        format,
      );
      // Los íconos se dibujan: la lámina cambia respecto del pie de siempre.
      expect(result.png.equals(before.png)).toBe(false);
    }
  }, 60_000);

  it("el cierre con el pie de las redes dibuja los íconos y cabe en cada formato", async () => {
    const footer = "agentpey.com · {instagram} agentpey · {x} agentpeyai";
    for (const format of POST_IMAGE_FORMATS) {
      const closing: CardSpec = {
        role: "closing",
        text: "AgentPey",
        detail: footer,
        position: 4,
        total: 4,
      };
      const result = await renderStyledCard(
        closing,
        BRAND,
        { style, theme: 0, composition: "announce" },
        format,
      );
      expect(result.fits, format).toBe(true);
      const plain = await renderStyledCard(
        { ...closing, detail: "agentpey.com · instagram agentpey · x agentpeyai" },
        BRAND,
        { style, theme: 0, composition: "announce" },
        format,
      );
      expect(result.png.equals(plain.png), format).toBe(false);
    }
  }, 60_000);

  it("una sola imagen con el titular y sus puntos clave con cifras cabe en cada formato", async () => {
    const card: CardSpec = {
      role: "cover",
      text: "Cómo compran los chilenos con IA",
      subtitle: null,
      detail: "agentpey.com · {instagram} agentpey · {x} agentpeyai",
      position: 1,
      total: 1,
      items: [
        { label: "01", text: "68% probaría comprar con un agente de IA" },
        { label: "02", text: "64% confía más si puede poner límites" },
        { label: "03", text: "Pagar con permiso, no con la tarjeta" },
      ],
    };
    for (const format of POST_IMAGE_FORMATS) {
      const result = await renderStyledCard(
        card,
        BRAND,
        { style, theme: 0, composition: "explain" },
        format,
      );
      expect(result.fits, format).toBe(true);
    }
  }, 60_000);

  it("cada tema pinta su fondo y el tema rota con el índice del post", async () => {
    const corner = async (theme: number) => {
      const { png } = await renderStyledCard(
        cards[2] as CardSpec,
        BRAND,
        { style, theme, composition: "announce" },
        "4:5",
      );
      const jpeg = await sharp(png).jpeg().toBuffer();
      return pixel(new Uint8Array(jpeg), 5, 5);
    };
    expect(await corner(0)).toEqual(await corner(4));
    // El tema claro es el cuarto (D · Blanco).
    const light = await corner(3);
    expect((light[0] ?? 0) > 230).toBe(true);
    const dark = await corner(0);
    expect((dark[0] ?? 255) < 20).toBe(true);
  });

  it("un punto que empieza con un porcentaje lo separa como cifra; los demás no", () => {
    expect(figureOf("68% probaría una marca que no conoce")).toEqual({
      value: "68%",
      rest: "probaría una marca que no conoce",
    });
    expect(figureOf("64,5 % ya compró por IA")).toEqual({
      value: "64,5%",
      rest: "ya compró por IA",
    });
    expect(figureOf("Un contrato hace cumplir el tope")).toBeNull();
    expect(figureOf("2026 fue el año")).toBeNull();
    expect(figureOf("68%")).toBeNull();
  });

  it("las tarjetas con cifras («68% …») caben en cada formato y se dibujan distinto", async () => {
    const withFigures: CardSpec = {
      ...(cards[0] as CardSpec),
      subtitle: null,
      items: [
        { label: "01", text: "64% ya compró algo que le recomendó una IA" },
        { label: "02", text: "68% probaría una marca que no conoce" },
      ],
    };
    const plain: CardSpec = {
      ...withFigures,
      items: [
        { label: "01", text: "ya compró algo que le recomendó una IA" },
        { label: "02", text: "probaría una marca que no conoce" },
      ],
    };
    for (const format of POST_IMAGE_FORMATS) {
      const result = await renderStyledCard(
        withFigures,
        BRAND,
        { style, theme: 0, composition: "explain" },
        format,
      );
      expect(result.fits, format).toBe(true);
    }
    const a = await renderStyledCard(
      withFigures,
      BRAND,
      { style, theme: 0, composition: "explain" },
      "4:5",
    );
    const b = await renderStyledCard(
      plain,
      BRAND,
      { style, theme: 0, composition: "explain" },
      "4:5",
    );
    expect(Buffer.compare(a.png, b.png)).not.toBe(0);
  });

  it("«Explicar» con un solo punto llena el lienzo: la tarjeta baja hasta cerca del pie", async () => {
    const point = {
      ...(cards[1] as CardSpec),
      subtitle: "Un contrato hace cumplir cuánto gasta tu agente.",
    };
    const { png } = await renderStyledCard(
      point,
      BRAND,
      { style, theme: 0, composition: "explain" },
      "4:5",
    );
    const jpeg = new Uint8Array(await sharp(png).jpeg().toBuffer());
    // El borde derecho de la tarjeta héroe (#1062f0) a 3/4 del alto: ya no queda vacío abajo.
    const [r, g, b] = await pixel(jpeg, 975, 1000);
    expect((b ?? 0) > 200 && (r ?? 255) < 60 && (g ?? 0) > 70).toBe(true);
  });

  it("el renderer usa el estilo si viene y es determinista", async () => {
    const renderer = createCardRenderer();
    const options = {
      format: "1:1" as const,
      brand: { ...BRAND, style: { style, theme: 1, composition: "explain" as const } },
    };
    const a = await renderer.render(cards[0] as CardSpec, options);
    const b = await renderer.render(cards[0] as CardSpec, options);
    expect([a.width, a.height]).toEqual([1080, 1080]);
    expect(a.sha256).toBe(b.sha256);
  });
});

const IAS = "Las IAs casi no recomiendan tiendas pequeñas";
const IAS_SUBTITLE =
  "En 116 respuestas, 5 tiendas chilenas aparecieron solo en 19 (16%). Es una muestra.";

/** Cuántos píxeles claros (texto) hay en cada fila de una franja de la lámina. */
async function inkRows(png: Buffer, from: number, to: number, x0 = 0, x1 = 1080) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows: number[] = [];
  for (let y = from; y < to; y++) {
    let count = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * 3;
      const luma = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      if (luma > 110) count++;
    }
    rows.push(count);
  }
  return rows;
}

describe("titular sin subtítulo y con el interlineado parejo", () => {
  const cover = (subtitle: string | null): CardSpec => ({
    role: "cover",
    text: IAS,
    subtitle,
    detail: "@agentpeyai",
    position: 1,
    total: 1,
  });

  it("las líneas del titular están a la misma distancia aunque la última lleve degradado", async () => {
    // Tres palabras anchas e iguales: una por línea y todas con la misma forma, así la distancia
    // entre sus filas de tinta es el interlineado (la primera en color normal, las otras con degradado).
    const { png, fits } = await renderStyledCard(
      { ...cover(null), text: "mmmmmm mmmmmm mmmmmm" },
      BRAND,
      { style, theme: 0, composition: "announce" },
      "4:5",
    );
    expect(fits).toBe(true);
    const rows = await inkRows(png, 700, 1150);
    const tops: number[] = [];
    rows.forEach((count, y) => {
      if (count > 0 && (y === 0 || rows[y - 1] === 0)) tops.push(y + 700);
    });
    expect(tops, `líneas en ${tops.join(", ")}`).toHaveLength(3);
    const [a, b, c] = tops as [number, number, number];
    expect(Math.abs(b - a - (c - b))).toBeLessThanOrEqual(2);
    expect(b - a).toBeGreaterThan(80);
  }, 30_000);

  it("sin subtítulo (nulo o vacío) no da error y se ve igual; con subtítulo cambia", async () => {
    const draw = (
      subtitle: string | null,
      format: "4:5" | "1:1",
      composition: "announce" | "explain",
    ) => renderStyledCard(cover(subtitle), BRAND, { style, theme: 0, composition }, format);
    for (const format of ["4:5", "1:1"] as const) {
      for (const composition of CARD_COMPOSITIONS) {
        const none = await draw(null, format, composition);
        const empty = await draw("", format, composition);
        const withSub = await draw(IAS_SUBTITLE, format, composition);
        expect(none.fits, `${format} ${composition}`).toBe(true);
        expect(empty.png.equals(none.png)).toBe(true);
        expect(withSub.fits, `${format} ${composition} con subtítulo`).toBe(true);
        if (composition === "announce") expect(withSub.png.equals(none.png)).toBe(false);
      }
    }
  }, 60_000);

  it("el bloque central queda centrado entre el logo y el pie (el mismo aire arriba y abajo)", async () => {
    for (const [format, height] of [
      ["4:5", 1350],
      ["1:1", 1080],
    ] as const) {
      const { png } = await renderStyledCard(
        cover(null),
        BRAND,
        { style, theme: 2, composition: "announce" },
        format,
      );
      // Tema claro: la tinta es lo oscuro. Filas con algo de tinta entre el logo y el pie.
      const { data, info } = await sharp(png)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const inked = (y: number) => {
        for (let x = 0; x < info.width; x++) {
          if ((data[(y * info.width + x) * 3] ?? 255) < 200) return true;
        }
        return false;
      };
      const logoBottom = Math.round(height * (format === "4:5" ? 0.125 : 0.13));
      const footTop = Math.round(height * 0.88);
      let first = -1;
      let last = -1;
      for (let y = logoBottom; y < footTop; y++) {
        if (inked(y)) {
          if (first < 0) first = y;
          last = y;
        }
      }
      expect(first).toBeGreaterThan(0);
      const above = first - logoBottom;
      const below = footTop - last;
      expect(
        Math.abs(above - below),
        `${format}: ${above} arriba, ${below} abajo`,
      ).toBeLessThanOrEqual(Math.round(height * 0.05));
    }
  }, 30_000);
});

describe("1:1 (X, LinkedIn e Instagram)", () => {
  it("1080 × 1080, con el texto dentro del centro (el perfil de Instagram recorta a 3:4)", async () => {
    for (const composition of CARD_COMPOSITIONS) {
      for (const card of cards) {
        const { png, fits } = await renderStyledCard(
          card,
          BRAND,
          { style, theme: 0, composition },
          "1:1",
        );
        expect(fits, `${composition} ${card.role}`).toBe(true);
        const meta = await sharp(png).metadata();
        expect([meta.width, meta.height]).toEqual([1080, 1080]);
      }
    }
    // El titular de «Anuncio» (tema oscuro, texto claro) no pasa de los 135 px de cada lado.
    const { png } = await renderStyledCard(
      { role: "cover", text: IAS, subtitle: null, detail: null, position: 1, total: 1 },
      BRAND,
      { style, theme: 0, composition: "announce" },
      "1:1",
    );
    const sides = [
      ...(await inkRows(png, 520, 900, 0, 130)),
      ...(await inkRows(png, 520, 900, 950, 1080)),
    ];
    expect(Math.max(...sides)).toBe(0);
  }, 60_000);
});

describe("las fuentes", () => {
  it("convierte el WOFF de Inter Tight a TTF y lee su familia", async () => {
    const path = join(
      import.meta.dirname,
      "../node_modules/@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff",
    );
    const ttf = woffToSfnt(await readFile(path));
    expect(ttf.readUInt32BE(0)).toBe(0x00010000);
    expect(familyNameOf(ttf)).toBe("Inter Tight SemiBold");
  });
});
