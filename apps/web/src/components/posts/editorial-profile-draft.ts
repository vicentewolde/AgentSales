import type { EditorialProfileBody, EditorialProfileJson } from "@agentsales/api/contracts";
import {
  EDITORIAL_LIMITS,
  type EditorialWeekday,
  type Language,
  PLATFORM_TEXT,
  POST_PLATFORMS,
  type PostPlatform,
} from "@agentsales/core";

// Lo que edita el formulario del perfil editorial (F9-T09, F9.5-T17) y cómo se convierte en el
// cuerpo de `PUT /brokers/:id/editorial-profile`, que no cambia: el panel solo lo explica mejor.
// Va aparte del componente porque un archivo de componentes solo exporta componentes.

/**
 * El peso de un tema como lo elige el operador. El contrato guarda un número de 0 a 100 que solo
 * importa en proporción (el plan reparte las ideas según el peso): poco = 1, normal = 2 y
 * mucho = 3, así «mucho» recibe el triple de ideas que «poco».
 */
export const WEIGHT_LEVELS = [
  { value: 1, label: "Poco" },
  { value: 2, label: "Normal" },
  { value: 3, label: "Mucho" },
] as const;
export type WeightLevel = (typeof WEIGHT_LEVELS)[number]["label"];

/** El número que se guarda para «Poco», «Normal» o «Mucho». */
export const weightOf = (level: WeightLevel): number =>
  WEIGHT_LEVELS.find((item) => item.label === level)?.value ?? 2;

/** «Poco», «Normal» o «Mucho» para un peso guardado; `null` si es otro número (uno de la CLI). */
export const levelOf = (weight: number): WeightLevel | null =>
  WEIGHT_LEVELS.find((item) => item.value === weight)?.label ?? null;

/** El peso de un tema nuevo. */
export const DEFAULT_WEIGHT = weightOf("Normal");

export type PillarRow = { key: string; name: string; description: string; weight: number };
export type CadenceRow = {
  on: boolean;
  postsPerWeek: string;
  days: EditorialWeekday[];
  /** Las horas elegidas (`HH:MM`, hora de Chile), ordenadas y sin repetir. */
  hours: string[];
  /** La hora escrita en el campo de agregar y todavía sin agregar: se guarda igual. */
  newHour: string;
  languageGapHours: string;
};

/** Lo que se edita: listas como texto (una por línea) y números como texto, hasta guardar. */
export type Draft = {
  primary: Language;
  second: Language | "";
  audience: string;
  pillars: PillarRow[];
  facts: string;
  avoid: string;
  cadence: Record<PostPlatform, CadenceRow>;
  hashtags: string;
};

export type Issue = { field: string; message: string };

export const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Suma una hora a la lista: ordenada y sin repetir (como la deja core al guardar). */
export function addHour(hours: readonly string[], hour: string): string[] {
  const value = hour.trim();
  if (value === "" || hours.includes(value)) return [...hours];
  return [...hours, value].sort();
}

/**
 * La clave interna de un tema, desde su nombre: minúsculas sin tildes, números y guiones
 * («El barrio: comercio, metro y parques» → `el-barrio-comercio-metro-y-parques`), con el largo
 * máximo de core. Vacía si el nombre no tiene letras ni números.
 */
export function pillarKeyOf(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EDITORIAL_LIMITS.pillarKey)
    .replace(/-+$/, "");
}

export function draftOf(profile: EditorialProfileJson): Draft {
  const [primary = "es", second] = profile.languages;
  const cadence = Object.fromEntries(
    POST_PLATFORMS.map((platform) => {
      const entry = profile.cadence[platform];
      return [
        platform,
        {
          on: entry !== undefined,
          postsPerWeek: String(entry?.postsPerWeek ?? 1),
          days: [...(entry?.days ?? [])],
          hours: [...(entry?.hours ?? [])],
          newHour: "",
          languageGapHours: String(entry?.languageGapHours ?? 6),
        },
      ];
    }),
  ) as Record<PostPlatform, CadenceRow>;
  return {
    primary,
    second: second ?? "",
    audience: profile.audience ?? "",
    pillars: profile.pillars.map((pillar) => ({
      key: pillar.key,
      name: pillar.name,
      description: pillar.description,
      weight: pillar.weight,
    })),
    facts: profile.facts.join("\n"),
    avoid: profile.avoid.join("\n"),
    cadence,
    hashtags: profile.defaultHashtags.join(" "),
  };
}

