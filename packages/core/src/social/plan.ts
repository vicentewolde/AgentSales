import { z } from "zod";
import type { Broker } from "../broker.js";
import { chileDateOf, chileDateStart, parseChileTime } from "../chile-time.js";
import { describeIssues, type Validated } from "../content/generate.js";
import {
  EDITORIAL_WEEKDAYS,
  type EditorialCadence,
  type EditorialPillar,
  type EditorialProfileView,
  type EditorialWeekday,
} from "../editorial-profile.js";
import {
  LLM_PROVIDERS,
  POST_KINDS,
  POST_PLATFORMS,
  type PostKind,
  type PostPlatform,
} from "../enums.js";
import { AppError } from "../errors.js";
import { foldText } from "../listing-validator/normalizers.js";
import type { Post } from "../post.js";
import { hasMassMention, unsupportedFacts } from "./check.js";
import { kindProblem } from "./networks.js";

// El plan de ideas de la IA (spec F9 §4.9, ADR-0030): el período, lo que ve la IA, la forma de su
// respuesta, las verificaciones de cada idea, el reporte, qué hacer si falla y cómo se agrupan sus
// ideas por semana. Funciones puras: las usan `requestPlanRun` y `runPlan` (use-cases), la
// evaluación de T22 y, desde T21, la API, la CLI y el panel. Una idea que no pasa se **descarta** y
// queda en el reporte; no tumba el plan. Los textos del estado de un plan están en `labels.ts`.

/** Días del período por defecto: las próximas 2 semanas (spec F9 §4.9). */
export const PLAN_DEFAULT_DAYS = 14;
/** Topes de lo que se pide: el período y cuántas ideas. */
export const PLAN_MAX_DAYS = 31;
export const PLAN_MAX_IDEAS = 20;
/** Un período empieza, como mucho, a 60 días de hoy (como programar, F6). */
export const PLAN_MAX_START_AHEAD_DAYS = 60;
/** Posts por semana que se suponen si ninguna red pedida tiene cadencia. */
export const PLAN_FALLBACK_PER_WEEK = 3;
/**
 * Los temas que no se repiten (ADR-0030, punto 5): los de los posts de los últimos 60 días y las
 * ideas descartadas en ese mismo plazo (decisión del operador, 2026-10-20: después, un tema vuelve
 * a estar disponible).
 */
export const PLAN_RECENT_DAYS = 60;
/** Cuántos temas de cada lista viajan a la IA, los más recientes (el prompt no crece sin control). */
export const PLAN_HISTORY_MAX = 100;

/**
 * Topes de una idea. `topic` es el de `POST_LIMITS.topic` (posts manuales): una idea es un post.
 * `responseIdeas` frena una respuesta absurda (más ideas de las pedidas se descartan una a una).
 */
export const PLAN_IDEA_LIMITS = {
  topic: 200,
  rationale: 500,
  pillar: 40,
  responseIdeas: PLAN_MAX_IDEAS * 2,
  warnings: 10,
  warning: 300,
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new AppError("PLAN_RUN_INVALID", message, { details });

// --- Fechas de Chile (`"2026-10-21"`) ---------------------------------------------------------

/** `true` si es un día real con forma `AAAA-MM-DD`. */
function isDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10) === day;
}

/** El día de Chile `n` días después (o antes, con `n` negativo). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** El día de la semana de un día de Chile (`mon` … `sun`). */
export function weekdayOf(day: string): EditorialWeekday {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // `getUTCDay`: 0 es domingo; `EDITORIAL_WEEKDAYS` empieza el lunes.
  const index = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return EDITORIAL_WEEKDAYS[index] as EditorialWeekday;
}

/** El lunes de la semana (de lunes a domingo, como en Chile) de un día. */
export const weekOf = (day: string) => addDays(day, -EDITORIAL_WEEKDAYS.indexOf(weekdayOf(day)));

// --- Lo que se pide ---------------------------------------------------------------------------

/**
 * El período de un plan, en días de Chile: desde `firstDay` (incluido) hasta `lastDay` (incluido);
 * `start` y `end` son los instantes `[start, end)`.
 */
