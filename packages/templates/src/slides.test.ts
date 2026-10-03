import type { CoverData, ReelOverlayData, SpecSheetData } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createSlideTemplates, TEMPLATES_VERSION } from "./index.js";

const templates = createSlideTemplates();

/** Un JPEG mínimo de mentira: la plantilla solo arma el `data:`. */
const photo = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  mime: "image/jpeg",
  sha256: "a",
} as const;
const logo = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mime: "image/png",
  sha256: "b",
} as const;

const brand = {
  brandName: "Inventada Propiedades",
  primaryColor: "#1f4e79",
  secondaryColor: "#F2A900",
  logo,
};

const cover = (overrides: Partial<CoverData> = {}): CoverData => ({
  operation: "sale",
  propertyType: "Departamento",
  comuna: "Ñuñoa",
  price: "UF 5.800",
  facts: [
    { icon: "area", text: "72,5 m²" },
    { icon: "bed", text: "3 dorm" },
    { icon: "bath", text: "2 baños" },
  ],
  photo,
  brand,
  ...overrides,
});

const sheet = (overrides: Partial<SpecSheetData> = {}): SpecSheetData => ({
  operation: "rent",
  propertyType: "Casa",
  comuna: "Ñuñoa",
  price: "$650.000/mes",
  commonExpenses: "$45.000",
  rows: [
    { icon: "area", label: "Superficie útil", value: "72,5 m²" },
    { icon: "parking", label: "Estacionamientos", value: "1" },
  ],
  availability: "Inmediata",
  contact: { whatsapp: "+56 9 1111 2222", instagramHandle: "inventada.propiedades" },
  brand,
  ...overrides,
});

const reel: ReelOverlayData = {
  operation: "sale",
  propertyType: "Departamento",
  comuna: "Ñuñoa",
  price: "UF 5.800",
};

/** Los íconos que dibuja un HTML, en orden. */
const iconsIn = (html: string) => [...html.matchAll(/data-icon="([a-z]+)"/g)].map((m) => m[1]);

/** Los textos visibles de un HTML (sin el CSS ni las etiquetas), en orden. */
const visibleText = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** El HTML sin la fuente incrustada (que es base64 largo). */
const withoutFont = (html: string) =>
  html.replace(/url\(data:font\/woff2;base64,[^)]+\)/g, "url(FUENTE)");

describe("plantillas", () => {
  it("tienen versión y arman documentos autocontenidos: Inter incrustada y nada de red", () => {
    expect(templates.version).toBe(TEMPLATES_VERSION);
    for (const html of [
      templates.cover(cover()),
      templates.specSheet(sheet()),
      templates.reelOverlay(reel),
    ]) {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html.match(/font-family:Inter;font-style:normal;font-weight:\d+/g)).toHaveLength(3);
      expect(html).toContain("url(data:font/woff2;base64,");
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/<script/i);
    }
  });

  it("escapan los datos: un texto del Excel con HTML no rompe ni inyecta nada", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=1>';
    const html = withoutFont(
      templates.cover(
        cover({
          comuna: hostile,
          price: "UF 5.800 & más",
          brand: { ...brand, brandName: hostile, logo: null },
        }),
      ),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("UF 5.800 &amp; más");
  });

  it("la portada muestra solo los datos que recibe (no hay dónde poner la dirección)", () => {
    expect(visibleText(templates.cover(cover({ brand: { ...brand, logo: null } })))).toEqual([
      "VENTA",
      "Inventada Propiedades",
      "UF 5.800",
      "Departamento · Ñuñoa",
      "72,5 m²",
      "3 dorm",
      "2 baños",
    ]);
  });
});

