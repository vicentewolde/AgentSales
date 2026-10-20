import { z } from "zod";
import { DEFAULT_LANGUAGE, LANGUAGES, type Language, POST_PLATFORMS } from "./enums.js";
import { AppError } from "./errors.js";

// El perfil editorial de una marca (spec F9 §4.3, ADR-0030 punto 1): la única fuente de datos de
// la IA para los posts. Aquí viven la forma de la fila (lo que devuelve el repositorio) y las
// reglas al escribir (`normalizeEditorialProfile`, F9-T09).

/** Los días de la semana de la cadencia, en orden (lunes primero, como en Chile). */
export const EDITORIAL_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type EditorialWeekday = (typeof EDITORIAL_WEEKDAYS)[number];

/** Las horas de espacio entre un idioma y el otro en la misma red, si no se dicen (P4). */
export const DEFAULT_LANGUAGE_GAP_HOURS = 6;

/**
 * Los topes del perfil (F9-T09): lo bastante holgados para una marca real y lo bastante cortos
 * para que el brief de la IA no crezca sin control (cada hecho viaja en cada pedido).
 */
export const EDITORIAL_LIMITS = {
  languages: 2,
  audience: 500,
  pillars: 12,
  pillarKey: 40,
  pillarName: 80,
  pillarDescription: 500,
  pillarWeight: 100,
  facts: 50,
  fact: 300,
  avoid: 50,
  avoidItem: 200,
  postsPerWeek: 21,
  hoursPerPlatform: 8,
  languageGapHoursMin: 1,
  languageGapHoursMax: 48,
  hashtags: 30,
  hashtag: 100,
} as const;

/**
 * Una línea de contenido del perfil editorial (spec F9 §4.3): "Lo que aprendo construyendo",
 * "Producto"… `weight` reparte las ideas del plan entre las líneas.
 */
export const editorialPillarSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  weight: z.number().nonnegative(),
});
export type EditorialPillar = z.infer<typeof editorialPillarSchema>;

/**
 * La cadencia de una red: cuántos posts por semana, los días y horas preferidos (hora de Chile,
 * `HH:MM`) y las horas de espacio entre un idioma y el otro (solo con dos idiomas).
 */
export const editorialCadenceEntrySchema = z.object({
  postsPerWeek: z.number().int().nonnegative(),
  days: z.array(z.enum(EDITORIAL_WEEKDAYS)).default([]),
  hours: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default([]),
  languageGapHours: z.number().int().positive().default(DEFAULT_LANGUAGE_GAP_HOURS),
});
export type EditorialCadenceEntry = z.infer<typeof editorialCadenceEntrySchema>;

/** La cadencia por red: solo las que publican posts (`POST_PLATFORMS`); una red sin entrada no tiene. */
export const editorialCadenceSchema = z.partialRecord(
  z.enum(POST_PLATFORMS),
  editorialCadenceEntrySchema,
);
export type EditorialCadence = z.infer<typeof editorialCadenceSchema>;

/**
 * El perfil editorial de una marca (`editorial_profiles`, spec F9 §4.3): uno por corredor; lo
 * llena el operador. Es la forma de la fila (los idiomas son texto en la base y la cadencia es
 * jsonb: se validan al leer). Las reglas de escritura (topes, claves únicas, pesos, horas) son de
 * `normalizeEditorialProfile`.
 */
