import {
  type AbortSignalLike,
  buildPlanBrief,
  buildPostCheckContext,
  buildSocialBrief,
  type CheckedPlanIdea,
  type ContentCheck,
  type DiscardedPlanIdea,
  draftPostTexts,
  escapeLinkedInText,
  findAiTells,
  formatChileTime,
  isAppError,
  joinedPostText,
  kindProblem,
  type Language,
  type LLMProvider,
  llmCallCost,
  PLAN_PROMPT_VERSION,
  PLAN_SIMILAR_TOPIC_THRESHOLD,
  type PlanDiscardCode,
  POST_TEXT_LIMITS,
  type PostKind,
  type PostPlatform,
  planPeriod,
  profileSources,
  proposePlanIdeas,
  roundUsd,
  SOCIAL_PROMPT_VERSION,
  socialTargets,
  topicSimilarity,
} from "@agentsales/core";

/** La medida de parecido de temas vive en core desde F9.5 (`IDEA_TOO_SIMILAR`); aquí se reexporta. */
export { topicSimilarity };

import type { SocialEvalProfile } from "./social-profiles.js";

// `pnpm eval:social` (spec F9-T22): el plan de ideas y los textos de algunas ideas sobre perfiles de
// prueba, con el mismo código de core que usan `runPlan` y `post.draft`, **sin la base**: no recibe
// repositorios ni escribe nada (el informe JSON lo escribe el script, si se pide). Cuenta lo que la
// IA hizo mal y lo que costó.

/** Lo que necesita la evaluación: solo la IA y dónde imprimir. */
export type SocialEvalDeps = {
  /**
   * El proveedor del plan y el de los textos. Con uno real son el mismo; con `fake`, uno arma el plan
   * de ejemplo (`samplePlanResponse`) y el otro devuelve el borrador de ejemplo.
   */
  planLlm: LLMProvider;
  textLlm: LLMProvider;
  print: (line: string) => void;
  /** La hora del período y de las verificaciones. Por defecto, la actual. */
  now?: () => Date;
};

export type SocialEvalOptions = {
  profiles: readonly SocialEvalProfile[];
  /** Cuántas ideas aceptadas se redactan por perfil (las primeras del plan); 0, solo el plan. */
  ideas: number;
  /** `--strict`: también sale con 1 si el plan descartó alguna idea. */
  strict?: boolean;
  signal?: AbortSignalLike;
};

/** Lo gastado en una etapa (el plan o los textos). */
export type SocialEvalUsage = {
  /** Llamadas a la IA (también las que fallaron o no validaron). */
  calls: number;
  /** Llamadas con uso informado por el proveedor (con `fake`, ninguna). */
  reportedCalls: number;
  /** Caracteres del prompt de sistema y del de datos, sumados en todas las llamadas. */
  promptChars: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Estimado con la tabla de precios de core; 0 salvo con `anthropic-api`. */
  costUsd: number;
  models: string[];
};

/** Un problema de escape de un texto (lo que la red mostraría mal). */
export type SocialEscapeProblem = {
  code: "LINKEDIN_ESCAPE_OVERFLOW" | "HASHTAG_IN_BODY" | "INVISIBLE_CHARACTERS";
  message: string;
};

/** Un texto redactado con su revisión. */
export type SocialEvalText = {
  topic: string;
  platform: PostPlatform;
  language: Language;
  body: string;
  hashtags: string[];
  checks: ContentCheck[];
  escapes: SocialEscapeProblem[];
};

/** Una idea aceptada que se parece a un tema del historial o a otra idea del plan. */
export type SimilarTopic = { topic: string; like: string; against: "historial" | "plan" };

/** Lo que falló en una llamada (el código y el mensaje del error, sin la pila). */
export type SocialEvalFailure = {
  stage: "plan" | "textos";
  topic: string | null;
  code: string;
  message: string;
};

