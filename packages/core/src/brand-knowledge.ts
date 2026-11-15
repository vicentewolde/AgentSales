import { z } from "zod";
import { contentRunErrorSchema } from "./content.js";
import { AppError } from "./errors.js";
import { hasHiddenChars } from "./hidden-chars.js";
import { llmUsageSchema } from "./llm-usage.js";

// El conocimiento de la marca (spec F9.7 parte B, ADR-0043): la postura, el tono y la forma de
// contar, los ejemplos que le gustan al operador (guía de **forma**, nunca de hechos: D1) y las
// novedades de sus proyectos (fuente de hechos, como los hechos del perfil). Aquí viven las filas,
// las reglas al escribir y lo que ve la IA (`knowledgeForPrompt`, con el tope de B3).

/** De dónde salió una novedad: la escribió el operador o aceptó una propuesta de la IA (B2). */
export const KNOWLEDGE_UPDATE_SOURCES = ["operator", "proposal"] as const;
export type KnowledgeUpdateSource = (typeof KNOWLEDGE_UPDATE_SOURCES)[number];

/** Qué propone la IA desde un texto largo: una novedad o un hecho del perfil. */
export const KNOWLEDGE_PROPOSAL_KINDS = ["update", "fact"] as const;
export type KnowledgeProposalKind = (typeof KNOWLEDGE_PROPOSAL_KINDS)[number];

/** El estado de una propuesta: nada entra al conocimiento sin el operador (D2). */
export const KNOWLEDGE_PROPOSAL_STATUSES = ["pending", "accepted", "discarded"] as const;
export type KnowledgeProposalStatus = (typeof KNOWLEDGE_PROPOSAL_STATUSES)[number];

/** Los estados de una corrida de propuestas, como los de un plan. */
export const KNOWLEDGE_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type KnowledgeRunStatus = (typeof KNOWLEDGE_RUN_STATUSES)[number];

/** Topes del conocimiento (B1) y de lo que viaja a la IA (B3). */
export const BRAND_KNOWLEDGE_LIMITS = {
  stance: 2000,
  tone: 2000,
  examples: 10,
  example: 3000,
  exampleNote: 300,
  project: 80,
  updateText: 1000,
  /** Las novedades activas (sin archivar) de una marca. */
  updates: 200,
  /** El texto largo de «Actualizar desde un texto» (B2). */
  sourceText: 20000,
  /** Lo que propone una corrida, como mucho. */
  proposals: 20,
  /** B3: hasta 3 ejemplos (los favoritos primero) y las novedades de 90 días (hasta 20). */
  promptExamples: 3,
  promptUpdates: 20,
  promptUpdateDays: 90,
} as const;

/** Una fecha de calendario `AAAA-MM-DD` (de Chile: la escribe el operador). */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const knowledgeDateSchema = z.string().regex(DAY);

/** La postura y el tono de una marca (`brand_knowledge`); `null` si no los escribió. */
export const brandKnowledgeSchema = z.object({
  brokerId: z.string(),
  stance: z.string().nullable(),
  tone: z.string().nullable(),
  updatedAt: z.date(),
});
export type BrandKnowledge = z.infer<typeof brandKnowledgeSchema>;

/** Un ejemplo que le gusta al operador (`brand_knowledge_examples`): guía de forma (D1). */
export const knowledgeExampleSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  text: z.string(),
  /** Por qué le gusta. */
  note: z.string().nullable(),
  favorite: z.boolean(),
  createdAt: z.date(),
});
export type KnowledgeExample = z.infer<typeof knowledgeExampleSchema>;

/** Una novedad de un proyecto (`brand_knowledge_updates`): fuente de hechos (D1). */
export const knowledgeUpdateSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  project: z.string(),
  date: knowledgeDateSchema,
  text: z.string(),
  source: z.enum(KNOWLEDGE_UPDATE_SOURCES),
  /** Archivar es borrar (deja de ser fuente); `null` si sigue activa. */
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type KnowledgeUpdate = z.infer<typeof knowledgeUpdateSchema>;

/** Una corrida de «Actualizar desde un texto» (`brand_knowledge_runs`, job `brand.propose`). */
export const knowledgeRunSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  status: z.enum(KNOWLEDGE_RUN_STATUSES),
  /** El texto pegado (hasta 20.000 caracteres): solo viaja a la IA, nunca al log. */
  sourceText: z.string(),
  /** Las advertencias de la IA, cuando termina bien. */
  warnings: z.array(z.string()),
  error: contentRunErrorSchema.nullable(),
  llmUsage: llmUsageSchema.nullable(),
  createdBy: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type KnowledgeRun = z.infer<typeof knowledgeRunSchema>;

