import { z } from "zod";
import { BROKER_KINDS } from "./enums.js";
import { AppError, isAppError } from "./errors.js";
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
  /** Corredor propio del operador (spec F7 §4.7, ADR-0023): su plan de Claude y Marketplace automático. */
  operatorOwned: z.boolean(),
  /** Tope de gasto de IA del mes en dólares; `null` = sin tope (spec F7 §4.7). */
  llmMonthlyCapUsd: z.number().nonnegative().nullable(),
  /**
   * `broker` (con propiedades) o `brand` (una marca que solo publica posts), F9 y ADR-0029: dice qué
   * ve el panel y **no decide permisos** (eso es de `can`, `permissions.ts`).
   */
  kind: z.enum(BROKER_KINDS),
});
export type Broker = z.infer<typeof brokerSchema>;

// Reglas de sujeto (ADR-0029 punto 12): predicados de core y no `CHECK` de la base, para poder
// relajarlas. Un post (F9) puede colgar de cualquier corredor o marca; un aviso, no.

/** Si el corredor puede tener propiedades: solo uno con `kind = broker`. */
export const brokerHoldsListings = (broker: Pick<Broker, "kind">): boolean =>
  broker.kind === "broker";

/**
 * `BROKER_IS_BRAND` (409) si el corredor es una marca: a una marca no se le cargan propiedades.
 */
export function assertBrokerHoldsListings(broker: Pick<Broker, "kind" | "slug">): void {
  if (!brokerHoldsListings(broker)) {
    throw new AppError(
      "BROKER_IS_BRAND",
      `${broker.slug} es una marca: no tiene propiedades (carga las propiedades en un corredor)`,
      { details: { slug: broker.slug } },
    );
  }
}

/**
 * Si la publicación automática (F6, ADR-0019) se puede activar: es de los avisos, así que no en una
 * marca (y nunca aplica a los posts, ADR-0030 punto 4).
 */
export const autoPublishAllowed = (broker: Pick<Broker, "kind">): boolean =>
  brokerHoldsListings(broker);

/** `BROKER_IS_BRAND` (409) al activar la publicación automática de una marca. */
export function assertAutoPublishAllowed(broker: Pick<Broker, "kind" | "slug">): void {
  if (!autoPublishAllowed(broker)) {
    throw new AppError(
      "BROKER_IS_BRAND",
      `${broker.slug} es una marca: la publicación automática es de las propiedades y no se activa en una marca`,
      { details: { slug: broker.slug } },
    );
  }
}

/** El tope de IA más alto que admite la base (`numeric(10,2)`). */
const MAX_LLM_MONTHLY_CAP_USD = 99_999_999.99;

/**
 * El tope de IA del mes, redondeado a centavos; `null` = sin tope. `BROKER_SETTINGS_INVALID`
 * (400) si no es un número finito entre 0 y el máximo de la base (spec F7 §4.7).
 */
export function normalizeLlmMonthlyCap(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_LLM_MONTHLY_CAP_USD) {
    throw new AppError(
      "BROKER_SETTINGS_INVALID",
      "El tope de IA debe ser un monto en dólares entre 0 y 99.999.999,99",
    );
  }
  return Math.round(value * 100) / 100;
}

/**
 * Un monto en dólares escrito por una persona (el tope de IA en el panel y en la CLI, F7):
 * `12`, `12,50`, `12.50`, `1.000,50` o `US$ 20`. Vacío = `null` (sin tope). Lo que no es un monto
 * mayor o igual a 0 es `BROKER_SETTINGS_INVALID`: nunca se manda como "sin tope" (frenaría menos).
 */
