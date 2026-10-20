import type { AbortSignalLike } from "../abort.js";
import { type GenerateDeps, generateValidated } from "../content/generate.js";
import {
  type CheckedPlanIdea,
  checkPlanIdeas,
  type DiscardedPlanIdea,
  PLAN_JSON_SCHEMA,
  type PlanBrief,
  type PlanPeriod,
  validatePlanResponse,
} from "./plan.js";
import { buildPlanPrompt } from "./plan-prompt.js";

/** Lo que propuso la IA para un plan, ya verificado. */
export type ProposedPlanIdeas = {
  ideas: CheckedPlanIdea[];
  discarded: DiscardedPlanIdea[];
  /** Las advertencias de la IA. */
  warnings: string[];
  model: string;
  attempts: number;
  promptChars: number;
};

/**
 * El camino del plan de ideas sin repositorios (spec F9 §4.9, ADR-0030): el brief a la IA, la
 * validación del sobre (con un reintento; después `LLM_OUTPUT_INVALID`) y las verificaciones de cada
 * idea (`checkPlanIdeas`). No escribe nada: lo usan `runPlan` (que guarda el resultado) y la
 * evaluación de T22 (`eval:social`, que no toca la base). `beforeCall` (el tope de IA) y `onUsage`
 * (anotar el gasto) son opcionales, como en `draftPostTexts`.
 */
export async function proposePlanIdeas(
  deps: GenerateDeps,
  params: {
    brief: PlanBrief;
    period: Pick<PlanPeriod, "start" | "end">;
    /** Las fuentes de hechos del perfil (`profileSources`). */
    sources: string;
    /** La hora de las verificaciones (una idea en el pasado se descarta). */
    now: Date;
    signal?: AbortSignalLike;
  },
): Promise<ProposedPlanIdeas> {
  const { data, ...rest } = await generateValidated(deps, {
    buildPrompt: (issues) => buildPlanPrompt(params.brief, issues),
    jsonSchema: PLAN_JSON_SCHEMA,
    validate: validatePlanResponse,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  const checked = checkPlanIdeas({
    ideas: data.ideas,
    brief: params.brief,
    period: params.period,
    sources: params.sources,
    now: params.now,
  });
  return { ...checked, warnings: [...data.warnings], ...rest };
}