export type PlanPeriod = {
  firstDay: string;
  lastDay: string;
  days: number;
  start: Date;
  end: Date;
};

/**
 * El período de un plan (spec F9 §4.9): por defecto empieza mañana (hora de Chile) y dura
 * `PLAN_DEFAULT_DAYS`. `startDay` (`AAAA-MM-DD`) puede ser hoy o hasta 60 días más adelante; los
 * días van de 1 a `PLAN_MAX_DAYS`. Si algo no sirve, `PLAN_RUN_INVALID` (400).
 */
export function planPeriod(params: { now: Date; startDay?: string; days?: number }): PlanPeriod {
  const days = params.days ?? PLAN_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > PLAN_MAX_DAYS) {
    throw invalid(`El período va de 1 a ${PLAN_MAX_DAYS} días`, { days });
  }
  const today = chileDateOf(params.now);
  const firstDay = params.startDay?.trim() ?? addDays(today, 1);
  if (!isDay(firstDay)) throw invalid("El inicio del período no es un día (AAAA-MM-DD)");
  if (firstDay < today) throw invalid("El período no puede empezar en el pasado");
  if (firstDay > addDays(today, PLAN_MAX_START_AHEAD_DAYS)) {
    throw invalid(`El período empieza como mucho a ${PLAN_MAX_START_AHEAD_DAYS} días de hoy`);
  }
  return {
    firstDay,
    lastDay: addDays(firstDay, days - 1),
    days,
    start: chileDateStart(firstDay),
    end: chileDateStart(addDays(firstDay, days)),
  };
}

/**
 * El período de un plan guardado (`plan_runs.period_start` y `period_end`, `[start, end)`), en
 * días de Chile: lo usan `runPlan` y la API (F9-T21), con una sola fórmula. `periodEnd` es el
 * inicio del día siguiente al último; medio día antes cae siempre en el último (aun con el cambio
 * de hora).
 */
export function planRunPeriod(run: { periodStart: Date; periodEnd: Date }): PlanPeriod {
  const firstDay = chileDateOf(run.periodStart);
  const lastDay = chileDateOf(new Date(run.periodEnd.getTime() - DAY_MS / 2));
  const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
  return {
    firstDay,
    lastDay,
    days: Math.round((utc(lastDay) - utc(firstDay)) / DAY_MS) + 1,
    start: run.periodStart,
    end: run.periodEnd,
  };
}

/**
 * Cuántas ideas, si no se dice: los posts por semana de la red pedida que más publica (una idea
 * puede ir a varias redes) por las semanas del período, o `PLAN_FALLBACK_PER_WEEK` si ninguna
 * tiene cadencia; entre 1 y `PLAN_MAX_IDEAS`.
 */
export function defaultPlanCount(
  cadence: EditorialCadence,
  platforms: readonly PostPlatform[],
  days: number,
): number {
  const perWeek = Math.max(0, ...platforms.map((platform) => cadence[platform]?.postsPerWeek ?? 0));
  const weekly = perWeek > 0 ? perWeek : PLAN_FALLBACK_PER_WEEK;
  return Math.min(PLAN_MAX_IDEAS, Math.max(1, Math.round((weekly * days) / 7)));
}

/** Lo pedido, como queda en `plan_runs.request` (sin secretos). */
export const planRunRequestSchema = z.object({
  platforms: z.array(z.enum(POST_PLATFORMS)).min(1),
  count: z.number().int().min(1).max(PLAN_MAX_IDEAS),
  days: z.number().int().min(1).max(PLAN_MAX_DAYS),
  /** Quién lo pidió (los posts de las ideas quedan con su `created_by`); `null` si fue el sistema. */
  requestedBy: z.string().nullable(),
});
export type PlanRunRequest = z.infer<typeof planRunRequestSchema>;

// --- Lo que ve la IA --------------------------------------------------------------------------

/** La forma comparable de un tema: sin tildes, mayúsculas, puntuación ni espacios de sobra. */
export const topicKey = (topic: string): string =>
  foldText(topic)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Los temas que el plan no repite (ADR-0030, punto 5). */
