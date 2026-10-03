import { describe, expect, it } from "vitest";
import type { Listing } from "../listing.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "../testing/index.js";
import {
  assembleContents,
  HASHTAGS_MAX,
  HASHTAGS_MIN,
  hasEmoji,
  INSTAGRAM_CAPTION_MAX_LENGTH,
  instagramCaption,
  LISTING_TITLE_MAX_LENGTH,
  listingTitle,
  normalizeHashtag,
  stripEmoji,
} from "./assemble.js";
import { buildContentBrief, type ContentBrief } from "./brief.js";
import { type ContentDraft, SAMPLE_CONTENT_DRAFT } from "./draft.js";

const broker = contentBrokerFixture();
const contact = { whatsapp: broker.whatsapp };

const briefOf = (overrides: Partial<Listing> = {}, b = broker) =>
  buildContentBrief(contentListingFixture(overrides), contentDefinitionsFixture(), b);

const attributes = (changes: Record<string, unknown>) => ({
  ...contentListingFixture().attributes,
  ...changes,
});

const DRAFT: ContentDraft = {
  instagram: {
    hook: "Terraza con vista despejada para tus mañanas",
    body: "Cocina remodelada y espacios bien distribuidos.\nCerca de Plaza Inventada.",
    hashtags: ["#PlazaInventada", "#Ñuñoa", "vida en el barrio"],
  },
  portal_inmobiliario: {
    presentation: "Departamento con terraza y cocina remodelada, listo para habitar. 🏡",
    location: "Ubicado cerca de Plaza Inventada.",
    conditions: "Se solicita aval.",
  },
  fb_marketplace: { intro: "Te comparto este departamento con terraza y cocina remodelada." },
  warnings: [],
};