/** Los contadores de la evaluación (de un perfil o del total). */
export type SocialEvalCounts = {
  ideasRequested: number;
  ideasAccepted: number;
  ideasDiscarded: number;
  /** Las descartadas por cada motivo de `checkPlanIdeas`. */
  discardedByCode: Partial<Record<PlanDiscardCode, number>>;
  /**
   * Descartadas por repetir un tema reciente, uno descartado u otra idea del plan, o por parecerse
   * en un 60 % o más a otra idea del plan (`IDEA_TOO_SIMILAR`, F9.5).
   */
  repeated: number;
  /** Descartadas porque la cadencia no les dejó una ranura libre (`NO_SLOT`, F9.5). */
  noSlot: number;
  /**
   * Descartadas por hablar de «nosotros» sin que el perfil diga que la marca es un equipo
   * (`FIRST_PERSON_PLURAL`, F9.5-T23).
   */
  firstPersonPlural: number;
  /**
   * Aceptadas que se parecen a un tema del historial (advertencia: el plan descarta las parecidas
   * entre sí, no las parecidas a lo reciente, que solo compara iguales).
   */
  similar: number;
  /** Cifras, nombres, menciones o enlaces fuera del perfil: en las ideas y en los textos. */
  outsideProfile: number;
  /** Textos más largos que su red (o con más hashtags de los que admite). */
  tooLong: number;
  /** Problemas de escape de los textos (no el markdown: es una advertencia de la revisión). */
  escapes: number;
  /** `@everyone` o `@here`: en las ideas y en los textos. */
  massMentions: number;
  /** Términos que el perfil pide evitar (advertencia). */
  avoided: number;
  /** Muletillas de texto escrito por IA en los textos (`findAiTells`, advertencia `AI_TELL`). */
  aiTells: number;
  texts: number;
  textsWithErrors: number;
  failures: number;
};

/** La evaluación de un perfil. */
export type SocialProfileEvaluation = {
  profile: string;
  brandName: string;
  languages: Language[];
  period: { firstDay: string; lastDay: string };
  plan: {
    provider: string;
    model: string;
    attempts: number;
    ideas: (Omit<CheckedPlanIdea, "plannedAt"> & { plannedAt: string })[];
    discarded: DiscardedPlanIdea[];
    warnings: string[];
    similar: SimilarTopic[];
  } | null;
  texts: SocialEvalText[];
  textWarnings: string[];
  failures: SocialEvalFailure[];
  usage: { plan: SocialEvalUsage; texts: SocialEvalUsage };
  counts: SocialEvalCounts;
};

/** El informe completo (`--out` lo guarda en `tmp/eval-social/`). */
export type SocialEvalReport = {
  date: string;
  promptVersions: { plan: string; texts: string };
  provider: { plan: string; texts: string };
  profiles: SocialProfileEvaluation[];
  totals: SocialEvalCounts;
  usage: { plan: SocialEvalUsage; texts: SocialEvalUsage; total: SocialEvalUsage };
  /** La evaluación se cortó (Ctrl+C o un error que no se arregla reintentando). */
  stopped: boolean;
};

/**
 * Errores del proveedor que no se arreglan con el perfil siguiente: sin sesión o sin clave, sin
 * saldo, el límite de uso de la CLI, o un corte. La evaluación se detiene ahí (no gasta de más).
 */
const STOPPING_CODES = new Set([
  "LLM_AUTH_REQUIRED",
  "LLM_NOT_CONFIGURED",
  "LLM_ACCOUNT_LIMIT",
  "LLM_RATE_LIMITED",
  "LLM_ABORTED",
]);

const REPEATED_CODES: readonly PlanDiscardCode[] = [
  "REPEATED_TOPIC",
  "DISCARDED_TOPIC",
  "DUPLICATE_IN_PLAN",
  "IDEA_TOO_SIMILAR",
];

/** Similitud desde la que dos temas se informan como parecidos: la misma del plan (core). */
export const SIMILAR_TOPIC_THRESHOLD = PLAN_SIMILAR_TOPIC_THRESHOLD;

/**
 * Las ideas aceptadas que se parecen (sin ser iguales: esas ya las descarta `checkPlanIdeas`) a un
 * tema del historial o a una idea anterior del mismo plan. Es una advertencia para leer a mano: con
 * el historial, el plan solo compara temas iguales; entre ideas del mismo plan, desde F9.5 descarta
 * las parecidas (`IDEA_TOO_SIMILAR`), así que ahí solo aparece si cambia el umbral
 * (`docs/04-formato-publicaciones.md`).
 */
