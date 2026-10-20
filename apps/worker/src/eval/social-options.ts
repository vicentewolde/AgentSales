import { PLAN_MAX_IDEAS, SAMPLE_SOCIAL_DRAFT, samplePlanResponse } from "@agentsales/core";
import type { LlmProviderOptions } from "@agentsales/llm";
import { SOCIAL_EVAL_PROFILES, type SocialEvalProfile } from "./social-profiles.js";

// Las opciones de `pnpm eval:social` que no dependen del `.env` (spec F9-T22).

/** Cuántas ideas por perfil se redactan si no se dice (`--ideas`). */
export const DEFAULT_EVAL_IDEAS = 3;

/**
 * Los proveedores `fake` de la evaluación, sin red ni cuota: el plan de ejemplo de core, que lee lo
 * pedido del prompt (`samplePlanResponse`, como `planLlmProviderOptions`), y el borrador de ejemplo
 * de los textos (`SAMPLE_SOCIAL_DRAFT`, como `socialLlmProviderOptions`).
 */
export function fakeSocialEvalOptions(): { plan: LlmProviderOptions; texts: LlmProviderOptions } {
  return {
    plan: { provider: "fake", data: null, respond: ({ prompt }) => samplePlanResponse(prompt) },
    texts: { provider: "fake", data: SAMPLE_SOCIAL_DRAFT },
  };
}

/** Los perfiles de `--profile <nombre>` (todos sin la opción); uno que no existe es un error. */
export function selectProfiles(
  name: string | undefined,
  profiles: readonly SocialEvalProfile[] = SOCIAL_EVAL_PROFILES,
): SocialEvalProfile[] {
  if (name === undefined) return [...profiles];
  const found = profiles.find((item) => item.name === name.trim());
  if (found === undefined) {
    throw new Error(
      `No existe el perfil «${name}»: usa ${profiles.map((item) => item.name).join(", ")}`,
    );
  }
  return [found];
}

/** `--ideas N`: de 0 (solo el plan) a `PLAN_MAX_IDEAS`; por defecto, `DEFAULT_EVAL_IDEAS`. */
export function parseIdeas(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVAL_IDEAS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || value > PLAN_MAX_IDEAS) {
    throw new Error(`--ideas va de 0 (solo el plan) a ${PLAN_MAX_IDEAS}`);
  }
  return value;
}
