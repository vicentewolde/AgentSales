import { PLAN_MAX_IDEAS } from "@agentsales/core";
import type { LlmProviderOptions } from "@agentsales/llm";
import { planLlmProviderOptions, socialLlmProviderOptions } from "../llm-options.js";
import { SOCIAL_EVAL_PROFILES, type SocialEvalProfile } from "./social-profiles.js";

// Las opciones de `pnpm eval:social` (spec F9-T22).

/** Cuántas ideas por perfil se redactan si no se dice (`--ideas`). */
export const DEFAULT_EVAL_IDEAS = 3;

/** Lo que leen las opciones del proveedor de IA del worker (`llm-options.ts`). */
export type SocialEvalLlmEnv = Parameters<typeof planLlmProviderOptions>[0];

/**
 * El entorno de la IA para `--provider fake` sin leer el `.env`: `fake` no usa lo demás (los valores
 * son los por defecto de `@agentsales/config`).
 */
export const FAKE_LLM_ENV: SocialEvalLlmEnv = {
  LLM_PROVIDER: "fake",
  LLM_MODEL: "sonnet",
  CLAUDE_CLI_PATH: "claude",
  LLM_TIMEOUT_SECONDS: 180,
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
};

/**
 * Los proveedores de la evaluación, los mismos del worker: el del plan (`planLlmProviderOptions`;
 * con `fake`, el plan de ejemplo que lee lo pedido del prompt) y el de los textos
 * (`socialLlmProviderOptions`; con `fake`, el borrador de ejemplo). Con un proveedor real son iguales.
 */
export function socialEvalProviderOptions(
  env: SocialEvalLlmEnv,
  baseEnv: Readonly<Record<string, string | undefined>>,
): { plan: LlmProviderOptions; texts: LlmProviderOptions } {
  return {
    plan: planLlmProviderOptions(env, baseEnv),
    texts: socialLlmProviderOptions(env, baseEnv),
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