export function similarTopics(
  accepted: readonly string[],
  history: readonly string[],
): SimilarTopic[] {
  const found: SimilarTopic[] = [];
  accepted.forEach((topic, index) => {
    const pastMatch = history.find(
      (past) => topicSimilarity(topic, past) >= SIMILAR_TOPIC_THRESHOLD,
    );
    if (pastMatch !== undefined) {
      found.push({ topic, like: pastMatch, against: "historial" });
      return;
    }
    const planMatch = accepted
      .slice(0, index)
      .find((other) => topicSimilarity(topic, other) >= SIMILAR_TOPIC_THRESHOLD);
    if (planMatch !== undefined) found.push({ topic, like: planMatch, against: "plan" });
  });
  return found;
}

/** Un hashtag dentro del cuerpo (va en `hashtags`; en LinkedIn saldría escapado, `\#tag`). */
const HASHTAG_IN_BODY = /(?<![\p{L}\p{N}_&])#[\p{L}\p{N}_]+/u;
/** Caracteres de ancho cero y la arroba ancha: esconden menciones o texto. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\uFF20]/u;

/**
 * Los problemas de escape de un texto: LinkedIn que cabe sin los escapes pero no con ellos
 * (`escapeLinkedInText`); un hashtag en el cuerpo; caracteres invisibles o la arroba ancha. El
 * markdown no cuenta aquí: es la advertencia `MARKDOWN` de `checkPostContent` y sale con su revisión.
 */
export function escapeProblems(
  platform: PostPlatform,
  text: { body: string; hashtags: readonly string[] },
): SocialEscapeProblem[] {
  const problems: SocialEscapeProblem[] = [];
  const joined = joinedPostText(text);
  if (platform === "linkedin") {
    const escaped = escapeLinkedInText(joined).length;
    const max = POST_TEXT_LIMITS.linkedin;
    if (joined.length <= max && escaped > max) {
      problems.push({
        code: "LINKEDIN_ESCAPE_OVERFLOW",
        message: `Cabe sin escapes (${joined.length}) pero no con ellos (${escaped}; máximo ${max})`,
      });
    }
  }
  if (HASHTAG_IN_BODY.test(text.body)) {
    problems.push({
      code: "HASHTAG_IN_BODY",
      message: "Tiene un hashtag dentro del texto (van aparte; en LinkedIn saldría escapado)",
    });
  }
  if (INVISIBLE.test(joined)) {
    problems.push({
      code: "INVISIBLE_CHARACTERS",
      message: "Tiene caracteres de ancho cero o la arroba ancha (U+FF20)",
    });
  }
  return problems;
}

const emptyUsage = (): SocialEvalUsage => ({
  calls: 0,
  reportedCalls: 0,
  promptChars: 0,
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  models: [],
});

function addUsage(target: SocialEvalUsage, source: SocialEvalUsage): void {
  target.calls += source.calls;
  target.reportedCalls += source.reportedCalls;
  target.promptChars += source.promptChars;
  target.inputTokens += source.inputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.outputTokens += source.outputTokens;
  target.costUsd = roundUsd(target.costUsd + source.costUsd);
  for (const model of source.models) if (!target.models.includes(model)) target.models.push(model);
}

/** El proveedor con sus llamadas contadas (y el largo de cada prompt) en `usage`. */
function measured(llm: LLMProvider, usage: SocialEvalUsage): LLMProvider {
  return {
    name: llm.name,
    generateStructured(request) {
      usage.calls += 1;
      usage.promptChars += request.system.length + request.prompt.length;
      return llm.generateStructured(request);
    },
  };
}

/** Anota el uso que informa el proveedor (también el de una respuesta que no validó). */
const recordUsage =
  (llm: LLMProvider, usage: SocialEvalUsage) =>
  async (model: string, tokens: Parameters<typeof llmCallCost>[2]) => {
    const call = llmCallCost(llm.name, model, tokens);
    usage.reportedCalls += 1;
    usage.inputTokens += call.inputTokens;
    usage.cacheCreationInputTokens += call.cacheCreationInputTokens;
    usage.cacheReadInputTokens += call.cacheReadInputTokens;
    usage.outputTokens += call.outputTokens;
    usage.costUsd = roundUsd(usage.costUsd + call.costUsd);
    if (!usage.models.includes(model)) usage.models.push(model);
  };

const emptyCounts = (): SocialEvalCounts => ({
  ideasRequested: 0,
  ideasAccepted: 0,
  ideasDiscarded: 0,
  discardedByCode: {},
  repeated: 0,
  noSlot: 0,
  firstPersonPlural: 0,
  similar: 0,
  outsideProfile: 0,
  tooLong: 0,
  escapes: 0,
  massMentions: 0,
  avoided: 0,
  aiTells: 0,
  texts: 0,
  textsWithErrors: 0,
  failures: 0,
});

