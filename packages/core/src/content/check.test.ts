import { describe, expect, it } from "vitest";
import type { Platform } from "../enums.js";
import type { Listing } from "../listing.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "../testing/index.js";
import { type AssembledText, assembleContents } from "./assemble.js";
import {
  buildContentCheckContext,
  type ContentCheckCode,
  checkContent,
  hasContentErrors,
} from "./check.js";
import { SAMPLE_CONTENT_DRAFT } from "./draft.js";

const broker = contentBrokerFixture();
const contextOf = (overrides: Partial<Listing> = {}) =>
  buildContentCheckContext(contentListingFixture(overrides), contentDefinitionsFixture(), broker);

/** Un texto con hashtags suficientes, para que solo aparezca lo que se prueba. */
const HASHTAGS = ["#nunoa", "#departamentoventa", "#propiedades", "#venta", "#departamento"];
const text = (body: string, overrides: Partial<AssembledText> = {}): AssembledText => ({
  title: null,
  body,
  hashtags: HASHTAGS,
  ...overrides,
});

/** Los códigos de la revisión de un cuerpo de Instagram (o de otro canal). */
const codesOf = (
  body: string,
  options: { platform?: Platform; listing?: Partial<Listing>; title?: string | null } = {},
): ContentCheckCode[] =>
  checkContent(
    options.platform ?? "instagram",
    text(body, { title: options.title ?? null }),
    contextOf(options.listing),
  ).map((check) => check.code);

describe("checkContent · NUMBER_NOT_IN_DATA", () => {
  it.each([
    ["el precio en UF con punto de miles", "Precio UF 5.800"],
    ["el precio sin punto", "Precio UF 5800"],
    ["la superficie con coma decimal", "72,5 m² útiles"],
    ["los gastos comunes", "GC aprox. $120.000"],
    ["los dormitorios y baños", "3 dormitorios y 2 baños"],
    ["el WhatsApp del corredor", "Escríbeme al +56 9 1111 2222"],
  ])("acepta %s", (_, body) => {
    expect(codesOf(body)).not.toContain("NUMBER_NOT_IN_DATA");
  });

  it.each([
    ["un precio inventado", "Precio UF 5.900", "5.900"],
    ["una superficie distinta", "72,6 m² útiles", "72,6"],
    ["una distancia inventada", "A 300 metros del metro", "300"],
  ])("marca %s", (_, body, raw) => {
    const checks = checkContent("instagram", text(body), contextOf());
    expect(checks).toContainEqual({
      code: "NUMBER_NOT_IN_DATA",
      severity: "error",
      message: `El número «${raw}» no está en los datos del aviso`,
    });
  });

  it("un número repetido se informa una vez, y también se revisa el título", () => {
    const checks = checkContent(
      "portal_inmobiliario",
      text("Son 4 dormitorios. Sí, 4.", { title: "Departamento 4 dormitorios" }),
      contextOf(),
    );
    expect(checks.filter((check) => check.code === "NUMBER_NOT_IN_DATA")).toHaveLength(1);
  });

  it("acepta números de los datos de texto (destacados, sector)", () => {
    const listing = {
      highlights: "Terraza de 20 m²",
      attributes: { ...contentListingFixture().attributes, sector_referencia: "Metro Línea 3" },
    };
    expect(codesOf("Terraza de 20 m², a pasos de la Línea 3", { listing })).not.toContain(
      "NUMBER_NOT_IN_DATA",
    );
  });
});

describe("checkContent · ADDRESS_EXPOSED", () => {
  it("con show_exact_address = false marca la calle, con o sin tildes y mayúsculas", () => {
    const listing = { address: "Av. Irarrázaval 1234, depto 5" };
    expect(codesOf("Ubicado en IRARRAZAVAL, cerca de todo", { listing })).toContain(
      "ADDRESS_EXPOSED",
    );
    expect(codesOf("Ubicado en Irarrázaval", { listing })).toContain("ADDRESS_EXPOSED");
    expect(codesOf("Ubicado en Ñuñoa", { listing })).not.toContain("ADDRESS_EXPOSED");
  });

  it("marca el número de la unidad", () => {
    expect(codesOf("Departamento 506 con vista")).toContain("ADDRESS_EXPOSED");
  });

  it("con show_exact_address = true no es una fuga", () => {
    const listing = { showExactAddress: true };
    expect(codesOf("En Calle Inventada 1234, depto 506", { listing })).not.toContain(
      "ADDRESS_EXPOSED",
    );
  });

  it("una calle que también es el sector de referencia no se marca", () => {
    const listing = {
      address: "Plaza Inventada 99",
      attributes: { ...contentListingFixture().attributes, sector_referencia: "Plaza Inventada" },
    };
    expect(codesOf("Frente a Plaza Inventada", { listing })).not.toContain("ADDRESS_EXPOSED");
  });
});