/** Las claves de los temas: la escrita o, si está vacía, la del nombre, sin chocar con otra. */
function pillarKeys(pillars: readonly PillarRow[]): string[] {
  const taken = new Set(pillars.map((pillar) => pillar.key.trim()).filter((key) => key !== ""));
  return pillars.map((pillar) => {
    const written = pillar.key.trim();
    if (written !== "") return pillar.key;
    const base = pillarKeyOf(pillar.name);
    if (base === "") return "";
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return key;
  });
}

/**
 * El cuerpo de `PUT /brokers/:id/editorial-profile` (core normaliza y valida) y, aparte, los números
 * mal escritos: esos no se pueden mandar (JSON no tiene `NaN`), así que se marcan aquí, con el mismo
 * campo y la misma forma de mensaje que usa la API.
 */
export function profileBody(draft: Draft): { body: EditorialProfileBody; issues: Issue[] } {
  const issues: Issue[] = [];
  const numberOf = (text: string, field: string, label: string) => {
    const value = Number(text.trim().replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(value)) {
      issues.push({ field, message: `${label}: «${text.trim()}» no es un número` });
      return 0;
    }
    return value;
  };
  const keys = pillarKeys(draft.pillars);
  const body: EditorialProfileBody = {
    languages: [draft.primary, ...(draft.second === "" ? [] : [draft.second])],
    audience: draft.audience.trim() === "" ? null : draft.audience,
    pillars: draft.pillars.map((pillar, index) => ({
      key: keys[index] ?? pillar.key,
      name: pillar.name,
      description: pillar.description,
      weight: pillar.weight,
    })),
    facts: lines(draft.facts),
    avoid: lines(draft.avoid),
    cadence: Object.fromEntries(
      POST_PLATFORMS.filter((platform) => draft.cadence[platform].on).map((platform) => {
        const row = draft.cadence[platform];
        return [
          platform,
          {
            postsPerWeek: numberOf(
              row.postsPerWeek,
              `cadence.${platform}.postsPerWeek`,
              `Cadencia: en ${PLATFORM_TEXT[platform]}, los posts por semana`,
            ),
            days: row.days,
            hours: addHour(row.hours, row.newHour),
            languageGapHours: numberOf(
              row.languageGapHours,
              `cadence.${platform}.languageGapHours`,
              `Cadencia: en ${PLATFORM_TEXT[platform]}, las horas entre idiomas`,
            ),
          },
        ];
      }),
    ),
    defaultHashtags: draft.hashtags.split(/[\s,]+/).filter((tag) => tag.trim() !== ""),
  };
  return { body, issues };
}

// Los ejemplos de cada campo, de un corredor de propiedades (F9.5-T17): se insertan con un clic y
// el operador los cambia por los suyos. Los hechos de ejemplo no son verdad para nadie hasta que
// el operador los revise: por eso la ayuda lo dice.

export const AUDIENCE_EXAMPLE =
  "Familias y profesionales que buscan arrendar o comprar departamento en Providencia, Ñuñoa y Las Condes, y propietarios que quieren arrendar su propiedad";

export const PILLAR_EXAMPLES: readonly { name: string; level: WeightLevel }[] = [
  { name: "Propiedades disponibles", level: "Mucho" },
  { name: "Consejos para arrendar o comprar", level: "Normal" },
  { name: "El barrio: comercio, metro y parques", level: "Poco" },
  { name: "Casos y cómo trabajo", level: "Poco" },
];

export const FACT_EXAMPLES = [
  "Corredor de propiedades en Santiago desde 2018",
  "Trabajo en Providencia, Ñuñoa y Las Condes",
  "Arriendos con contrato notarial y revisión de antecedentes",
] as const;

export const AVOID_EXAMPLES = [
  "Prometer plusvalía o rentabilidad",
  "Hablar mal de otros corredores",
  "Requisitos sobre niños, nacionalidad o estado civil",
  "Dar la dirección exacta",
] as const;

/** Suma una frase a una lista de una por línea, si no está ya. */
export function addLine(text: string, phrase: string): string {
  if (lines(text).includes(phrase)) return text;
  const trimmed = text.replace(/\s+$/, "");
  return trimmed === "" ? phrase : `${trimmed}\n${phrase}`;
}

/** El público con el ejemplo: lo pone si está vacío, o lo suma al final (en la misma línea). */
export function addAudience(text: string, example: string): string {
  const trimmed = text.trim();
  if (trimmed.includes(example)) return text;
  return trimmed === "" ? example : `${trimmed} ${example}`;
}