export const editorialProfileSchema = z.object({
  brokerId: z.string(),
  /** Los idiomas en que publica la marca, sin repetir; el primero es el principal. */
  languages: z
    .array(z.enum(LANGUAGES))
    .min(1)
    .refine((languages) => new Set(languages).size === languages.length, {
      message: "Un idioma aparece dos veces",
    }),
  /** A quién le habla, en una o dos frases. */
  audience: z.string().nullable(),
  pillars: z.array(editorialPillarSchema),
  /** Los hechos que la IA puede afirmar (ADR-0030): lo que no está aquí no se afirma. */
  facts: z.array(z.string()),
  /** Temas, palabras o promesas que no se usan. */
  avoid: z.array(z.string()),
  /** Posts por semana en cada red, días y horas preferidos y horas entre idiomas. */
  cadence: editorialCadenceSchema,
  /** Se suman a `brokers.fixed_hashtags`. */
  defaultHashtags: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EditorialProfile = z.infer<typeof editorialProfileSchema>;

/** Lo que se guarda de un perfil (todo menos el corredor y las fechas). */
export type EditorialProfileData = Omit<EditorialProfile, "brokerId" | "createdAt" | "updatedAt">;

/**
 * El perfil de un corredor como lo entregan la API y la CLI: el guardado o, si todavía no tiene,
 * el vacío por defecto (`updatedAt: null`).
 */
export type EditorialProfileView = EditorialProfileData & {
  brokerId: string;
  updatedAt: Date | null;
};

/** El perfil vacío: en español, sin líneas, hechos ni cadencia. Lo que tiene una marca nueva. */
export function emptyEditorialProfileData(): EditorialProfileData {
  return {
    languages: [DEFAULT_LANGUAGE],
    audience: null,
    pillars: [],
    facts: [],
    avoid: [],
    cadence: {},
    defaultHashtags: [],
  };
}

/** El perfil guardado o el vacío (para leerlo sin preguntar si existe: la IA, la API). */
export function editorialProfileView(
  brokerId: string,
  profile: EditorialProfile | null,
): EditorialProfileView {
  if (profile === null) return { brokerId, ...emptyEditorialProfileData(), updatedAt: null };
  const { createdAt: _created, ...rest } = profile;
  return rest;
}

/** Lo que llega de la API o la CLI, sin normalizar: el perfil completo (`PUT` lo reemplaza). */
export type EditorialProfileInput = {
  languages: string[];
  audience: string | null;
  pillars: { key: string; name: string; description?: string; weight: number }[];
  facts: string[];
  avoid: string[];
  cadence: Record<
    string,
    { postsPerWeek: number; days?: string[]; hours?: string[]; languageGapHours?: number }
  >;
  defaultHashtags: string[];
};

/** Un campo del perfil que no sirve, con su motivo (la forma de los `issues` de la API). */
export type EditorialProfileIssue = {
  code: "EDITORIAL_PROFILE_FIELD_INVALID";
  /** El campo de la API, con su posición si es de una lista: `pillars[1].key`, `cadence.x.hours`. */
  field: string;
  /** En español, con la etiqueta del campo: «Líneas de contenido: la clave «a b» no sirve…». */
  message: string;
};

const FIELD_LABELS: Record<keyof EditorialProfileInput, string> = {
  languages: "Idiomas",
  audience: "Público",
  pillars: "Líneas de contenido",
  facts: "Hechos",
  avoid: "Cosas que evitar",
  cadence: "Cadencia",
  defaultHashtags: "Hashtags",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: justamente los que se rechazan
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** La clave de una línea: minúsculas, números y guiones (la usa `posts.pillar`). */
const PILLAR_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** El cuerpo de un hashtag: letras (con tildes), números y `_`, como los acepta Instagram. */
const HASHTAG_BODY = /^[\p{L}\p{N}_]+$/u;
const HOUR = /^(\d{1,2}):(\d{2})$/;

/**
 * El perfil de la API o la CLI con sus reglas (F9-T09). Normaliza (recorta, quita las líneas
 * vacías y los repetidos de hechos, cosas que evitar, días, horas y hashtags; ordena días y horas;
 * un `#` por hashtag) y valida:
 * - `languages`: 1 o 2 de `LANGUAGES`, sin repetir; el primero es el principal;
 * - `audience`: hasta 500 caracteres (vacío es `null`);
 * - `pillars`: hasta 12, con clave única (minúsculas, números y guiones), nombre, descripción y
 *   peso de 0 a 100; si hay líneas, al menos una con peso mayor que 0;
 * - `facts` y `avoid`: hasta 50 frases (300 y 200 caracteres);
 * - `cadence`: solo redes de `POST_PLATFORMS`; de 0 a 21 posts por semana, días `mon`…`sun`,
 *   hasta 8 horas `HH:MM` (hora de Chile) y de 1 a 48 horas entre idiomas (6 si no se dicen);
 * - `defaultHashtags`: hasta 30, solo letras, números y `_`.
 * Ningún texto lleva saltos de línea ni caracteres de control. Si algo no sirve,
 * `EDITORIAL_PROFILE_INVALID` (400) con la lista de lo que hay que corregir (`details.issues`).
 */
export function normalizeEditorialProfile(input: EditorialProfileInput): EditorialProfileData {
  const issues: EditorialProfileIssue[] = [];
  const issue = (top: keyof EditorialProfileInput, field: string, problem: string) =>
    issues.push({
      code: "EDITORIAL_PROFILE_FIELD_INVALID",
      field,
      message: `${FIELD_LABELS[top]}: ${problem}`,
    });
  const L = EDITORIAL_LIMITS;
  /** Un texto recortado; `null` si queda vacío o trae caracteres de control (con su motivo). */
  const text = (
    top: keyof EditorialProfileInput,
    field: string,
    value: string,
    max: number,
  ): string | null => {
    const trimmed = value.trim();
    if (CONTROL_CHARS.test(trimmed)) {
      issue(top, field, "tiene saltos de línea o caracteres no permitidos");
      return null;
    }
    if (trimmed.length > max) {
      issue(top, field, `«${trimmed.slice(0, 40)}…» pasa de ${max} caracteres`);
      return null;
    }
    return trimmed === "" ? null : trimmed;
  };

  // Idiomas: el orden importa (el primero es el principal), así que un repetido no se arregla solo.
  const languages: Language[] = [];
  for (const raw of input.languages) {
    const value = raw.trim().toLowerCase();
    if (!(LANGUAGES as readonly string[]).includes(value)) {
      issue("languages", "languages", `«${raw}» no es un idioma (usa ${LANGUAGES.join(" o ")})`);
    } else if (languages.includes(value as Language)) {
      issue("languages", "languages", `«${value}» aparece dos veces`);
    } else languages.push(value as Language);
  }
  if (input.languages.length === 0) {
    issue("languages", "languages", "falta al menos uno (el primero es el principal)");
  } else if (input.languages.length > L.languages) {
    issue("languages", "languages", `son ${L.languages} como máximo`);
  }

  const audience =
    input.audience === null ? null : text("audience", "audience", input.audience, L.audience);

  // Líneas de contenido.
  const pillars: EditorialPillar[] = [];
  if (input.pillars.length > L.pillars) {
    issue("pillars", "pillars", `son ${L.pillars} como máximo`);
  }
  const keys = new Set<string>();
  input.pillars.forEach((raw, index) => {
    const at = `pillars[${index}]`;
    const key = raw.key.trim().toLowerCase();
    if (!PILLAR_KEY.test(key) || key.length > L.pillarKey) {
      issue(
        "pillars",
        `${at}.key`,
        `la clave «${raw.key}» no sirve (minúsculas, números y guiones, hasta ${L.pillarKey})`,
      );
    } else if (keys.has(key)) {
      issue("pillars", `${at}.key`, `la clave «${key}» aparece dos veces`);
    }
    keys.add(key);
    const name = text("pillars", `${at}.name`, raw.name, L.pillarName);
    if (name === null && raw.name.trim() === "") {
      issue("pillars", `${at}.name`, `la línea «${key}» no tiene nombre`);
    }
    const description =
      text("pillars", `${at}.description`, raw.description ?? "", L.pillarDescription) ?? "";
    if (!Number.isFinite(raw.weight) || raw.weight < 0 || raw.weight > L.pillarWeight) {
      issue(
        "pillars",
        `${at}.weight`,
        `el peso de «${key}» debe ser un número de 0 a ${L.pillarWeight}`,
      );
    }
    pillars.push({ key, name: name ?? "", description, weight: raw.weight });
  });
  if (input.pillars.length > 0 && input.pillars.every((pillar) => !(pillar.weight > 0))) {
    issue("pillars", "pillars", "al menos una línea debe tener peso mayor que 0");
  }

  /** Una lista de frases: sin vacías ni repetidas, con su tope de cantidad y de largo. */
  const phrases = (top: "facts" | "avoid", maxItems: number, maxLength: number): string[] => {
    const out: string[] = [];
    input[top].forEach((raw, index) => {
      const value = text(top, `${top}[${index}]`, raw, maxLength);
      if (value !== null && !out.includes(value)) out.push(value);
    });
    if (out.length > maxItems) issue(top, top, `son ${maxItems} como máximo (hay ${out.length})`);
    return out;
  };
  const facts = phrases("facts", L.facts, L.fact);
  const avoid = phrases("avoid", L.avoid, L.avoidItem);

  // Cadencia por red.
  const cadence: EditorialCadence = {};
  for (const [platform, raw] of Object.entries(input.cadence)) {
    const at = `cadence.${platform}`;
    if (!(POST_PLATFORMS as readonly string[]).includes(platform)) {
      issue("cadence", at, `«${platform}» no publica posts (usa ${POST_PLATFORMS.join(", ")})`);
      continue;
    }
    const perWeek = raw.postsPerWeek;
    if (!Number.isInteger(perWeek) || perWeek < 0 || perWeek > L.postsPerWeek) {
      issue(
        "cadence",
        `${at}.postsPerWeek`,
        `en ${platform}, los posts por semana son un número entero de 0 a ${L.postsPerWeek}`,
      );
    }
    const days = new Set<EditorialWeekday>();
    for (const day of raw.days ?? []) {
      const value = day.trim().toLowerCase();
      if ((EDITORIAL_WEEKDAYS as readonly string[]).includes(value)) {
        days.add(value as EditorialWeekday);
      } else {
        issue(
          "cadence",
          `${at}.days`,
          `en ${platform}, «${day}» no es un día (usa ${EDITORIAL_WEEKDAYS.join(", ")})`,
        );
      }
    }
    const hours = new Set<string>();
    for (const hour of raw.hours ?? []) {
      const match = HOUR.exec(hour.trim());
      const h = Number(match?.[1]);
      const m = Number(match?.[2]);
      if (match === null || h > 23 || m > 59) {
        issue(
          "cadence",
          `${at}.hours`,
          `en ${platform}, «${hour}» no es una hora (HH:MM, de 00:00 a 23:59)`,
        );
      } else hours.add(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    if (hours.size > L.hoursPerPlatform) {
      issue(
        "cadence",
        `${at}.hours`,
        `en ${platform}, son ${L.hoursPerPlatform} horas como máximo`,
      );
    }
    const gap = raw.languageGapHours ?? DEFAULT_LANGUAGE_GAP_HOURS;
    if (!Number.isInteger(gap) || gap < L.languageGapHoursMin || gap > L.languageGapHoursMax) {
      issue(
        "cadence",
        `${at}.languageGapHours`,
        `en ${platform}, las horas entre idiomas van de ${L.languageGapHoursMin} a ${L.languageGapHoursMax}`,
      );
    }
    cadence[platform as keyof EditorialCadence] = {
      postsPerWeek: raw.postsPerWeek,
      days: EDITORIAL_WEEKDAYS.filter((day) => days.has(day)),
      hours: [...hours].sort(),
      languageGapHours: gap,
    };
  }

  // Hashtags: como los fijos del corredor (un `#` cada uno, sin repetir), y solo los válidos.
  const defaultHashtags: string[] = [];
  const seen = new Set<string>();
  for (const tag of input.defaultHashtags
    .join(" ")
    .split(/[\s,]+/)
    .filter(Boolean)) {
    const body = tag.replace(/^#+/, "");
    if (!HASHTAG_BODY.test(body) || body.length > L.hashtag) {
      issue(
        "defaultHashtags",
        "defaultHashtags",
        `«${tag}» no es un hashtag (solo letras, números y _, hasta ${L.hashtag})`,
      );
    } else if (!seen.has(body.toLowerCase())) {
      seen.add(body.toLowerCase());
      defaultHashtags.push(`#${body}`);
    }
  }
  if (defaultHashtags.length > L.hashtags) {
    issue("defaultHashtags", "defaultHashtags", `son ${L.hashtags} como máximo`);
  }

  if (issues.length > 0) {
    throw new AppError(
      "EDITORIAL_PROFILE_INVALID",
      `Revisa el perfil editorial: ${issues.map((item) => item.message).join("; ")}`,
      { details: { issues } },
    );
  }
  return { languages, audience, pillars, facts, avoid, cadence, defaultHashtags };
}