describe("checkContent · INTERNAL_NOTES_LEAK", () => {
  it("marca 6 palabras seguidas de las notas internas, sin importar tildes ni mayúsculas", () => {
    // Notas: "Dueño acepta ofertas bajo el precio publicado si pagan al contado".
    expect(codesOf("Ojo: DUENO ACEPTA OFERTAS BAJO EL PRECIO, consulta")).toContain(
      "INTERNAL_NOTES_LEAK",
    );
  });

  it("5 palabras seguidas no bastan", () => {
    expect(codesOf("El dueño acepta ofertas bajo el valor publicado")).not.toContain(
      "INTERNAL_NOTES_LEAK",
    );
  });

  it("notas de 3 a 5 palabras se buscan completas", () => {
    const listing = { internalNotes: "No mostrar el balcón" };
    expect(codesOf("Tip: no mostrar el balcón.", { listing })).toContain("INTERNAL_NOTES_LEAK");
  });
});

describe("checkContent · DISCRIMINATORY", () => {
  it.each([
    ["Solo chilenos", "nacionalidad"],
    ["No se aceptan extranjeros", "nacionalidad"],
    ["Sin niños", "hijos"],
    ["no se admiten hijos", "hijos"],
    ["Únicamente para casados", "estado civil"],
    ["Solo católicos", "religión"],
    ["Solo para menores de 40 años", "edad"],
    ["Mayores de 25 años", "edad"],
    ["Solo para MUJERES", "sexo"],
    ["Exclusivamente señoritas", "sexo"],
  ])("marca «%s» (%s)", (body, reason) => {
    const checks = checkContent("portal_inmobiliario", text(body), contextOf());
    expect(checks).toContainEqual({
      code: "DISCRIMINATORY",
      severity: "error",
      message: `Tiene un requisito discriminatorio (${reason})`,
    });
  });

  it.each([
    "Ideal para familias con niños",
    "Se aceptan mascotas",
    "Solo se pide aval y liquidaciones de sueldo",
    "Cerca de colegios para tus hijos",
  ])("no marca «%s»", (body) => {
    expect(codesOf(body, { platform: "portal_inmobiliario" })).not.toContain("DISCRIMINATORY");
  });
});

describe("checkContent · EMOJI_NOT_ALLOWED y TOO_LONG", () => {
  it("emojis en el título o la descripción de Portal son error; en Instagram no", () => {
    expect(codesOf("Linda casa 🏡", { platform: "portal_inmobiliario" })).toContain(
      "EMOJI_NOT_ALLOWED",
    );
    expect(
      codesOf("Linda casa", { platform: "portal_inmobiliario", title: "Casa ✨ en venta" }),
    ).toContain("EMOJI_NOT_ALLOWED");
    expect(codesOf("Remax® Propiedades", { platform: "portal_inmobiliario" })).not.toContain(
      "EMOJI_NOT_ALLOWED",
    );
    expect(codesOf("Linda casa 🏡")).not.toContain("EMOJI_NOT_ALLOWED");
  });

  it("el caption de Instagram se mide con los hashtags", () => {
    const body = "a".repeat(2200 - 2 - HASHTAGS.join(" ").length);
    const ctx = contextOf();
    expect(checkContent("instagram", text(body), ctx).map((c) => c.code)).not.toContain("TOO_LONG");
    expect(checkContent("instagram", text(`${body}a`), ctx)).toContainEqual({
      code: "TOO_LONG",
      severity: "error",
      message: "El caption tiene 2201 caracteres con los hashtags (máximo 2200)",
    });
  });

  it("el título de Portal y Marketplace sobre 60 caracteres", () => {
    const title = "Departamento en venta 3 dormitorios 2 baños en Ñuñoa centro"; // 59
    expect(codesOf("Texto", { platform: "fb_marketplace", title })).not.toContain("TOO_LONG");
    expect(codesOf("Texto", { platform: "fb_marketplace", title: `${title} y` })).toContain(
      "TOO_LONG",
    );
  });
});