/** Una propuesta de la IA (`brand_knowledge_proposals`): espera al operador (D2). */
export const knowledgeProposalSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  runId: z.string(),
  kind: z.enum(KNOWLEDGE_PROPOSAL_KINDS),
  text: z.string(),
  /** El proyecto de una novedad; `null` en un hecho. */
  project: z.string().nullable(),
  /** La fecha de una novedad, si la IA la encontró en el texto; `null` si no. */
  date: knowledgeDateSchema.nullable(),
  status: z.enum(KNOWLEDGE_PROPOSAL_STATUSES),
  createdAt: z.date(),
});
export type KnowledgeProposal = z.infer<typeof knowledgeProposalSchema>;

/**
 * Lo que ve la IA del conocimiento (B3), ya con el tope: la postura y el tono completos, hasta 3
 * ejemplos (los favoritos primero) y las novedades activas de los últimos 90 días (hasta 20, las
 * más nuevas primero). Viaja con el perfil (`EditorialProfile.knowledge`, ADR-0043 punto 3).
 */
export const brandKnowledgeContextSchema = z.object({
  stance: z.string().nullable(),
  tone: z.string().nullable(),
  examples: z.array(z.object({ text: z.string(), note: z.string().nullable() })),
  updates: z.array(z.object({ date: z.string(), project: z.string(), text: z.string() })),
});
export type BrandKnowledgeContext = z.infer<typeof brandKnowledgeContextSchema>;

/** La fecha `AAAA-MM-DD` de `now` menos `days` días (UTC: la diferencia de horas no importa). */
export function knowledgeSince(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * El conocimiento como lo ve la IA (B3). `null` si no hay nada que mandar (así el prompt no crece
 * en una marca sin conocimiento).
 */
export function knowledgeForPrompt(params: {
  knowledge: Pick<BrandKnowledge, "stance" | "tone"> | null;
  examples: readonly Pick<KnowledgeExample, "text" | "note" | "favorite" | "createdAt">[];
  updates: readonly Pick<KnowledgeUpdate, "date" | "project" | "text" | "archivedAt">[];
  now: Date;
}): BrandKnowledgeContext | null {
  const L = BRAND_KNOWLEDGE_LIMITS;
  const since = knowledgeSince(params.now, L.promptUpdateDays);
  const examples = [...params.examples]
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .slice(0, L.promptExamples)
    .map((example) => ({ text: example.text, note: example.note }));
  const updates = params.updates
    .filter((update) => update.archivedAt === null && update.date >= since)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, L.promptUpdates)
    .map((update) => ({ date: update.date, project: update.project, text: update.text }));
  const stance = params.knowledge?.stance ?? null;
  const tone = params.knowledge?.tone ?? null;
  if (stance === null && tone === null && examples.length === 0 && updates.length === 0) {
    return null;
  }
  return { stance, tone, examples, updates };
}

/**
 * Las fuentes de hechos del conocimiento (D1): **solo las novedades** (su proyecto, su fecha y su
 * texto). Ni la postura, ni el tono ni los ejemplos.
 */
export function knowledgeSources(knowledge: BrandKnowledgeContext | null | undefined): string[] {
  if (knowledge == null) return [];
  return knowledge.updates.map((update) => `${update.project} (${update.date}): ${update.text}`);
}

// ---------------------------------------------------------------------------------------------
// Reglas al escribir
// ---------------------------------------------------------------------------------------------

/** Un campo que no sirve, como los del perfil editorial (`issues` de la API). */
export type KnowledgeIssue = { code: "KNOWLEDGE_FIELD_INVALID"; field: string; message: string };

const invalid = (issues: KnowledgeIssue[]) =>
  new AppError(
    "KNOWLEDGE_INVALID",
    `Revisa el conocimiento de la marca: ${issues.map((item) => item.message).join("; ")}`,
    { details: { issues } },
  );

/** Un texto recortado; `null` si queda vacío. Anota el motivo si no sirve. */
function cleanText(
  issues: KnowledgeIssue[],
  field: string,
  label: string,
  value: string | null | undefined,
  max: number,
  allowNewline: boolean,
): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\r\n?/gu, "\n").trim();
  if (hasHiddenChars(trimmed, { allowNewline })) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field,
      message: `${label}: tiene caracteres no permitidos${allowNewline ? "" : " o saltos de línea"}`,
    });
    return null;
  }
  if (trimmed.length > max) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field,
      message: `${label}: pasa de ${max} caracteres (tiene ${trimmed.length})`,
    });
    return null;
  }
  return trimmed === "" ? null : trimmed;
}