function addCounts(target: SocialEvalCounts, source: SocialEvalCounts): void {
  for (const key of Object.keys(source) as (keyof SocialEvalCounts)[]) {
    if (key === "discardedByCode") continue;
    target[key] += source[key];
  }
  for (const [code, n] of Object.entries(source.discardedByCode) as [PlanDiscardCode, number][]) {
    target.discardedByCode[code] = (target.discardedByCode[code] ?? 0) + n;
  }
}

/** Los medios que se suponen subidos para un tipo de post (los textos no se evalúan por medios). */
function simulatedMedia(kind: PostKind): { role: "original"; kind: "image" | "video" }[] {
  const images = (n: number) =>
    Array.from({ length: n }, () => ({ role: "original" as const, kind: "image" as const }));
  switch (kind) {
    case "text":
      return [];
    case "image":
      return images(1);
    case "carousel":
      return images(3);
    case "video":
      return [{ role: "original", kind: "video" }];
  }
}

/** Los contadores de un perfil, con lo que dejó el plan y los textos. */
function countProfile(evaluation: Omit<SocialProfileEvaluation, "counts">, requested: number) {
  const counts = emptyCounts();
  counts.ideasRequested = requested;
  counts.failures = evaluation.failures.length;
  if (evaluation.plan !== null) {
    counts.ideasAccepted = evaluation.plan.ideas.length;
    counts.ideasDiscarded = evaluation.plan.discarded.length;
    counts.similar = evaluation.plan.similar.length;
    for (const { code } of evaluation.plan.discarded) {
      counts.discardedByCode[code] = (counts.discardedByCode[code] ?? 0) + 1;
      if (REPEATED_CODES.includes(code)) counts.repeated += 1;
      if (code === "NO_SLOT") counts.noSlot += 1;
      if (code === "FIRST_PERSON_PLURAL") counts.firstPersonPlural += 1;
      if (code === "FACT_NOT_IN_PROFILE") counts.outsideProfile += 1;
      if (code === "MASS_MENTION") counts.massMentions += 1;
    }
  }
  for (const text of evaluation.texts) {
    counts.texts += 1;
    if (text.checks.some((check) => check.severity === "error")) counts.textsWithErrors += 1;
    counts.escapes += text.escapes.length;
    counts.aiTells += findAiTells(text.body).length;
    for (const { code } of text.checks) {
      if (code === "FACT_NOT_IN_PROFILE" || code === "LINK_NOT_ALLOWED") counts.outsideProfile += 1;
      if (code === "TOO_LONG" || code === "HASHTAG_LIMIT") counts.tooLong += 1;
      if (code === "MASS_MENTION") counts.massMentions += 1;
      if (code === "AVOID_TERM") counts.avoided += 1;
    }
  }
  return counts;
}

/**
 * El código de salida: 1 si hubo fallas, un corte, o problemas que sí llegan al operador (textos con
 * errores o con escapes). Las ideas que el plan descarta son la defensa funcionando: son estadística,
 * salvo con `strict` (`--strict`), que también sale con 1 si el plan descartó alguna.
 */
export function socialEvalExitCode(
  totals: SocialEvalCounts,
  { stopped, strict = false }: { stopped: boolean; strict?: boolean },
): number {
  if (stopped || totals.failures > 0 || totals.textsWithErrors > 0 || totals.escapes > 0) return 1;
  return strict && totals.ideasDiscarded > 0 ? 1 : 0;
}

/**
 * La falla de una llamada: el código y el mensaje de un `AppError`, o `INTERNAL_ERROR` con el
 * mensaje de cualquier otra excepción (así el informe parcial y lo gastado no se pierden). Sin pila.
 */
const failureOf = (
  stage: SocialEvalFailure["stage"],
  topic: string | null,
  error: unknown,
): SocialEvalFailure =>
  isAppError(error)
    ? { stage, topic, code: error.code, message: error.message }
    : {
        stage,
        topic,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };

/** Una falla que detiene la evaluación: la de `STOPPING_CODES`, una inesperada o un corte. */
const stopsOn = (failure: SocialEvalFailure, signal: AbortSignalLike | undefined) =>
  STOPPING_CODES.has(failure.code) || failure.code === "INTERNAL_ERROR" || signal?.aborted === true;

