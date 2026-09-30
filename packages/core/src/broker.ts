import { z } from "zod";
import type { RawBrokerSheet } from "./listing-sheet.js";
import type { FieldIssue } from "./listing-validator/index.js";
import { foldText, isBlank, isRawCell, normalizeText } from "./listing-validator/normalizers.js";

/** Corredor (`brokers`): la entidad que devuelve el repositorio (ADR-0011). */
export const brokerSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  brandName: z.string(),
  logoMediaId: z.string().nullable(),
  primaryColor: z.string(),
  secondaryColor: z.string(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  instagramHandle: z.string().nullable(),
  website: z.string().nullable(),
  tone: z.string().nullable(),
  fixedHashtags: z.array(z.string()),
  autoPublish: z.boolean(),
});
export type Broker = z.infer<typeof brokerSchema>;

/** Datos del corredor que llena la hoja Corredor (no incluye el logo, que es un medio: F1-T07). */
export type BrokerData = Pick<
  Broker,
  | "slug"
  | "name"
  | "brandName"
  | "primaryColor"
  | "secondaryColor"
  | "whatsapp"
  | "email"
  | "instagramHandle"
  | "website"
  | "tone"
  | "fixedHashtags"
>;

/** Campos de la hoja Corredor que se copian a `BrokerData` (spec F1 §4.2). */
const BROKER_FIELDS = [
  "nombre_corredor",
  "nombre_marca",
  "logo",
  "color_primario",
  "color_secundario",
  "whatsapp",
  "email",
  "instagram",
  "sitio_web",
  "tono",
  "hashtags_fijos",
] as const;
type BrokerField = (typeof BROKER_FIELDS)[number];

export type ParsedBrokerSheet =
  | {
      ok: true;
      data: BrokerData;
      /** Nombre del archivo del logo (`logo.png`); lo sube la ingesta de medios (F1-T07). */
      logoFile: string | null;
      warnings: string[];
    }
  | { ok: false; issues: FieldIssue[]; warnings: string[] };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `slug` de un corredor: `VP Propiedades` → `vp-propiedades`. */
export function slugify(text: string): string {
  return foldText(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

/**
 * Hoja Corredor (`Campo` → `Tu valor`) → datos del corredor, con la tabla de §4.2:
 * - las etiquetas se comparan sin mayúsculas ni tildes; una repetida o desconocida es advertencia;
 * - obligatorios: `nombre_corredor`, `nombre_marca` y `color_primario` (HEX `#RRGGBB`);
 * - `color_secundario` vacío toma el primario; `instagram` sin `@`; `hashtags_fijos` por espacios;
 * - el `slug` sale de `nombre_marca`, salvo que venga uno explícito (`--broker`), que gana.
 */
export function parseBrokerSheet(
  sheet: RawBrokerSheet,
  options: { slug?: string } = {},
): ParsedBrokerSheet {
  const warnings: string[] = [];
  const values = new Map<BrokerField, string>();
  const seen = new Set<BrokerField>();
  const known = new Map(BROKER_FIELDS.map((field) => [foldText(field), field]));
  const issues: FieldIssue[] = [];
  const issue = (field: string, code: FieldIssue["code"], message: string) =>
    issues.push({ column: field, key: field, code, message });

  for (const [label, cell] of Object.entries(sheet)) {
    const field = known.get(foldText(label));
    if (field === undefined) {
      warnings.push(`Campo desconocido en la hoja Corredor: «${label}»`);
      continue;
    }
    if (seen.has(field)) {
      warnings.push(`Campo repetido en la hoja Corredor: «${label}» (vale el primero)`);
      continue;
    }
    seen.add(field);
    if (isBlank(cell)) continue;
    if (!isRawCell(cell)) {
      issue(field, "FIELD_VALUE_INVALID", "la celda tiene un formato que no se puede leer");
      continue;
    }
    const text = normalizeText(cell);
    if (!text.ok) issue(field, text.code, text.message);
    else values.set(field, text.value);
  }

  const required = (field: BrokerField) => {
    const value = values.get(field);
    if (value === undefined) issue(field, "FIELD_REQUIRED", "falta el valor (es obligatorio)");
    return value ?? "";
  };
  const optional = (field: BrokerField) => values.get(field) ?? null;

  const name = required("nombre_corredor");
  const brandName = required("nombre_marca");
  const primaryColor = required("color_primario");
  if (primaryColor && !HEX_COLOR.test(primaryColor)) {
    issue(
      "color_primario",
      "FIELD_VALUE_INVALID",
      `«${primaryColor}» no es un color HEX (#RRGGBB)`,
    );
  }
  const explicitSecondary = optional("color_secundario");
  const secondaryColor = explicitSecondary ?? primaryColor;
  // Heredado del primario, ya se validó arriba: no se repite el error.
  if (explicitSecondary !== null && !HEX_COLOR.test(explicitSecondary)) {
    issue(
      "color_secundario",
      "FIELD_VALUE_INVALID",
      `«${secondaryColor}» no es un color HEX (#RRGGBB)`,
    );
  }
  const email = optional("email");
  if (email !== null && !EMAIL.test(email)) {
    issue("email", "FIELD_VALUE_INVALID", `«${email}» no es un email`);
  }

  const slug = options.slug ?? slugify(brandName);
  if (brandName && !isValidSlug(slug)) {
    issue(
      options.slug === undefined ? "nombre_marca" : "broker",
      "FIELD_VALUE_INVALID",
      `«${slug}» no sirve como identificador del corredor (minúsculas, números y guiones)`,
    );
  }

  if (issues.length > 0) return { ok: false, issues, warnings };
  return {
    ok: true,
    data: {
      slug,
      name,
      brandName,
      primaryColor: primaryColor.toUpperCase(),
      secondaryColor: secondaryColor.toUpperCase(),
      whatsapp: optional("whatsapp"),
      email,
      instagramHandle: optional("instagram")?.replace(/^@+/, "") ?? null,
      website: optional("sitio_web"),
      tone: optional("tono"),
      fixedHashtags: (optional("hashtags_fijos") ?? "").split(/\s+/).filter(Boolean),
    },
    logoFile: optional("logo"),
    warnings,
  };
}

/** `true` si guardar `data` cambiaría el corredor (para informar `updated` o `unchanged`). */
export function brokerDiffers(broker: Broker, data: BrokerData): boolean {
  return (Object.keys(data) as (keyof BrokerData)[]).some((key) => {
    const current = broker[key];
    const next = data[key];
    return Array.isArray(current) && Array.isArray(next)
      ? current.length !== next.length || current.some((item, index) => item !== next[index])
      : current !== next;
  });
}
