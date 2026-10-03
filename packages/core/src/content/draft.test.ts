import { describe, expect, it } from "vitest";
import {
  CONTENT_DRAFT_JSON_SCHEMA,
  CONTENT_DRAFT_LIMITS,
  contentDraftSchema,
  SAMPLE_CONTENT_DRAFT,
} from "./draft.js";

const LIMIT_KEYWORDS = [
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maximum",
  "minimum",
  "pattern",
];

/** Todas las claves de un JSON, a cualquier profundidad. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

const long = (length: number) => "a".repeat(length);

describe("contentDraftSchema y su JSON Schema", () => {
  it("el JSON Schema que va al proveedor es draft-07, sin largos ni topes y sin claves de más", () => {
    expect(CONTENT_DRAFT_JSON_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(keysOf(CONTENT_DRAFT_JSON_SCHEMA).filter((key) => LIMIT_KEYWORDS.includes(key))).toEqual(
      [],
    );
    expect(CONTENT_DRAFT_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ["instagram", "portal_inmobiliario", "fb_marketplace", "warnings"],
    });
  });

  it("el esquema estricto aplica los topes que el JSON Schema no lleva", () => {
    const withHook = (hook: string) => ({
      ...SAMPLE_CONTENT_DRAFT,
      instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, hook },
    });

    expect(contentDraftSchema.safeParse(withHook(long(CONTENT_DRAFT_LIMITS.hook))).success).toBe(
      true,
    );
    const tooLong = contentDraftSchema.safeParse(withHook(long(CONTENT_DRAFT_LIMITS.hook + 1)));
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.path).toEqual(["instagram", "hook"]);
  });

  it.each([
    ["un gancho vacío", { instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, hook: "   " } }],
    [
      "demasiados hashtags",
      {
        instagram: {
          ...SAMPLE_CONTENT_DRAFT.instagram,
          hashtags: Array.from({ length: CONTENT_DRAFT_LIMITS.hashtags + 1 }, (_, i) => `#h${i}`),
        },
      },
    ],
    [
      "una presentación demasiado larga",
      {
        portal_inmobiliario: {
          ...SAMPLE_CONTENT_DRAFT.portal_inmobiliario,
          presentation: long(CONTENT_DRAFT_LIMITS.presentation + 1),
        },
      },
    ],
    ["una clave de más", { title: "Título inventado por la IA" }],
    ["sin advertencias", { warnings: undefined }],
  ])("rechaza %s", (_, change) => {
    expect(contentDraftSchema.safeParse({ ...SAMPLE_CONTENT_DRAFT, ...change }).success).toBe(
      false,
    );
  });

  it("recorta los espacios y admite null en ubicación y condiciones", () => {
    const parsed = contentDraftSchema.parse({
      ...SAMPLE_CONTENT_DRAFT,
      instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, hook: "  Terraza al norte  " },
      portal_inmobiliario: { presentation: "Presentación.", location: null, conditions: null },
    });

    expect(parsed.instagram.hook).toBe("Terraza al norte");
    expect(parsed.portal_inmobiliario.location).toBeNull();
  });

  it("SAMPLE_CONTENT_DRAFT es un borrador válido y sin números", () => {
    expect(contentDraftSchema.parse(SAMPLE_CONTENT_DRAFT)).toEqual(SAMPLE_CONTENT_DRAFT);
    expect(JSON.stringify(SAMPLE_CONTENT_DRAFT)).not.toMatch(/\d/);
  });
});
