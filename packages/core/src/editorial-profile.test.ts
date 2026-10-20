import { describe, expect, it } from "vitest";
import {
  type EditorialProfileInput,
  type EditorialProfileIssue,
  editorialProfileSchema,
  editorialProfileView,
  emptyEditorialProfileData,
  normalizeEditorialProfile,
} from "./editorial-profile.js";
import { AppError } from "./errors.js";

// F9-T09 (spec F9 §4.3): las reglas del perfil editorial al escribir.

const valid = (overrides: Partial<EditorialProfileInput> = {}): EditorialProfileInput => ({
  languages: ["es", "en"],
  audience: "Corredores independientes que quieren publicar sin perder tiempo",
  pillars: [
    { key: "producto", name: "Producto", description: "Lo que hace AgentSales", weight: 2 },
    { key: "bastidores", name: "Bastidores", weight: 1 },
  ],
  facts: ["AgentSales publica en Instagram", "Lo construye una sola persona"],
  avoid: ["promesas de venta"],
  cadence: {
    instagram: { postsPerWeek: 3, days: ["mon", "wed", "fri"], hours: ["10:00", "19:30"] },
  },
  defaultHashtags: ["#agentsales"],
  ...overrides,
});

/** Los problemas de un perfil inválido (falla si es válido). */
function issuesOf(input: EditorialProfileInput): EditorialProfileIssue[] {
  try {
    normalizeEditorialProfile(input);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("EDITORIAL_PROFILE_INVALID");
    return (error as AppError).details?.issues as EditorialProfileIssue[];
  }
  throw new Error("el perfil se aceptó");
}
const fieldsOf = (input: EditorialProfileInput) => issuesOf(input).map((issue) => issue.field);