describe("portada", () => {
  it("venta: etiqueta VENTA, precio, tipo y comuna, y un ícono por dato", () => {
    const html = withoutFont(templates.cover(cover()));

    expect(html).toContain('<span class="badge">VENTA</span>');
    expect(html).toContain('<div class="price">UF 5.800</div>');
    expect(html).toContain('<div class="place">Departamento · Ñuñoa</div>');
    expect(iconsIn(html)).toEqual(["area", "bed", "bath"]);
    expect(html).toContain('src="data:image/jpeg;base64,');
  });

  it("arriendo, e íconos solo de los datos que existen (sin la fila si no hay ninguno)", () => {
    const rent = withoutFont(
      templates.cover(
        cover({
          operation: "rent",
          price: "$650.000/mes",
          facts: [{ icon: "area", text: "40 m²" }],
        }),
      ),
    );
    const none = withoutFont(templates.cover(cover({ facts: [] })));

    expect(rent).toContain('<span class="badge">ARRIENDO</span>');
    expect(iconsIn(rent)).toEqual(["area"]);
    expect(iconsIn(none)).toEqual([]);
    expect(none).not.toContain('class="facts"');
  });

  it("usa los colores del corredor (y uno de respaldo si el color no es válido)", () => {
    const html = withoutFont(templates.cover(cover()));
    const broken = withoutFont(
      templates.cover(cover({ brand: { ...brand, secondaryColor: "red;}body{display:none" } })),
    );

    expect(html).toContain("background:#F2A900");
    expect(broken).not.toContain("display:none");
    expect(broken).toContain("background:#1F4E79");
  });

  it("el logo va como imagen; sin logo, el nombre del corredor", () => {
    expect(templates.cover(cover())).toContain('class="logo" src="data:image/png;base64,');
    const html = withoutFont(templates.cover(cover({ brand: { ...brand, logo: null } })));
    expect(html).toContain('<span class="logo-name">Inventada Propiedades</span>');
  });

  it("un logo WebP se incrusta", () => {
    const html = templates.cover(
      cover({ brand: { ...brand, logo: { ...logo, mime: "image/webp" } } }),
    );
    expect(html).toContain('class="logo" src="data:image/webp;base64,');
  });

  it("una imagen que no es JPEG, PNG ni WebP no se incrusta", () => {
    const html = templates.cover(
      cover({ photo: { ...photo, mime: "image/svg+xml" as "image/jpeg" } }),
    );
    expect(html).not.toContain("data:image/svg+xml");
  });
});

describe("ficha", () => {
  it("fondo del color primario, filas con ícono, gastos comunes, disponibilidad y contacto", () => {
    const html = withoutFont(templates.specSheet(sheet()));

    expect(html).toContain("body{background:#1F4E79;color:#FFFFFF}");
    expect(html).toContain('<span class="badge">ARRIENDO</span>');
    expect(html).toContain("$650.000/mes");
    expect(html).toContain("Gastos comunes aprox. $45.000");
    expect(html).toContain("<strong>Disponibilidad:</strong> Inmediata");
    expect(iconsIn(html)).toEqual(["area", "parking", "phone", "instagram"]);
    expect(html).toContain("+56 9 1111 2222");
    expect(html).toContain("@inventada.propiedades");
  });

  it("sin contacto ni gastos comunes no deja esas secciones; con un primario claro, texto oscuro", () => {
    const html = withoutFont(
      templates.specSheet(
        sheet({
          commonExpenses: null,
          availability: null,
          contact: { whatsapp: null, instagramHandle: null },
          brand: { ...brand, primaryColor: "#F5F5F5" },
        }),
      ),
    );

    expect(html).not.toContain("Gastos comunes");
    expect(html).not.toContain("Disponibilidad");
    expect(html).not.toContain('class="contact"');
    expect(html).toContain("color:#111827");
  });

  it("muestra a lo más 10 filas", () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      icon: "info" as const,
      label: `Dato ${i}`,
      value: "Sí",
    }));
    const html = withoutFont(
      templates.specSheet(sheet({ rows, contact: { whatsapp: null, instagramHandle: null } })),
    );
    expect(iconsIn(html)).toHaveLength(10);
  });
});

describe("texto del reel", () => {
  it("operación, tipo, comuna y precio, sobre fondo transparente", () => {
    const html = withoutFont(templates.reelOverlay(reel));

    expect(html).toContain("width:1080px;height:1920px");
    expect(html).toContain("background:transparent");
    expect(html).toContain('<div class="operation">VENTA</div>');
    expect(html).toContain('<div class="place">Departamento · Ñuñoa</div>');
    expect(html).toContain('<div class="price">UF 5.800</div>');
  });

  it("sin comuna, solo el tipo", () => {
    const html = withoutFont(templates.reelOverlay({ ...reel, comuna: null }));
    expect(html).toContain('<div class="place">Departamento</div>');
  });
});