describe("assembleContents · Instagram", () => {
  it("venta en UF: tipo y comuna, gancho, datos, precio con GC, texto de la IA y WhatsApp", () => {
    const { instagram } = assembleContents(briefOf(), DRAFT, contact);

    expect(instagram.title).toBeNull();
    expect(instagram.body).toBe(
      [
        "🏢 Departamento en venta · Ñuñoa",
        "Terraza con vista despejada para tus mañanas",
        "",
        "📐 72,5 m² útiles · 🛏 3 dorm · 🛁 2 baños · 🚗 1 est",
        "💰 UF 5.800 | GC aprox. $120.000",
        "",
        "Cocina remodelada y espacios bien distribuidos.",
        "Cerca de Plaza Inventada.",
        "",
        "📩 Escríbeme por DM o al WhatsApp +56 9 1111 2222",
      ].join("\n"),
    );
    expect(instagram.hashtags).toEqual([
      "#nunoa",
      "#departamentoventa",
      "#inventadapropiedades",
      "#propiedades",
      "#plazainventada",
      "#vidaenelbarrio",
    ]);
    expect(instagramCaption(instagram)).toBe(
      `${instagram.body}\n\n${instagram.hashtags.join(" ")}`,
    );
  });

  it("arriendo en pesos con gastos comunes: precio mensual", () => {
    const brief = briefOf({
      operation: "rent",
      propertyType: "Casa",
      priceAmount: 650000,
      priceCurrency: "CLP",
      attributes: attributes({ gastos_comunes_clp: 45000, banos: 1 }),
    });
    const { instagram } = assembleContents(brief, DRAFT, contact);

    expect(instagram.body).toContain("🏡 Casa en arriendo · Ñuñoa");
    expect(instagram.body).toContain("🛁 1 baño ·");
    expect(instagram.body).toContain("💰 $650.000/mes | GC aprox. $45.000");
    expect(instagram.hashtags.slice(0, 2)).toEqual(["#nunoa", "#casaarriendo"]);
  });

  it("sin estacionamientos ni gastos comunes: sin 🚗 ni GC", () => {
    const brief = briefOf({
      attributes: attributes({ estacionamientos: 0, gastos_comunes_clp: undefined }),
    });
    const { instagram } = assembleContents(brief, DRAFT, contact);

    expect(instagram.body).toContain("📐 72,5 m² útiles · 🛏 3 dorm · 🛁 2 baños\n");
    expect(instagram.body).not.toContain("🚗");
    expect(instagram.body).toContain("💰 UF 5.800\n");
  });

  it("sin WhatsApp: solo DM", () => {
    const { instagram } = assembleContents(briefOf(), DRAFT, { whatsapp: null });

    expect(instagram.body.endsWith("📩 Escríbeme por DM")).toBe(true);
    expect(instagram.body).not.toContain("WhatsApp");
  });

  it("los hashtags se completan hasta 5 y se cortan en 12", () => {
    const few = assembleContents(
      briefOf({}, { ...broker, fixedHashtags: [] }),
      { ...DRAFT, instagram: { ...DRAFT.instagram, hashtags: [] } },
      contact,
    ).instagram.hashtags;
    const many = assembleContents(
      briefOf(),
      {
        ...DRAFT,
        instagram: {
          ...DRAFT.instagram,
          hashtags: Array.from({ length: 10 }, (_, i) => `#extra${i}`),
        },
      },
      contact,
    ).instagram.hashtags;

    expect(few).toEqual([
      "#nunoa",
      "#departamentoventa",
      "#departamento",
      "#venta",
      "#propiedades",
    ]);
    expect(few).toHaveLength(HASHTAGS_MIN);
    expect(many).toHaveLength(HASHTAGS_MAX);
    // Los de la IA son los primeros en salir: los base y los del corredor quedan.
    expect(many.slice(0, 4)).toEqual([
      "#nunoa",
      "#departamentoventa",
      "#inventadapropiedades",
      "#propiedades",
    ]);
  });

  it("si pasa de 2.200 caracteres, recorta el texto de la IA y deja el resto", () => {
    const longBody = Array.from({ length: 400 }, () => "Texto").join(" ");
    const { instagram } = assembleContents(
      briefOf(),
      { ...DRAFT, instagram: { ...DRAFT.instagram, body: longBody } },
      contact,
    );
    const caption = instagramCaption(instagram);

    expect(longBody.length).toBeGreaterThan(INSTAGRAM_CAPTION_MAX_LENGTH);
    expect(caption.length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_LENGTH);
    expect(caption.length).toBeGreaterThan(INSTAGRAM_CAPTION_MAX_LENGTH - 10);
    expect(instagram.body).toContain("Texto Texto…\n\n📩 Escríbeme por DM o al WhatsApp");
    expect(instagram.body).toContain("💰 UF 5.800 | GC aprox. $120.000");
    expect(instagram.hashtags.length).toBeGreaterThanOrEqual(HASHTAGS_MIN);
  });

  it("si ni recortando cabe el texto de la IA, se quita ese párrafo", () => {
    // Un gancho (sin pasar por el esquema) que deja solo 5 caracteres libres: el cuerpo no cabe.
    const brief = briefOf();
    const draftWith = (hook: string, body: string) => ({
      ...DRAFT,
      instagram: { ...DRAFT.instagram, hook, body },
    });
    const base = instagramCaption(assembleContents(brief, draftWith("", ""), contact).instagram);
    const hook = "g".repeat(INSTAGRAM_CAPTION_MAX_LENGTH - base.length - 5);

    const { instagram } = assembleContents(brief, draftWith(hook, DRAFT.instagram.body), contact);

    expect(instagramCaption(instagram).length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_LENGTH);
    expect(instagram.body).not.toContain("Cocina remodelada");
    expect(instagram.body).toContain("💰 UF 5.800 | GC aprox. $120.000\n\n📩 Escríbeme por DM");
  });

  it("sin operación, tipo ni comuna: 🏠 Propiedad y hashtags igual entre 5 y 12", () => {
    const { instagram } = assembleContents(
      { ...briefOf(), operation: null, propertyType: null, comuna: null },
      DRAFT,
      contact,
    );

    expect(instagram.body.startsWith("🏠 Propiedad\nTerraza")).toBe(true);
    expect(instagram.hashtags[0]).toBe("#propiedad");
    expect(instagram.hashtags.length).toBeGreaterThanOrEqual(HASHTAGS_MIN);
  });

  it("normaliza los hashtags de la IA y descarta los vacíos o de más de 50", () => {
    const { instagram } = assembleContents(
      briefOf(),
      {
        ...DRAFT,
        instagram: {
          ...DRAFT.instagram,
          hashtags: ["#Línea 3", "##ÑUÑOA", "🏡", `#${"a".repeat(51)}`, "#vida_2026"],
        },
      },
      contact,
    );

    expect(instagram.hashtags).toEqual([
      "#nunoa",
      "#departamentoventa",
      "#inventadapropiedades",
      "#propiedades",
      "#linea3",
      "#vida_2026",
    ]);
  });
});