describe("checkContent · advertencias", () => {
  it("un amenity o servicio cercano que no está en los datos, con plural y tildes", () => {
    const checks = checkContent("instagram", text("Con PISCINA y cerca del Metro"), contextOf());
    expect(checks).toContainEqual({
      code: "AMENITY_NOT_IN_DATA",
      severity: "warning",
      message: "Menciona «piscina», que no está en los datos del aviso",
    });
    expect(checks.map((check) => check.message)).toContain(
      "Menciona «metro», que no está en los datos del aviso",
    );
    // Quincho, gimnasio y terraza sí están (amenities y destacados).
    expect(codesOf("Quinchos, gimnasio y terraza")).not.toContain("AMENITY_NOT_IN_DATA");
    expect(codesOf("Metrópolis")).not.toContain("AMENITY_NOT_IN_DATA");
  });

  it("superlativos, con tildes y mayúsculas, en una sola advertencia", () => {
    const checks = checkContent("instagram", text("Una vista INCREÍBLE y única"), contextOf());
    expect(checks).toContainEqual({
      code: "SUPERLATIVE",
      severity: "warning",
      message: "Usa superlativos vacíos: «increible», «unica»",
    });
    expect(codesOf("Una vista despejada")).not.toContain("SUPERLATIVE");
  });

  it.each(["**Oferta** del mes", "## Detalles", "Mira [el tour](https://example.com)"])(
    "markdown en Instagram: «%s»",
    (body) => {
      expect(codesOf(body)).toContain("MARKDOWN");
    },
  );

  it("sin markdown: un hashtag pegado o un guion no lo son", () => {
    expect(codesOf("#nunoa al inicio\n- Cocina remodelada")).not.toContain("MARKDOWN");
    expect(codesOf("**Oferta**", { platform: "fb_marketplace" })).not.toContain("MARKDOWN");
  });

  it("menos de 5 o más de 12 hashtags en Instagram", () => {
    const ctx = contextOf();
    const count = (n: number) =>
      checkContent(
        "instagram",
        text("Texto", { hashtags: Array.from({ length: n }, (_, i) => `#h${i}`) }),
        ctx,
      ).map((check) => check.code);
    expect(count(4)).toContain("HASHTAG_COUNT");
    expect(count(5)).not.toContain("HASHTAG_COUNT");
    expect(count(12)).not.toContain("HASHTAG_COUNT");
    expect(count(13)).toContain("HASHTAG_COUNT");
  });
});

describe("checkContent sobre lo ensamblado", () => {
  const variants: [string, Partial<Listing>][] = [
    ["venta en UF", {}],
    [
      "arriendo en pesos con gastos comunes",
      {
        operation: "rent",
        propertyType: "Casa",
        priceAmount: 650000,
        priceCurrency: "CLP",
        attributes: { ...contentListingFixture().attributes, requisitos_arriendo: "Aval" },
      },
    ],
    [
      "sin estacionamientos, con dirección visible",
      {
        showExactAddress: true,
        attributes: { ...contentListingFixture().attributes, estacionamientos: 0 },
      },
    ],
  ];

  it.each(variants)(
    "un borrador limpio (SAMPLE_CONTENT_DRAFT) no tiene errores: %s",
    (_, listing) => {
      const ctx = contextOf(listing);
      const contents = assembleContents(ctx.brief, SAMPLE_CONTENT_DRAFT, ctx.contact);

      for (const platform of ["instagram", "portal_inmobiliario", "fb_marketplace"] as const) {
        const checks = checkContent(platform, contents[platform], ctx);
        expect(hasContentErrors(checks), `${platform}: ${JSON.stringify(checks)}`).toBe(false);
        expect(checks, platform).toEqual([]);
      }
    },
  );

  it("sin WhatsApp tampoco hay errores", () => {
    const ctx = buildContentCheckContext(
      contentListingFixture(),
      contentDefinitionsFixture(),
      contentBrokerFixture({ whatsapp: null }),
    );
    const contents = assembleContents(ctx.brief, SAMPLE_CONTENT_DRAFT, ctx.contact);
    expect(hasContentErrors(checkContent("instagram", contents.instagram, ctx))).toBe(false);
  });

  it("un número inventado por la IA sí es error", () => {
    const ctx = contextOf();
    const draft = {
      ...SAMPLE_CONTENT_DRAFT,
      instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, body: "A 5 minutos del centro." },
    };
    const checks = checkContent(
      "instagram",
      assembleContents(ctx.brief, draft, ctx.contact).instagram,
      ctx,
    );
    expect(hasContentErrors(checks)).toBe(true);
    expect(checks.map((check) => check.message)).toContain(
      "El número «5» no está en los datos del aviso",
    );
  });
});