export function parseUsdAmount(text: string): number | null {
  const cleaned = text.replace(/US\$|\$|\s/gi, "");
  if (cleaned === "") return null;
  // Con punto y coma, el punto separa miles; con solo coma, la coma es el decimal.
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const value = /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new AppError(
      "BROKER_SETTINGS_INVALID",
      `«${text.trim()}» no es un monto en dólares (por ejemplo 20 o 12,50)`,
    );
  }
  return value;
}

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
  | {
      ok: false;
      /** Slug que habría tenido el corredor, para el reporte; `null` si no hay marca ni `--broker`. */
      slug: string | null;
      issues: FieldIssue[];
      warnings: string[];
    };

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
 * Las celdas de la hoja Corredor por campo, ya como texto: las etiquetas se comparan sin mayúsculas
 * ni tildes; una repetida o desconocida es advertencia, y una celda ilegible, un problema del campo.
 */
function readBrokerSheetCells(sheet: RawBrokerSheet): {
  values: Map<BrokerField, string>;
  issues: FieldIssue[];
  warnings: string[];
} {
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
  return { values, issues, warnings };
}

/**
 * Hoja Corredor (`Campo` → `Tu valor`) → datos del corredor, con la tabla de §4.2:
 * - las etiquetas se comparan sin mayúsculas ni tildes; una repetida o desconocida es advertencia;
 * - obligatorios: `nombre_corredor`, `nombre_marca` y `color_primario` (HEX `#RRGGBB`);
 * - `color_secundario` vacío toma el primario; `instagram` sin `@`;
 * - `hashtags_fijos` se separa por espacios (o comas), sin repetidos y con `#` adelante;
 * - el `slug` sale de `nombre_marca`, salvo que venga uno explícito (`--broker`), que gana.
 */
export function parseBrokerSheet(
  sheet: RawBrokerSheet,
  options: { slug?: string } = {},
): ParsedBrokerSheet {
  const { values, issues, warnings } = readBrokerSheetCells(sheet);
  const issue = (field: string, code: FieldIssue["code"], message: string) =>
    issues.push({ column: field, key: field, code, message });

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

  if (issues.length > 0) {
    return { ok: false, slug: slug || null, issues, warnings };
  }
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
      fixedHashtags: parseHashtags(optional("hashtags_fijos")),
    },
    logoFile: optional("logo"),
    warnings,
  };
}