describe("listingTitle (Portal y Marketplace)", () => {
  const title = (changes: Partial<ContentBrief>) => listingTitle({ ...briefOf(), ...changes });

  it("operación, tipo, dormitorios, baños y comuna, sin abreviaturas", () => {
    expect(title({})).toBe("Departamento en venta 3 dormitorios 2 baños en Ñuñoa");
  });

  it("singular con 1 y sin dormitorios ni baños si son 0", () => {
    expect(title({ bedrooms: 1, bathrooms: 1 })).toBe(
      "Departamento en venta 1 dormitorio 1 baño en Ñuñoa",
    );
    expect(title({ bedrooms: 0, bathrooms: 1 })).toBe("Departamento en venta 1 baño en Ñuñoa");
    expect(title({ operation: "rent", propertyType: "Oficina", bedrooms: 0, bathrooms: 0 })).toBe(
      "Oficina en arriendo en Ñuñoa",
    );
  });

  it("sobre 60 caracteres quita primero los baños y después los dormitorios", () => {
    const withoutBaths = title({ propertyType: "Local comercial", comuna: "Comuna Inventada" });
    const withoutBoth = title({
      propertyType: "Local comercial",
      comuna: "Comuna Inventada Larga",
    });

    expect(withoutBaths).toBe("Local comercial en venta 3 dormitorios en Comuna Inventada");
    expect(withoutBoth).toBe("Local comercial en venta en Comuna Inventada Larga");
    for (const text of [withoutBaths, withoutBoth]) {
      expect(text.length).toBeLessThanOrEqual(LISTING_TITLE_MAX_LENGTH);
    }
  });

  it("si ni así cabe, se recorta en palabras enteras, sin terminar en de, la o en", () => {
    expect(
      title({
        propertyType: "Local comercial",
        comuna: "Lo Barnechea Oriente de la Ciudad de Santiago",
      }),
    ).toBe("Local comercial en venta en Lo Barnechea Oriente");
    expect(title({ comuna: "Comuna Inventada Con Un Nombre Larguísimo Que No Cabe" })).toBe(
      "Departamento en venta en Comuna Inventada Con Un Nombre",
    );
  });

  it("sin operación, tipo ni comuna: solo lo que hay", () => {
    expect(title({ operation: null, propertyType: null, comuna: null })).toBe(
      "Propiedad 3 dormitorios 2 baños",
    );
  });
});

