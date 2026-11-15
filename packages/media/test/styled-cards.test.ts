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
import { renderStyledCard } from "../src/styled-cards.js";
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
  it("las dos composiciones en 4:5, 1:1 y 9:16: su tamaño, y el texto más largo cabe", async () => {
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
    const light = await corner(2);
    expect((light[0] ?? 0) > 230).toBe(true);
    const dark = await corner(0);
    expect((dark[0] ?? 255) < 20).toBe(true);
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