/** `#uno #dos`, `uno, dos` o `#uno #uno` → `["#uno", "#dos"]`: con `#` y sin repetidos. */
function parseHashtags(text: string | null): string[] {
  const tags = (text ?? "")
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`);
  return [...new Set(tags)];
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

/** La marca que edita un corredor (o el administrador) desde la API: todo menos el `slug`. */
export type BrokerBrand = Omit<BrokerData, "slug">;

/** Lo que llega de la API, sin normalizar; `null` o `""` borra un campo opcional. */
export type BrokerBrandInput = {
  [K in keyof BrokerBrand]?: K extends "fixedHashtags" ? string[] : string | null;
};

/** Un campo de la marca que no sirve (spec F7 §4.6), con su motivo. */
export type BrokerFieldIssue = {
  /** `BROKER_FIELD_INVALID` (la forma de los `issues` de la API, seguimiento de ADR-0011). */
  code: "BROKER_FIELD_INVALID";
  /** El campo de la API (`primaryColor`), para marcarlo en el formulario. */
  field: keyof BrokerData;
  /** En español, con la etiqueta del campo: «Color primario: «rojo» no es un color HEX». */
  message: string;
};

/** Las etiquetas de los campos de la marca, para los mensajes. */
const BROKER_FIELD_LABELS: Record<keyof BrokerData, string> = {
  slug: "Identificador",
  name: "Nombre",
  brandName: "Marca",
  primaryColor: "Color primario",
  secondaryColor: "Color secundario",
  whatsapp: "WhatsApp",
  email: "Correo",
  instagramHandle: "Instagram",
  website: "Sitio web",
  tone: "Tono",
  fixedHashtags: "Hashtags fijos",
};

/** Un problema de un campo, con su etiqueta en el mensaje. */
export const brokerFieldIssue = (field: keyof BrokerData, problem: string): BrokerFieldIssue => ({
  code: "BROKER_FIELD_INVALID",
  field,
  message: `${BROKER_FIELD_LABELS[field]}: ${problem}`,
});

/** Los largos máximos de la marca (también los usa el contrato de la API). */
export const BRAND_TEXT_MAX = 200;
export const TONE_MAX = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: justamente los que se rechazan
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * La marca de la API con las reglas de la hoja Corredor (`parseBrokerSheet`): nombre y marca
 * obligatorios, colores HEX `#RRGGBB` en mayúsculas, correo válido, Instagram sin `@`, hashtags
 * con `#` y sin repetidos. Solo trae los campos que vinieron. `BROKER_INVALID` (400)
 * con la lista de lo que no sirve.
 */
export function normalizeBrokerBrand(input: BrokerBrandInput): Partial<BrokerBrand> {
  const issues: BrokerFieldIssue[] = [];
  const out: Partial<BrokerBrand> = {};
  const text = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  };
  // Caracteres de control (un `\u0000` que Postgres rechaza, saltos de línea en un nombre).
  for (const [field, value] of Object.entries(input)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item === "string" && CONTROL_CHARS.test(item))) {
      issues.push(brokerFieldIssue(field as keyof BrokerData, "tiene caracteres no permitidos"));
    }
  }
  const tooLong = (field: keyof BrokerData, value: string | null, max: number) => {
    if (value !== null && value.length > max) {
      issues.push(brokerFieldIssue(field, `es demasiado largo (máximo ${max} caracteres)`));
    }
  };
  for (const field of ["name", "brandName"] as const) {
    if (input[field] === undefined) continue;
    const value = text(input[field]);
    if (value === null) issues.push(brokerFieldIssue(field, "falta el valor (es obligatorio)"));
    else {
      tooLong(field, value, BRAND_TEXT_MAX);
      out[field] = value;
    }
  }
  for (const field of ["primaryColor", "secondaryColor"] as const) {
    if (input[field] === undefined) continue;
    const value = text(input[field]);
    if (value === null || !HEX_COLOR.test(value)) {
      issues.push(brokerFieldIssue(field, `«${value ?? ""}» no es un color HEX (#RRGGBB)`));
    } else out[field] = value.toUpperCase();
  }
  for (const field of ["whatsapp", "website", "tone"] as const) {
    if (input[field] === undefined) continue;
    const value = text(input[field]);
    tooLong(field, value, field === "tone" ? TONE_MAX : BRAND_TEXT_MAX);
    out[field] = value;
  }
  if (input.email !== undefined) {
    const value = text(input.email);
    if (value !== null && !EMAIL.test(value)) {
      issues.push(brokerFieldIssue("email", `«${value}» no es un email`));
    }
    tooLong("email", value, BRAND_TEXT_MAX);
    out.email = value;
  }
  if (input.instagramHandle !== undefined) {
    const value = text(input.instagramHandle)?.replace(/^@+/, "") ?? null;
    tooLong("instagramHandle", value, BRAND_TEXT_MAX);
    out.instagramHandle = value === "" ? null : value;
  }
  if (input.fixedHashtags !== undefined) {
    out.fixedHashtags = parseHashtags(input.fixedHashtags.join(" "));
  }
  if (issues.length > 0) {
    throw new AppError(
      "BROKER_INVALID",
      `Revisa los datos del corredor: ${issues.map((issue) => issue.message).join("; ")}`,
      { details: { issues } },
    );
  }
  return out;
}

/**
 * Lo que la hoja Corredor de una planilla deja en el formulario de **Crear un corredor**
 * (F9.5-T16): los campos de la marca ya normalizados, `null` (o `[]`) los que vinieron vacíos.
 */
export type BrokerSheetDraft = {
  [K in keyof BrokerBrand]: K extends "fixedHashtags" ? string[] : string | null;
} & {
  /** El archivo del logo que nombra la hoja: aquí no se sube (se sube en el detalle del corredor). */
  logoFile: string | null;
  /** Etiquetas desconocidas o repetidas de la hoja. */
  warnings: string[];
};