describe("assembleContents · Portal Inmobiliario", () => {
  it("presentación, características, espacios comunes, ubicación, condiciones y cierre", () => {
    const { portal_inmobiliario: portal } = assembleContents(briefOf(), DRAFT, contact);

    expect(portal.title).toBe("Departamento en venta 3 dormitorios 2 baños en Ñuñoa");
    expect(portal.hashtags).toEqual([]);
    expect(portal.body).toBe(
      [
        "Departamento con terraza y cocina remodelada, listo para habitar.",
        "",
        "Características:",
        "- Gastos comunes: $120.000",
        "- Superficie útil: 72,5 m²",
        "- Superficie total: 80 m²",
        "- Dormitorios: 3",
        "- Baños: 2",
        "- Estacionamientos: 1",
        "- Bodegas: 1",
        "- Orientación: Norte",
        "- Amoblado: No",
        "",
        "Espacios comunes:",
        "- Quincho",
        "- Gimnasio",
        "",
        "Ubicación y conectividad:",
        "Ubicado cerca de Plaza Inventada.",
        "",
        "Condiciones:",
        "Disponibilidad: Inmediata.",
        "Se solicita aval.",
        "",
        "Si te interesa, coordina una visita a través de Portal Inmobiliario.",
      ].join("\n"),
    );
  });

  it("sin emojis, sin teléfono ni email, y sin las secciones que no tienen datos", () => {
    const brief = briefOf({
      propertyType: "Casa",
      attributes: { dormitorios: 2, amenities: [], disponibilidad: "Inmediata 🔑" },
    });
    const { portal_inmobiliario: portal } = assembleContents(
      brief,
      {
        ...DRAFT,
        portal_inmobiliario: {
          presentation: "✨ Casa luminosa 🏡👨‍👩‍👧",
          location: null,
          conditions: null,
        },
      },
      contact,
    );

    expect(portal.body).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(portal.body).not.toContain("+56");
    expect(portal.body).not.toContain("@");
    expect(portal.body).not.toContain("Espacios comunes:");
    expect(portal.body).not.toContain("Ubicación y conectividad:");
    expect(portal.body).toContain("Casa luminosa\n\nCaracterísticas:\n- Dormitorios: 2");
    expect(portal.body).toContain("Condiciones:\nDisponibilidad: Inmediata.");
  });

  it("también quita los emojis que vienen de la planilla en características y amenities", () => {
    const brief = briefOf({
      attributes: attributes({ orientacion: "Norte ☀️", amenities: ["Piscina 🏊", "Quincho"] }),
    });
    const { portal_inmobiliario: portal } = assembleContents(brief, DRAFT, contact);

    expect(portal.body).toContain("- Orientación: Norte\n");
    expect(portal.body).toContain("- Piscina\n- Quincho");
    expect(portal.body).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("la disponibilidad que ya termina en punto no queda con dos", () => {
    const brief = briefOf({ attributes: attributes({ disponibilidad: "Desde marzo." }) });
    const { portal_inmobiliario: portal } = assembleContents(brief, DRAFT, contact);

    expect(portal.body).toContain("Disponibilidad: Desde marzo.\n");
  });
});

describe("assembleContents · Marketplace", () => {
  it("introducción, datos principales, precio y WhatsApp, con el título de Portal", () => {
    const { fb_marketplace: marketplace } = assembleContents(briefOf(), DRAFT, contact);

    expect(marketplace.title).toBe("Departamento en venta 3 dormitorios 2 baños en Ñuñoa");
    expect(marketplace.body).toBe(
      [
        "Te comparto este departamento con terraza y cocina remodelada.",
        "",
        "🏠 Departamento en venta · Ñuñoa · Cerca de Plaza Inventada",
        "3 dormitorios · 2 baños · 72,5 m² útiles · 1 estacionamiento",
        "💰 UF 5.800 · GC aprox. $120.000",
        "Disponibilidad: Inmediata",
        "",
        "📲 Escríbeme al WhatsApp +56 9 1111 2222",
      ].join("\n"),
    );
  });

  it("sin WhatsApp, sin estacionamientos y con la dirección solo si se puede mostrar", () => {
    const hidden = assembleContents(briefOf(), DRAFT, { whatsapp: null }).fb_marketplace;
    const shown = assembleContents(
      briefOf({ showExactAddress: true, attributes: attributes({ estacionamientos: 0 }) }),
      DRAFT,
      contact,
    ).fb_marketplace;

    expect(hidden.body).toContain("📲 Escríbeme por Marketplace para coordinar una visita.");
    expect(hidden.body).not.toContain("Calle Inventada");
    expect(shown.body).toContain("· Calle Inventada 1234");
    expect(shown.body).toContain("3 dormitorios · 2 baños · 72,5 m² útiles\n");
  });
});

describe("ayudas del ensamblado", () => {
  it.each([
    ["Ñuñoa", "#nunoa"],
    ["#Plaza Ñuñoa", "#plazanunoa"],
    ["##Doble", "#doble"],
    ["vida_en_barrio!", "#vida_en_barrio"],
    ["#", null],
    ["🏡", null],
    [`#${"a".repeat(51)}`, null],
  ])("normalizeHashtag(%j) → %j", (tag, expected) => {
    expect(normalizeHashtag(tag)).toBe(expected);
  });

  it("stripEmoji quita emojis, banderas y modificadores sin dejar espacios dobles", () => {
    expect(stripEmoji("Hola 👋🏽 casa 🏡 y 🇨🇱 bandera ❤️ fin")).toBe("Hola casa y bandera fin");
  });

  it("stripEmoji y hasEmoji dejan ©, ® y ™ de las marcas", () => {
    expect(stripEmoji("Remax® Marca™ ©2026 ✔")).toBe("Remax® Marca™ ©2026");
    expect(hasEmoji("Remax® Marca™")).toBe(false);
    expect(hasEmoji("Casa 🏡")).toBe(true);
  });

  it("el borrador de ejemplo arma textos para cualquier aviso", () => {
    const contents = assembleContents(briefOf(), SAMPLE_CONTENT_DRAFT, contact);

    expect(Object.keys(contents)).toEqual(["instagram", "portal_inmobiliario", "fb_marketplace"]);
    expect(contents.instagram.body).toContain(SAMPLE_CONTENT_DRAFT.instagram.hook);
  });
});