export type PlanHistory = {
  /** Los de los posts de los últimos 60 días (creados o planificados), salvo las ideas descartadas. */
  recentTopics: string[];
  /** Las ideas de la IA que se descartaron (archivadas) en los últimos 60 días. */
  discardedTopics: string[];
};

/**
 * Los temas que el plan no repite, de los posts recientes de la marca (`PostRepository.listRecent`):
 * - descartadas: las ideas de la IA archivadas (`source = ai`, `archived`) creadas en los últimos
 *   `PLAN_RECENT_DAYS`. Una idea aceptada que después se archivó también cuenta: es un tema que
 *   ya pasó por el operador;
 * - recientes: los demás posts (manuales o ideas, en cualquier estado) creados o planificados en
 *   los últimos `PLAN_RECENT_DAYS`, incluidas las ideas aún sin decidir.
 * Cada lista sin repetidos (`topicKey`) y con los `PLAN_HISTORY_MAX` más recientes.
 */
export function planHistory(
  posts: readonly Pick<Post, "topic" | "status" | "source" | "createdAt" | "plannedAt">[],
  now: Date,
): PlanHistory {
  const recentSince = now.getTime() - PLAN_RECENT_DAYS * DAY_MS;
  const newestFirst = [...posts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const recent: string[] = [];
  const discarded: string[] = [];
  const seen = new Map<string[], Set<string>>([
    [recent, new Set()],
    [discarded, new Set()],
  ]);
  const push = (list: string[], topic: string) => {
    const keys = seen.get(list) as Set<string>;
    const key = topicKey(topic);
    if (key === "" || keys.has(key) || list.length >= PLAN_HISTORY_MAX) return;
    keys.add(key);
    list.push(topic);
  };
  for (const post of newestFirst) {
    if (post.status === "archived" && post.source === "ai") {
      if (post.createdAt.getTime() >= recentSince) push(discarded, post.topic);
    } else if (
      post.createdAt.getTime() >= recentSince ||
      (post.plannedAt !== null && post.plannedAt.getTime() >= recentSince)
    ) {
      push(recent, post.topic);
    }
  }
  return { recentTopics: recent, discardedTopics: discarded };
}

/** Un post que ya ocupa un día del período en unas redes (cuenta para los posts por semana). */
export type PlannedSlot = { date: string; platforms: PostPlatform[] };

/**
 * Las semanas completas (de lunes a domingo, hora de Chile) que toca un período: desde el lunes de
 * su primer día hasta el fin del domingo de su último día, `[start, end)`. Lo planificado ahí ocupa
 * el cupo semanal aunque caiga fuera del período (F9-T21: las semanas parciales del borde).
 */
export function planWeeks(period: Pick<PlanPeriod, "firstDay" | "lastDay">): {
  start: Date;
  end: Date;
} {
  return {
    start: chileDateStart(weekOf(period.firstDay)),
    end: chileDateStart(addDays(weekOf(period.lastDay), 7)),
  };
}

/**
 * Los posts de la marca que ya están planificados en las semanas del período (`planWeeks`: del
 * lunes de la primera al domingo de la última, así una semana parcial del borde no pasa su tope):
 * ideas sin decidir, borradores y listos con `planned_at` (no los archivados), con sus redes entre
 * las pedidas; un post sin redes propias (`platforms = null`) cuenta en todas. Ocupan su cupo de la
 * semana en la cadencia.
 */
export function plannedSlots(
  posts: readonly Pick<Post, "status" | "plannedAt" | "platforms">[],
  period: Pick<PlanPeriod, "firstDay" | "lastDay">,
  requested: readonly PostPlatform[],
): PlannedSlot[] {
  const weeks = planWeeks(period);
  return posts
    .filter(
      (post) =>
        post.status !== "archived" &&
        post.plannedAt !== null &&
        post.plannedAt >= weeks.start &&
        post.plannedAt < weeks.end,
    )
    .map((post) => ({
      date: chileDateOf(post.plannedAt as Date),
      platforms: requested.filter(
        (platform) => post.platforms === null || post.platforms.includes(platform),
      ),
    }))
    .filter((slot) => slot.platforms.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** La cadencia de una red tal como la ve la IA (las horas de espacio entre idiomas no aplican). */
export type PlanCadence = { postsPerWeek: number; days: EditorialWeekday[]; hours: string[] };

/**
 * Lo único que ve la IA para proponer un plan (ADR-0030, punto 1): el perfil editorial de **su**
 * marca, el tono, el período con sus días, las redes pedidas con su cadencia y los temas que no
 * repite. Nunca `internal_notes`, briefs de posts ni nada de otra marca.
 */
export type PlanBrief = {
  brandName: string;
  tone: string | null;
  audience: string | null;
  /** El primero es el principal: el tema y el porqué van en ese idioma. */
  languages: EditorialProfileView["languages"];
  pillars: EditorialPillar[];
  facts: string[];
  avoid: string[];
  firstDay: string;
  lastDay: string;
  /** Cada día del período con su día de la semana: la IA no calcula calendarios. */
  days: { date: string; weekday: EditorialWeekday }[];
  platforms: PostPlatform[];
  /** Solo de las redes pedidas que tienen cadencia. */
  cadence: Partial<Record<PostPlatform, PlanCadence>>;
  count: number;
  recentTopics: string[];
  discardedTopics: string[];
  /** Lo que ya está planificado en el período: ocupa su cupo de la semana. */
  planned: PlannedSlot[];
};

/** Arma lo que ve la IA con el perfil de **su** marca y su corredor. */
export function buildPlanBrief(params: {
  broker: Pick<Broker, "brandName" | "tone">;
  profile: EditorialProfileView;
  period: Pick<PlanPeriod, "firstDay" | "lastDay" | "days">;
  platforms: readonly PostPlatform[];
  count: number;
  history: PlanHistory;
  /** Lo ya planificado en el período (`plannedSlots`); por defecto, nada. */
  planned?: readonly PlannedSlot[];
}): PlanBrief {
  const { broker, profile, period } = params;
  const cadence: Partial<Record<PostPlatform, PlanCadence>> = {};
  for (const platform of params.platforms) {
    const entry = profile.cadence[platform];
    if (entry === undefined) continue;
    cadence[platform] = {
      postsPerWeek: entry.postsPerWeek,
      days: [...entry.days],
      hours: [...entry.hours],
    };
  }
  return {
    brandName: broker.brandName,
    tone: broker.tone,
    audience: profile.audience,
    languages: [...profile.languages],
    pillars: profile.pillars.map((pillar) => ({ ...pillar })),
    facts: [...profile.facts],
    avoid: [...profile.avoid],
    firstDay: period.firstDay,
    lastDay: period.lastDay,
    days: Array.from({ length: period.days }, (_, index) => {
      const date = addDays(period.firstDay, index);
      return { date, weekday: weekdayOf(date) };
    }),
    platforms: [...params.platforms],
    cadence,
    count: params.count,
    recentTopics: [...params.history.recentTopics],
    discardedTopics: [...params.history.discardedTopics],
    planned: (params.planned ?? []).map((slot) => ({ ...slot, platforms: [...slot.platforms] })),
  };
}

// --- Lo que responde la IA --------------------------------------------------------------------

/** Una idea como la entrega la IA; con `limits`, con topes (la de validar). */
function ideaShape(limits: boolean) {
  const text = (max: number) => (limits ? z.string().trim().min(1).max(max) : z.string());
  return z.strictObject({
    tema: text(PLAN_IDEA_LIMITS.topic),
    linea: (limits ? z.string().trim().max(PLAN_IDEA_LIMITS.pillar) : z.string()).nullable(),
    redes: limits
      ? z.array(z.enum(POST_PLATFORMS)).min(1).max(POST_PLATFORMS.length)
      : z.array(z.enum(POST_PLATFORMS)),
    formato: z.enum(POST_KINDS),
    fecha: limits ? z.string().regex(DAY) : z.string(),
    hora: limits ? z.string().regex(HOUR) : z.string(),
    porque: text(PLAN_IDEA_LIMITS.rationale),
  });
}

/**
 * Una idea de la IA (ADR-0030, punto 2): tema, línea (`pillars[].key` o `null`), redes, formato
 * (`posts.kind`), fecha y hora sugeridas (hora de Chile) y el porqué. Esquema estricto.
 */
export const planIdeaSchema = ideaShape(true);
export type PlanIdea = z.infer<typeof planIdeaSchema>;

/**
 * El sobre de la respuesta: las ideas se validan **una por una** (`checkPlanIdeas`), así una idea
 * mal formada se descarta sin tumbar el plan. El sobre sí se valida entero (con un reintento).
 */
const planResponseSchema = z.strictObject({
  ideas: z.array(z.unknown()).max(PLAN_IDEA_LIMITS.responseIdeas),
  warnings: z.array(z.string().trim().max(PLAN_IDEA_LIMITS.warning)).max(PLAN_IDEA_LIMITS.warnings),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;

/** JSON Schema (draft-07) que va al proveedor: la forma completa, sin topes (ADR-0013). */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  z.strictObject({ ideas: z.array(ideaShape(false)), warnings: z.array(z.string()) }),
  { target: "draft-07" },
);

/** Valida el sobre de la respuesta; los motivos son textos fijos (sin lo que dijo la IA). */
export function validatePlanResponse(data: unknown): Validated<PlanResponse> {
  const parsed = planResponseSchema.safeParse(data);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, issues: describeIssues(parsed.error) };
}

// --- Las verificaciones -----------------------------------------------------------------------

/** Por qué se descartó una idea (o se le quitó una red), en `plan_runs.report`. */
export const PLAN_DISCARD_CODES = [
  "FORMAT_INVALID",
  "DATE_INVALID",
  "OUT_OF_PERIOD",
  "IN_THE_PAST",
  "PILLAR_UNKNOWN",
  "MASS_MENTION",
  "FACT_NOT_IN_PROFILE",
  "REPEATED_TOPIC",
  "DISCARDED_TOPIC",
  "DUPLICATE_IN_PLAN",
  "PLATFORM_NOT_REQUESTED",
  "FORMAT_NOT_SUPPORTED",
  "OUT_OF_CADENCE",
  "WEEK_FULL",
  "OVER_COUNT",
] as const;
export type PlanDiscardCode = (typeof PLAN_DISCARD_CODES)[number];

/** Una idea que pasó: lo que se guarda como post `idea` (más sus redes, en el reporte). */
export type CheckedPlanIdea = {
  topic: string;
  pillar: string | null;
  platforms: PostPlatform[];
  kind: PostKind;
  plannedAt: Date;
  rationale: string;
  /** Las redes que se le quitaron y por qué (la idea siguió con las demás). */
  notes: string[];
};

/** Una idea descartada: su tema (si lo tenía), el motivo y el detalle. */
export type DiscardedPlanIdea = { topic: string; code: PlanDiscardCode; message: string };

const NAME: Readonly<Record<PostPlatform, string>> = {
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
  discord: "Discord",
  tiktok: "TikTok",
};

const WEEKDAY_TEXT: Readonly<Record<EditorialWeekday, string>> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

/** Por qué una red no sirve para una idea, o `null` si sirve (sin contar la semana llena). */
function platformProblem(
  platform: PostPlatform,
  idea: PlanIdea,
  brief: Pick<PlanBrief, "platforms" | "cadence">,
): { code: PlanDiscardCode; message: string } | null {
  const name = NAME[platform];
  if (!brief.platforms.includes(platform)) {
    return { code: "PLATFORM_NOT_REQUESTED", message: `${name} no estaba entre las redes pedidas` };
  }
  const unsupported = kindProblem(platform, idea.formato);
  if (unsupported !== null) return { code: "FORMAT_NOT_SUPPORTED", message: unsupported };
  const cadence = brief.cadence[platform];
  if (cadence === undefined) return null;
  if (cadence.postsPerWeek === 0) {
    return { code: "OUT_OF_CADENCE", message: `La cadencia de ${name} es de 0 posts por semana` };
  }
  const weekday = weekdayOf(idea.fecha);
  if (cadence.days.length > 0 && !cadence.days.includes(weekday)) {
    return {
      code: "OUT_OF_CADENCE",
      message: `${name} publica otros días (no el ${WEEKDAY_TEXT[weekday]})`,
    };
  }
  if (cadence.hours.length > 0 && !cadence.hours.includes(idea.hora)) {
    return {
      code: "OUT_OF_CADENCE",
      message: `${name} publica a otras horas (${cadence.hours.join(", ")}), no a las ${idea.hora}`,
    };
  }
  return null;
}

/**
 * Las verificaciones de las ideas de un plan (spec F9 §4.9, ADR-0030), en el orden en que llegan:
 * 1. la forma (`planIdeaSchema`) → `FORMAT_INVALID`;
 * 2. la fecha y la hora (de Chile) existen → `DATE_INVALID`; dentro del período → `OUT_OF_PERIOD`;
 *    no antes de `now` → `IN_THE_PAST`;
 * 3. la línea existe en el perfil (o `null`) → `PILLAR_UNKNOWN`;
 * 4. el tema y el porqué: sin `@everyone`/`@here` → `MASS_MENTION`; sin menciones, enlaces, cifras
 *    ni nombres que no estén en el perfil (`unsupportedFacts`, la regla de `checkPostContent`) →
 *    `FACT_NOT_IN_PROFILE`;
 * 5. el tema no repite uno reciente, una idea descartada ni otra idea del plan (`topicKey`) →
 *    `REPEATED_TOPIC`, `DISCARDED_TOPIC`, `DUPLICATE_IN_PLAN`;
 * 6. ya hay `count` ideas → `OVER_COUNT`;
 * 7. cada red: pedida, con un formato que admite (Instagram no publica solo texto; TikTok, solo
 *    video, `kindProblem`), en un día y hora de su cadencia y sin pasar sus posts por semana (de lunes
 *    a domingo, contando lo ya planificado, `brief.planned`, y las ideas de este plan). Una red que no sirve se le quita a la idea (queda en
 *    `notes`); si no le queda ninguna, la idea se descarta con el motivo de la primera.
 * Las que pasan quedan en el orden de la respuesta.
 */
export function checkPlanIdeas(params: {
  ideas: readonly unknown[];
  brief: PlanBrief;
  period: Pick<PlanPeriod, "start" | "end">;
  /** Las fuentes de hechos del perfil (`profileSources`). */
  sources: string;
  now: Date;
}): { ideas: CheckedPlanIdea[]; discarded: DiscardedPlanIdea[] } {
  const { brief, period } = params;
  const accepted: CheckedPlanIdea[] = [];
  const discarded: DiscardedPlanIdea[] = [];
  const recent = new Set(brief.recentTopics.map(topicKey));
  const discardedBefore = new Set(brief.discardedTopics.map(topicKey));
  const planned = new Set<string>();
  const pillars = new Set(brief.pillars.map((pillar) => pillar.key));
  /** Posts por red y por semana (el lunes): lo ya planificado y las ideas de este plan. */
  const perWeek = new Map<string, number>();
  for (const slot of brief.planned) {
    for (const platform of slot.platforms) {
      const key = `${platform}:${weekOf(slot.date)}`;
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    }
  }

  for (const raw of params.ideas) {
    const parsed = planIdeaSchema.safeParse(raw);
    if (!parsed.success) {
      const topic =
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { tema?: unknown }).tema === "string"
          ? (raw as { tema: string }).tema.trim().slice(0, PLAN_IDEA_LIMITS.topic)
          : "";
      discarded.push({
        topic,
        code: "FORMAT_INVALID",
        message: `La idea no tiene la forma pedida (${describeIssues(parsed.error).slice(0, 3).join("; ")})`,
      });
      continue;
    }
    const idea = parsed.data;
    const drop = (code: PlanDiscardCode, message: string) =>
      discarded.push({ topic: idea.tema, code, message });

    let plannedAt: Date;
    try {
      if (!isDay(idea.fecha)) throw new Error("día");
      plannedAt = parseChileTime(`${idea.fecha} ${idea.hora}`);
    } catch {
      drop("DATE_INVALID", `La fecha ${idea.fecha} ${idea.hora} no existe en Chile`);
      continue;
    }
    if (plannedAt < period.start || plannedAt >= period.end) {
      drop("OUT_OF_PERIOD", `La fecha ${idea.fecha} está fuera del período`);
      continue;
    }
    if (plannedAt < params.now) {
      drop("IN_THE_PAST", `La fecha ${idea.fecha} ${idea.hora} ya pasó`);
      continue;
    }
    const pillar = idea.linea === null || idea.linea === "" ? null : idea.linea;
    if (pillar !== null && !pillars.has(pillar)) {
      drop("PILLAR_UNKNOWN", `La línea «${pillar}» no está en el perfil editorial`);
      continue;
    }
    const text = `${idea.tema}\n${idea.porque}`;
    if (hasMassMention(text)) {
      drop("MASS_MENTION", "Tiene @everyone o @here");
      continue;
    }
    const facts = unsupportedFacts(text, params.sources);
    if (facts.length > 0) {
      drop("FACT_NOT_IN_PROFILE", facts.join("; "));
      continue;
    }
    const key = topicKey(idea.tema);
    if (recent.has(key)) {
      drop("REPEATED_TOPIC", "Repite un tema de los últimos 60 días");
      continue;
    }
    if (discardedBefore.has(key)) {
      drop("DISCARDED_TOPIC", "Repite una idea que se descartó");
      continue;
    }
    if (planned.has(key)) {
      drop("DUPLICATE_IN_PLAN", "Repite otra idea de este plan");
      continue;
    }
    if (accepted.length >= brief.count) {
      drop("OVER_COUNT", `Ya hay ${brief.count} ideas`);
      continue;
    }

    const week = weekOf(idea.fecha);
    const platforms: PostPlatform[] = [];
    const notes: string[] = [];
    let first: { code: PlanDiscardCode; message: string } | null = null;
    for (const platform of new Set(idea.redes)) {
      let problem = platformProblem(platform, idea, brief);
      const cadence = brief.cadence[platform];
      if (
        problem === null &&
        cadence !== undefined &&
        (perWeek.get(`${platform}:${week}`) ?? 0) >= cadence.postsPerWeek
      ) {
        problem = {
          code: "WEEK_FULL",
          message: `${NAME[platform]} ya tiene ${cadence.postsPerWeek} posts planificados esa semana`,
        };
      }
      if (problem === null) platforms.push(platform);
      else {
        first ??= problem;
        notes.push(problem.message);
      }
    }
    if (platforms.length === 0) {
      drop(first?.code ?? "PLATFORM_NOT_REQUESTED", notes.join("; "));
      continue;
    }
    for (const platform of platforms) {
      perWeek.set(`${platform}:${week}`, (perWeek.get(`${platform}:${week}`) ?? 0) + 1);
    }
    planned.add(key);
    accepted.push({
      topic: idea.tema,
      pillar,
      platforms,
      kind: idea.formato,
      plannedAt,
      rationale: idea.porque,
      notes,
    });
  }
  return { ideas: accepted, discarded };
}

// --- El reporte -------------------------------------------------------------------------------

/**
 * El reporte de un plan terminado (`plan_runs.report`): las ideas que quedaron como posts (con sus
 * redes —que el post también guarda en `platforms` desde T20— y las que se le quitaron, `notes`),
 * las descartadas con su motivo, las advertencias de la IA y la llamada. Es lo que leen T21 (API,
 * CLI y panel) y T22 (evaluación).
 */
export const planRunReportSchema = z.object({
  ideas: z.array(
    z.object({
      postId: z.string(),
      topic: z.string(),
      pillar: z.string().nullable(),
      platforms: z.array(z.enum(POST_PLATFORMS)),
      kind: z.enum(POST_KINDS),
      plannedAt: z.iso.datetime(),
      notes: z.array(z.string()),
    }),
  ),
  discarded: z.array(
    z.object({ topic: z.string(), code: z.enum(PLAN_DISCARD_CODES), message: z.string() }),
  ),
  warnings: z.array(z.string()),
  llm: z
    .object({
      provider: z.enum(LLM_PROVIDERS),
      model: z.string(),
      attempts: z.number().int(),
      durationMs: z.number().int().nonnegative(),
    })
    .optional(),
});
export type PlanRunReport = z.infer<typeof planRunReportSchema>;

// --- Qué hacer si falla -----------------------------------------------------------------------

const PLAN_RETRY_LATER = "Es pasajero: pide el plan de nuevo en unos minutos.";

/** Consejos por código de un plan fallido (`plan_runs.error`), para el panel y la CLI (F9-T21). */
const PLAN_ERROR_ADVICE: Readonly<Record<string, string>> = {
  LLM_BUDGET_EXCEEDED:
    "La marca llegó a su tope de IA del mes: mira el gasto (agentsales usage) y pide al administrador subir el tope, o espera al mes siguiente.",
  LLM_OUTPUT_INVALID: "La IA no entregó el plan en el formato pedido: pide el plan de nuevo.",
  LLM_AUTH_REQUIRED:
    "La sesión de la CLI de Claude venció: el operador la renueva (/login en claude) y después pides el plan de nuevo.",
  LLM_NOT_CONFIGURED:
    "Falta configurar la IA del servidor (LLM_PROVIDER o ANTHROPIC_API_KEY): el operador lo revisa con pnpm -s cli doctor.",
  LLM_ACCOUNT_LIMIT:
    "La cuenta de IA llegó a su límite de uso: espera a que se renueve y pide el plan de nuevo.",
  LLM_REQUEST_REJECTED:
    "La IA rechazó el pedido: revisa el perfil editorial de la marca y pide el plan de nuevo.",
  PLAN_RUN_ABANDONED: "El worker se cortó mientras armaba el plan: pide el plan de nuevo.",
  PLAN_RUN_INVALID: "El plan quedó mal pedido: pídelo de nuevo.",
  QUEUE_UNAVAILABLE: "El worker no está corriendo: arráncalo y pide el plan de nuevo.",
  POST_NO_PLATFORMS:
    "La marca no tiene redes: conecta una cuenta o define la cadencia de una red en su perfil editorial.",
  BROKER_NOT_FOUND: "La marca del plan ya no existe.",
  INTERNAL_ERROR:
    "Es un error del sistema: pide el plan de nuevo y, si se repite, revisa el log del worker.",
};

/**
 * Qué hacer ante un plan fallido (F9-T21): el consejo de su código; los pasajeros (`_UNAVAILABLE`,
 * `_TIMEOUT`, `_ABORTED`, `_RATE_LIMITED`, `LLM_ERROR`), volver a pedirlo en unos minutos; si no,
 * uno genérico.
 */
export function planRunErrorAdvice(code: string): string {
  const own = PLAN_ERROR_ADVICE[code];
  if (own !== undefined) return own;
  if (/_(UNAVAILABLE|TIMEOUT|ABORTED|RATE_LIMITED)$/.test(code) || code === "LLM_ERROR") {
    return PLAN_RETRY_LATER;
  }
  return "Pide el plan de nuevo; si se repite, revisa el log del worker.";
}

// --- Cómo se muestra --------------------------------------------------------------------------

/** `Semana del 19-10 al 25-10`: una semana de lunes a domingo, por su lunes (`AAAA-MM-DD`). */
export function planWeekText(monday: string): string {
  const short = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}`;
  return `Semana del ${short(monday)} al ${short(addDays(monday, 6))}`;
}

/**
 * Agrupa por semana (de lunes a domingo, hora de Chile) lo que tiene fecha, en orden; lo que no
 * tiene fecha va al final, en un grupo con `week = null`. Así ven las ideas la CLI y el panel.
 */
export function groupByPlanWeek<T extends { plannedAt: Date | null }>(
  items: readonly T[],
): { week: string | null; items: T[] }[] {
  const dated = items
    .filter((item) => item.plannedAt !== null)
    .sort((a, b) => (a.plannedAt as Date).getTime() - (b.plannedAt as Date).getTime());
  const groups: { week: string | null; items: T[] }[] = [];
  for (const item of dated) {
    const week = weekOf(chileDateOf(item.plannedAt as Date));
    const last = groups.at(-1);
    if (last?.week === week) last.items.push(item);
    else groups.push({ week, items: [item] });
  }
  const undated = items.filter((item) => item.plannedAt === null);
  if (undated.length > 0) groups.push({ week: null, items: [...undated] });
  return groups;
}