/** El campo de la API de cada campo de la hoja Corredor (el logo va aparte). */
const SHEET_TO_BRAND: Record<Exclude<BrokerField, "logo">, keyof BrokerBrand> = {
  nombre_corredor: "name",
  nombre_marca: "brandName",
  color_primario: "primaryColor",
  color_secundario: "secondaryColor",
  whatsapp: "whatsapp",
  email: "email",
  instagram: "instagramHandle",
  sitio_web: "website",
  tono: "tone",
  hashtags_fijos: "fixedHashtags",
};

/**
 * La hoja Corredor → el borrador del formulario de crear un corredor (F9.5-T16), **sin guardar
 * nada**: lo que falta queda vacío para llenarlo en el formulario (los colores toman un valor por
 * defecto en el panel), y lo que vino se revisa con las reglas de la marca (`normalizeBrokerBrand`).
 * Un valor que no sirve (o una celda ilegible) es `BROKER_INVALID` (400) con sus `issues` por campo.
 */
export function brokerSheetDraft(sheet: RawBrokerSheet): BrokerSheetDraft {
  const { values, issues: cellIssues, warnings } = readBrokerSheetCells(sheet);
  const issues: BrokerFieldIssue[] = cellIssues.flatMap((issue) =>
    issue.column === "logo"
      ? []
      : [
          brokerFieldIssue(
            SHEET_TO_BRAND[issue.column as keyof typeof SHEET_TO_BRAND],
            issue.message,
          ),
        ],
  );
  const input: BrokerBrandInput = {};
  for (const [field, key] of Object.entries(SHEET_TO_BRAND) as [
    keyof typeof SHEET_TO_BRAND,
    keyof BrokerBrand,
  ][]) {
    const value = values.get(field);
    if (value === undefined) continue;
    if (key === "fixedHashtags") input.fixedHashtags = [value];
    else input[key] = value;
  }
  let brand: Partial<BrokerBrand> = {};
  try {
    brand = normalizeBrokerBrand(input);
  } catch (error) {
    const found = isAppError(error) ? error.details?.issues : undefined;
    if (!Array.isArray(found)) throw error;
    issues.push(...(found as BrokerFieldIssue[]));
  }
  if (issues.length > 0) {
    throw new AppError(
      "BROKER_INVALID",
      `La hoja Corredor tiene valores que no sirven: ${issues.map((issue) => issue.message).join("; ")}`,
      { details: { issues } },
    );
  }
  return {
    name: brand.name ?? null,
    brandName: brand.brandName ?? null,
    primaryColor: brand.primaryColor ?? null,
    secondaryColor: brand.secondaryColor ?? null,
    whatsapp: brand.whatsapp ?? null,
    email: brand.email ?? null,
    instagramHandle: brand.instagramHandle ?? null,
    website: brand.website ?? null,
    tone: brand.tone ?? null,
    fixedHashtags: brand.fixedHashtags ?? [],
    logoFile: values.get("logo") ?? null,
    warnings,
  };
}

/**
 * Los valores de la hoja Corredor de la planilla de un corredor (spec F7 §4.6), por campo: lo que
 * `parseBrokerSheet` lee de vuelta igual. Sin el logo (ya guardado; una carga sin logo no lo cambia)
 * y sin los vacíos.
 */
export function brokerTemplateValues(broker: BrokerData): Record<string, string> {
  const values: Record<string, string | null> = {
    nombre_corredor: broker.name,
    nombre_marca: broker.brandName,
    color_primario: broker.primaryColor,
    color_secundario: broker.secondaryColor,
    whatsapp: broker.whatsapp,
    email: broker.email,
    instagram: broker.instagramHandle === null ? null : `@${broker.instagramHandle}`,
    sitio_web: broker.website,
    tono: broker.tone,
    hashtags_fijos: broker.fixedHashtags.length === 0 ? null : broker.fixedHashtags.join(" "),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