/** Lo que llega de la API o la CLI para la postura, el tono y los ejemplos (`PUT`: reemplaza). */
export type BrandKnowledgeInput = {
  stance: string | null;
  tone: string | null;
  examples: { text: string; note?: string | null; favorite?: boolean }[];
};

export type BrandKnowledgeData = {
  stance: string | null;
  tone: string | null;
  examples: { text: string; note: string | null; favorite: boolean }[];
};

/**
 * La postura (hasta 2.000), el tono (hasta 2.000) y hasta 10 ejemplos (cada uno hasta 3.000, con
 * una nota de hasta 300), recortados; un ejemplo vacío se quita. `KNOWLEDGE_INVALID` (400) con la
 * lista de lo que hay que corregir.
 */
export function normalizeBrandKnowledge(input: BrandKnowledgeInput): BrandKnowledgeData {
  const L = BRAND_KNOWLEDGE_LIMITS;
  const issues: KnowledgeIssue[] = [];
  const stance = cleanText(
    issues,
    "stance",
    "Qué queremos transmitir",
    input.stance,
    L.stance,
    true,
  );
  const tone = cleanText(issues, "tone", "Tono y forma de contar", input.tone, L.tone, true);
  const examples: BrandKnowledgeData["examples"] = [];
  input.examples.forEach((raw, index) => {
    const label = `Ejemplo ${index + 1}`;
    const text = cleanText(issues, `examples[${index}].text`, label, raw.text, L.example, true);
    const note = cleanText(
      issues,
      `examples[${index}].note`,
      `${label} (por qué)`,
      raw.note ?? null,
      L.exampleNote,
      false,
    );
    if (text !== null) examples.push({ text, note, favorite: raw.favorite === true });
  });
  if (examples.length > L.examples) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "examples",
      message: `Ejemplos: son ${L.examples} como máximo (hay ${examples.length})`,
    });
  }
  if (issues.length > 0) throw invalid(issues);
  return { stance, tone, examples };
}

/** Una novedad como la escribe el operador (o como acepta una propuesta, con edición). */
export type KnowledgeUpdateInput = { project: string; date: string; text: string };

/**
 * Una novedad: proyecto (hasta 80, sin saltos), fecha `AAAA-MM-DD` válida y texto (hasta 1.000).
 * `KNOWLEDGE_INVALID` (400) si algo no sirve.
 */
export function normalizeKnowledgeUpdate(input: KnowledgeUpdateInput): KnowledgeUpdateInput {
  const L = BRAND_KNOWLEDGE_LIMITS;
  const issues: KnowledgeIssue[] = [];
  const project = cleanText(issues, "project", "Proyecto", input.project, L.project, false);
  const text = cleanText(issues, "text", "Novedad", input.text, L.updateText, true);
  const date = input.date.trim();
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!DAY.test(date) || Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(date)) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "date",
      message: `Fecha: «${input.date}» no es una fecha (AAAA-MM-DD)`,
    });
  }
  if (project === null && !issues.some((item) => item.field === "project")) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "project",
      message: "Falta el proyecto",
    });
  }
  if (text === null && !issues.some((item) => item.field === "text")) {
    issues.push({ code: "KNOWLEDGE_FIELD_INVALID", field: "text", message: "Falta el texto" });
  }
  if (issues.length > 0) throw invalid(issues);
  return { project: project ?? "", date, text: text ?? "" };
}

/** El texto largo de «Actualizar desde un texto» (B2): de 20 a 20.000 caracteres. */
export function normalizeKnowledgeSourceText(text: string): string {
  const trimmed = text.replace(/\r\n?/gu, "\n").trim();
  const issues: KnowledgeIssue[] = [];
  if (hasHiddenChars(trimmed, { allowNewline: true })) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "text",
      message: "Texto: tiene caracteres no permitidos",
    });
  } else if (trimmed.length < 20) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "text",
      message: "Texto: pega al menos un párrafo (20 caracteres)",
    });
  } else if (trimmed.length > BRAND_KNOWLEDGE_LIMITS.sourceText) {
    issues.push({
      code: "KNOWLEDGE_FIELD_INVALID",
      field: "text",
      message: `Texto: pasa de ${BRAND_KNOWLEDGE_LIMITS.sourceText} caracteres (tiene ${trimmed.length})`,
    });
  }
  if (issues.length > 0) throw invalid(issues);
  return trimmed;
}