/** Evalúa un perfil: el plan y los textos de sus primeras ideas aceptadas. */
async function evaluateProfile(
  deps: SocialEvalDeps,
  item: SocialEvalProfile,
  options: SocialEvalOptions,
): Promise<{ evaluation: SocialProfileEvaluation; stop: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const period = planPeriod({ now, days: item.days });
  const usage = { plan: emptyUsage(), texts: emptyUsage() };
  const failures: SocialEvalFailure[] = [];
  const texts: SocialEvalText[] = [];
  const textWarnings: string[] = [];
  let plan: SocialProfileEvaluation["plan"] = null;
  let stop = false;
  // El encabezado antes de llamar a la IA: con un proveedor real, un perfil tarda.
  deps.print("");
  deps.print(
    `■ ${item.name} · ${item.broker.brandName} · ${item.profile.languages.join(" y ")} · ` +
      `${period.firstDay} a ${period.lastDay}`,
  );
  if (item.guidance !== undefined) deps.print(`  Pedido del operador: ${item.guidance}`);

  const planLlm = measured(deps.planLlm, usage.plan);
  try {
    const brief = buildPlanBrief({
      broker: item.broker,
      profile: item.profile,
      period,
      platforms: item.platforms,
      count: item.count,
      history: item.history,
      // El pedido del operador (F9.5-T23): va a la IA, pero no a las fuentes de hechos.
      guidance: item.guidance ?? null,
    });
    const result = await proposePlanIdeas(
      { llm: planLlm, onUsage: recordUsage(deps.planLlm, usage.plan) },
      {
        brief,
        period,
        sources: profileSources(item.profile, item.broker),
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    plan = {
      provider: deps.planLlm.name,
      model: result.model,
      attempts: result.attempts,
      ideas: result.ideas.map((idea) => ({ ...idea, plannedAt: idea.plannedAt.toISOString() })),
      discarded: result.discarded,
      warnings: result.warnings,
      similar: similarTopics(
        result.ideas.map((idea) => idea.topic),
        [...item.history.recentTopics, ...item.history.discardedTopics],
      ),
    };
  } catch (error) {
    const failure = failureOf("plan", null, error);
    failures.push(failure);
    stop = stopsOn(failure, options.signal);
  }

  // Los textos de las primeras ideas aceptadas, como si el operador las aceptara (`post.draft`).
  const textLlm = measured(deps.textLlm, usage.texts);
  for (const idea of plan?.ideas.slice(0, options.ideas) ?? []) {
    if (stop || options.signal?.aborted) break;
    const platforms = idea.platforms.filter(
      (platform) => kindProblem(platform, idea.kind) === null,
    );
    if (platforms.length === 0) continue;
    const post = {
      topic: idea.topic,
      brief: null,
      briefOrigin: "ai" as const,
      source: "ai" as const,
      pillar: idea.pillar,
      kind: idea.kind,
      xLinkAllowed: false,
    };
    try {
      const result = await draftPostTexts(
        { llm: textLlm, onUsage: recordUsage(deps.textLlm, usage.texts) },
        {
          brief: buildSocialBrief({
            post,
            profile: item.profile,
            broker: item.broker,
            targets: socialTargets(platforms, item.profile.languages),
          }),
          ctx: buildPostCheckContext({
            post,
            profile: item.profile,
            broker: item.broker,
            media: simulatedMedia(idea.kind),
          }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      textWarnings.push(...result.draft.warnings);
      for (const text of result.texts) {
        texts.push({
          topic: idea.topic,
          platform: text.platform,
          language: text.language,
          body: text.body,
          hashtags: text.hashtags,
          checks: text.checks,
          escapes: escapeProblems(text.platform, text),
        });
      }
    } catch (error) {
      const failure = failureOf("textos", idea.topic, error);
      failures.push(failure);
      stop = stopsOn(failure, options.signal);
    }
  }

  const partial = {
    profile: item.name,
    brandName: item.broker.brandName,
    languages: [...item.profile.languages],
    period: { firstDay: period.firstDay, lastDay: period.lastDay },
    plan,
    texts,
    textWarnings,
    failures,
    usage,
  };
  return { evaluation: { ...partial, counts: countProfile(partial, item.count) }, stop };
}

// --- Lo que se imprime ------------------------------------------------------------------------

/** Por qué la evaluación sale con 1, en palabras. */
function resultReason(totals: SocialEvalCounts, stopped: boolean): string {
  const reasons = [
    stopped ? "se cortó" : "",
    totals.failures > 0 ? `${totals.failures} fallas de la IA` : "",
    totals.textsWithErrors > 0 ? `${totals.textsWithErrors} textos con errores` : "",
    totals.escapes > 0 ? `${totals.escapes} problemas de escape` : "",
  ].filter((reason) => reason !== "");
  return reasons.length > 0 ? reasons.join(" · ") : "el plan descartó ideas (--strict)";
}

const NAME: Readonly<Record<PostPlatform, string>> = {
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
  discord: "Discord",
  tiktok: "TikTok",
};

const int = (n: number) => n.toLocaleString("es-CL");
const usd = (n: number) => `US$ ${n.toFixed(4).replace(".", ",")}`;
const short = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** El horario de una idea en hora de Chile (`2026-10-21 10:00`). */
const chileTime = (iso: string) => formatChileTime(new Date(iso));

function countsLine(counts: SocialEvalCounts): string {
  return (
    `repetidas ${counts.repeated} · sin ranura ${counts.noSlot} · ` +
    `en plural ${counts.firstPersonPlural} · ` +
    `fuera del perfil ${counts.outsideProfile} · ` +
    `largos ${counts.tooLong} · escapes ${counts.escapes} · menciones masivas ${counts.massMentions}` +
    ` · fallas ${counts.failures} | ⚠ parecidas ${counts.similar} · términos a evitar ${counts.avoided}` +
    ` · muletillas de IA ${counts.aiTells}`
  );
}

/**
 * Lo gastado en una etapa. Si solo algunas llamadas informaron tokens, lo dice ("n de m llamadas
 * informadas") y marca el costo como parcial: no parece completo.
 */
export function usageLine(label: string, usage: SocialEvalUsage, provider: string): string {
  const calls = `${usage.calls} ${usage.calls === 1 ? "llamada" : "llamadas"}`;
  const chars = `${int(usage.promptChars)} caracteres de prompt`;
  if (usage.reportedCalls === 0) {
    return `${label}: ${calls} · ${chars} · ${provider} no informa tokens (US$ 0)`;
  }
  const input = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const partial = usage.reportedCalls < usage.calls;
  return (
    `${label}: ${calls} · ${chars} · ` +
    (partial ? `${usage.reportedCalls} de ${usage.calls} llamadas informadas · ` : "") +
    `${int(input)} tokens de entrada · ${int(usage.outputTokens)} de salida · ` +
    `${usd(usage.costUsd)}${partial ? " (parcial: falta lo no informado)" : ""}`
  );
}

function printProfile(print: (line: string) => void, evaluation: SocialProfileEvaluation): void {
  const { plan, counts } = evaluation;
  if (plan !== null) {
    print(
      `  Plan (${plan.model}, ${plan.attempts} intento${plan.attempts === 1 ? "" : "s"}): ` +
        `${counts.ideasRequested} pedidas · ${counts.ideasAccepted} aceptadas · ` +
        `${counts.ideasDiscarded} descartadas`,
    );
    for (const idea of plan.ideas) {
      const networks = idea.platforms.map((platform) => NAME[platform]).join(", ");
      print(
        `    ✓ ${chileTime(idea.plannedAt)} · ${networks} · ${idea.kind} · ${short(idea.topic)}`,
      );
    }
    for (const idea of plan.discarded) {
      print(
        `    ✗ ${idea.code}: ${short(idea.topic || "(sin tema)")} (${short(idea.message, 90)})`,
      );
    }
    for (const similar of plan.similar) {
      print(
        `    ⚠ parecida (${similar.against}): «${short(similar.topic, 50)}» ~ «${short(similar.like, 50)}»`,
      );
    }
    for (const warning of plan.warnings) print(`    ⚠ IA: ${short(warning, 120)}`);
  }
  if (evaluation.texts.length > 0) {
    print(`  Textos (${evaluation.texts.length}):`);
    for (const text of evaluation.texts) {
      const problems = [
        ...text.checks.map((check) => `${check.severity === "error" ? "✗" : "⚠"} ${check.code}`),
        ...text.escapes.map((problem) => `✗ ${problem.code}`),
      ];
      const bad = problems.some((problem) => problem.startsWith("✗"));
      print(
        `    ${bad ? "✗" : "✓"} ${NAME[text.platform]} ${text.language} · ${short(text.topic, 40)}: ` +
          (problems.length === 0 ? "sin problemas" : problems.join(", ")),
      );
      for (const check of text.checks) print(`        ${check.code}: ${short(check.message, 110)}`);
      for (const problem of text.escapes) print(`        ${problem.code}: ${problem.message}`);
    }
    for (const warning of evaluation.textWarnings) print(`    ⚠ IA: ${short(warning, 120)}`);
  }
  for (const failure of evaluation.failures) {
    const where =
      failure.topic === null ? failure.stage : `${failure.stage} de «${short(failure.topic, 40)}»`;
    print(`  ✗ ${where}: ${failure.code}: ${failure.message}`);
  }
  print(`  Conteo: ${countsLine(counts)}`);
}

/**
 * `pnpm eval:social` (spec F9-T22): por cada perfil, el plan (`proposePlanIdeas`) y los textos de
 * sus primeras `ideas` ideas aceptadas (`draftPostTexts`, por red e idioma), con las verificaciones
 * de core, sin la base. Imprime lo que pasó y lo que costó (el plan y los textos por separado y en
 * total) y devuelve el informe y el código de salida (`socialEvalExitCode`).
 */
export async function runSocialEval(
  deps: SocialEvalDeps,
  options: SocialEvalOptions,
): Promise<{ exitCode: number; report: SocialEvalReport }> {
  const profiles: SocialProfileEvaluation[] = [];
  let stopped = false;
  for (const item of options.profiles) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    const { evaluation, stop } = await evaluateProfile(deps, item, options);
    profiles.push(evaluation);
    printProfile(deps.print, evaluation);
    if (stop) {
      stopped = true;
      break;
    }
  }

  const totals = emptyCounts();
  const usage = { plan: emptyUsage(), texts: emptyUsage(), total: emptyUsage() };
  for (const evaluation of profiles) {
    addCounts(totals, evaluation.counts);
    addUsage(usage.plan, evaluation.usage.plan);
    addUsage(usage.texts, evaluation.usage.texts);
  }
  addUsage(usage.total, usage.plan);
  addUsage(usage.total, usage.texts);

  const print = deps.print;
  print("");
  if (stopped) print("Evaluación cortada: no se pidió nada más a la IA.");
  print(`Resumen de ${profiles.length} de ${options.profiles.length} perfiles`);
  const byCode = Object.entries(totals.discardedByCode)
    .map(([code, n]) => `${code} ${n}`)
    .join(", ");
  print(
    `  Ideas: ${totals.ideasRequested} pedidas · ${totals.ideasAccepted} aceptadas · ` +
      `${totals.ideasDiscarded} descartadas por el plan${byCode === "" ? "" : ` (${byCode})`}`,
  );
  print(
    `  Textos: ${totals.texts} · con errores ${totals.textsWithErrors} · escapes ${totals.escapes}`,
  );
  print(`  Conteo (ideas y textos): ${countsLine(totals)}`);
  print(`  Costo estimado (${[...new Set([deps.planLlm.name, deps.textLlm.name])].join(", ")}):`);
  print(`    ${usageLine("plan", usage.plan, deps.planLlm.name)}`);
  print(`    ${usageLine("textos", usage.texts, deps.textLlm.name)}`);
  print(`    ${usageLine("total", usage.total, deps.textLlm.name)}`);
  if (totals.texts > 0 && usage.texts.costUsd > 0) {
    print(`    por texto (red e idioma): ${usd(usage.texts.costUsd / totals.texts)}`);
  }

  const report: SocialEvalReport = {
    date: (deps.now ?? (() => new Date()))().toISOString(),
    promptVersions: { plan: PLAN_PROMPT_VERSION, texts: SOCIAL_PROMPT_VERSION },
    provider: { plan: deps.planLlm.name, texts: deps.textLlm.name },
    profiles,
    totals,
    usage,
    stopped,
  };
  const exitCode = socialEvalExitCode(totals, {
    stopped,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  });
  print(
    exitCode === 0
      ? "Resultado: ✓ sin fallas ni problemas en los textos (las ideas descartadas son estadística)"
      : `Resultado: ✗ ${resultReason(totals, stopped)}`,
  );
  return { exitCode, report };
}