describe("normalizeEditorialProfile", () => {
  it("normaliza un perfil válido: recorta, ordena días y horas, un # por hashtag y 6 h entre idiomas", () => {
    const data = normalizeEditorialProfile(
      valid({
        languages: [" EN ", "es"],
        audience: "  ",
        pillars: [{ key: " Producto ", name: " Producto ", description: " ", weight: 1 }],
        facts: [" Un hecho ", "", "Un hecho", "Otro hecho"],
        avoid: ["  ", "clientes inventados"],
        cadence: {
          x: { postsPerWeek: 5, days: ["fri", "MON", "mon"], hours: ["9:05", "18:00", "09:05"] },
          linkedin: { postsPerWeek: 1, languageGapHours: 12 },
        },
        defaultHashtags: ["##AgentSales chile", "#agentsales", "emprender,#ñandú_2"],
      }),
    );
    expect(data).toEqual({
      languages: ["en", "es"],
      audience: null,
      pillars: [{ key: "producto", name: "Producto", description: "", weight: 1 }],
      facts: ["Un hecho", "Otro hecho"],
      avoid: ["clientes inventados"],
      cadence: {
        x: {
          postsPerWeek: 5,
          days: ["mon", "fri"],
          hours: ["09:05", "18:00"],
          languageGapHours: 6,
        },
        linkedin: { postsPerWeek: 1, days: [], hours: [], languageGapHours: 12 },
      },
      defaultHashtags: ["#AgentSales", "#chile", "#emprender", "#ñandú_2"],
    });
    // Lo normalizado calza con la forma de la fila (lo que el repositorio lee de vuelta).
    const now = new Date();
    expect(
      editorialProfileSchema.safeParse({ brokerId: "b", ...data, createdAt: now, updatedAt: now })
        .success,
    ).toBe(true);
  });

  it("idiomas: 1 o 2 de LANGUAGES, sin repetir", () => {
    expect(fieldsOf(valid({ languages: [] }))).toEqual(["languages"]);
    expect(issuesOf(valid({ languages: ["es", "fr"] }))[0]?.message).toContain(
      "«fr» no es un idioma",
    );
    expect(issuesOf(valid({ languages: ["es", "ES"] }))[0]?.message).toContain("aparece dos veces");
    expect(issuesOf(valid({ languages: ["es", "en", "es"] })).map((i) => i.message)).toContain(
      "Idiomas: son 2 como máximo",
    );
  });

  it("líneas: claves únicas y válidas, nombre, pesos de 0 a 100 y al menos uno mayor que 0", () => {
    const pillar = { key: "a", name: "A", description: "", weight: 1 };
    expect(fieldsOf(valid({ pillars: [pillar, { ...pillar, name: "B" }] }))).toEqual([
      "pillars[1].key",
    ]);
    expect(fieldsOf(valid({ pillars: [{ ...pillar, key: "con espacio" }] }))).toEqual([
      "pillars[0].key",
    ]);
    expect(fieldsOf(valid({ pillars: [{ ...pillar, name: " " }] }))).toEqual(["pillars[0].name"]);
    expect(fieldsOf(valid({ pillars: [{ ...pillar, weight: -1 }] }))).toContain(
      "pillars[0].weight",
    );
    expect(fieldsOf(valid({ pillars: [{ ...pillar, weight: 101 }] }))).toEqual([
      "pillars[0].weight",
    ]);
    expect(fieldsOf(valid({ pillars: [{ ...pillar, weight: Number.NaN }] }))).toContain(
      "pillars[0].weight",
    );
    expect(
      issuesOf(
        valid({
          pillars: [
            { ...pillar, weight: 0 },
            { ...pillar, key: "b", weight: 0 },
          ],
        }),
      ).map((issue) => issue.message),
    ).toEqual(["Líneas de contenido: al menos una línea debe tener peso mayor que 0"]);
    // Sin líneas está bien (una marca nueva).
    expect(normalizeEditorialProfile(valid({ pillars: [] })).pillars).toEqual([]);
    const many = Array.from({ length: 13 }, (_, i) => ({ ...pillar, key: `l${i}` }));
    expect(fieldsOf(valid({ pillars: many }))).toEqual(["pillars"]);
  });

  it("hechos y cosas que evitar: tope de cantidad y de largo, sin saltos de línea", () => {
    const facts = Array.from({ length: 51 }, (_, i) => `Hecho ${i}`);
    expect(fieldsOf(valid({ facts }))).toEqual(["facts"]);
    expect(fieldsOf(valid({ facts: ["x".repeat(301)] }))).toEqual(["facts[0]"]);
    expect(fieldsOf(valid({ facts: ["uno\ndos"] }))).toEqual(["facts[0]"]);
    expect(fieldsOf(valid({ avoid: ["x".repeat(201)] }))).toEqual(["avoid[0]"]);
    expect(fieldsOf(valid({ audience: "x".repeat(501) }))).toEqual(["audience"]);
  });

  it("cadencia: solo redes de posts, posts por semana, días, horas y espacio entre idiomas válidos", () => {
    expect(issuesOf(valid({ cadence: { portal_inmobiliario: { postsPerWeek: 1 } } }))[0]).toEqual({
      code: "EDITORIAL_PROFILE_FIELD_INVALID",
      field: "cadence.portal_inmobiliario",
      message:
        "Cadencia: «portal_inmobiliario» no publica posts (usa instagram, x, linkedin, discord, tiktok)",
    });
    expect(fieldsOf(valid({ cadence: { fb_marketplace: { postsPerWeek: 1 } } }))).toEqual([
      "cadence.fb_marketplace",
    ]);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 22 } } }))).toEqual([
      "cadence.x.postsPerWeek",
    ]);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 1.5 } } }))).toEqual([
      "cadence.x.postsPerWeek",
    ]);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 1, days: ["lunes"] } } }))).toEqual([
      "cadence.x.days",
    ]);
    expect(
      fieldsOf(valid({ cadence: { x: { postsPerWeek: 1, hours: ["24:00", "10:60", "10"] } } })),
    ).toEqual(["cadence.x.hours", "cadence.x.hours", "cadence.x.hours"]);
    const hours = Array.from({ length: 9 }, (_, i) => `1${i}:00`);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 1, hours } } }))).toEqual([
      "cadence.x.hours",
    ]);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 1, languageGapHours: 0 } } }))).toEqual([
      "cadence.x.languageGapHours",
    ]);
    expect(fieldsOf(valid({ cadence: { x: { postsPerWeek: 1, languageGapHours: 49 } } }))).toEqual([
      "cadence.x.languageGapHours",
    ]);
  });

  it("hashtags: solo letras, números y _, sin repetir (sin importar mayúsculas), hasta 30", () => {
    expect(fieldsOf(valid({ defaultHashtags: ["#bien", "#mal-escrito"] }))).toEqual([
      "defaultHashtags",
    ]);
    expect(fieldsOf(valid({ defaultHashtags: ["#"] }))).toEqual(["defaultHashtags"]);
    expect(
      normalizeEditorialProfile(valid({ defaultHashtags: ["#Chile", "#chile"] })).defaultHashtags,
    ).toEqual(["#Chile"]);
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`);
    expect(fieldsOf(valid({ defaultHashtags: tags }))).toEqual(["defaultHashtags"]);
  });

  it("junta todos los problemas en un solo error, con el mensaje legible", () => {
    try {
      normalizeEditorialProfile(valid({ languages: ["fr"], defaultHashtags: ["#a-b"] }));
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).toBe(
        "Revisa el perfil editorial: Idiomas: «fr» no es un idioma (usa es o en); Hashtags: «#a-b» no es un hashtag (solo letras, números y _, hasta 100)",
      );
    }
  });
});

describe("editorialProfileView", () => {
  it("sin perfil, el vacío por defecto en español; con perfil, el guardado sin createdAt", () => {
    expect(editorialProfileView("b1", null)).toEqual({
      brokerId: "b1",
      ...emptyEditorialProfileData(),
      updatedAt: null,
    });
    expect(emptyEditorialProfileData().languages).toEqual(["es"]);
    const at = new Date("2026-10-20T12:00:00Z");
    const view = editorialProfileView("b1", {
      brokerId: "b1",
      ...emptyEditorialProfileData(),
      facts: ["Un hecho"],
      createdAt: at,
      updatedAt: at,
    });
    expect(view).not.toHaveProperty("createdAt");
    expect(view).toMatchObject({ facts: ["Un hecho"], updatedAt: at });
  });
});
