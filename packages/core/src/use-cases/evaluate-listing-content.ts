import type { AbortSignalLike } from "../abort.js";
import { type AssembledText, assembleContents } from "../content/assemble.js";
import { type ContentCheck, checkContent, hasContentErrors } from "../content/check.js";
import { type ContentCheckDeps, loadCheckContext } from "../content/check-context.js";
import { generateContentDraft } from "../content/generate.js";
import { CONTENT_PROMPT_VERSION } from "../content/prompt.js";
import { PLATFORMS, type Platform } from "../enums.js";
import type { LLMProvider } from "../ports/llm-provider.js";

export type EvaluateListingContentDeps = ContentCheckDeps & { llm: LLMProvider };

/** Un canal evaluado: el texto que se publicaría y su revisión editorial. */
export type EvaluatedText = { platform: Platform; text: AssembledText; checks: ContentCheck[] };

export type ListingEvaluation = {
  listingId: string;
  externalRef: string;
  texts: EvaluatedText[];
  /** Las advertencias de la IA (por ejemplo, un requisito discriminatorio que omitió). */
  warnings: string[];
  model: string;
  promptVersion: string;
  /** Llamadas a la IA (2 si reintentó por una salida inválida). */
  attempts: number;
  /** Algún canal tiene un error de la revisión (`hasContentErrors`). */
  hasErrors: boolean;
};

/**
 * Evalúa el contenido de un aviso sin escribir nada (spec F2-T16, `pnpm eval:content`): el mismo
 * camino que la etapa `texts` de una corrida (brief → IA → ensamblado → revisión), con el contexto
 * armado una vez (`loadCheckContext`). Sirve para probar el prompt sobre avisos reales. Errores:
 * los del aviso (`LISTING_NOT_FOUND`, `BROKER_NOT_FOUND`) y los de la IA (`LLM_*`).
 */
export async function evaluateListingContent(
  deps: EvaluateListingContentDeps,
  { listingId, signal }: { listingId: string; signal?: AbortSignalLike },
): Promise<ListingEvaluation> {
  const { listing, ctx } = await loadCheckContext(deps, listingId);
  const result = await generateContentDraft(
    { llm: deps.llm },
    { brief: ctx.brief, ...(signal === undefined ? {} : { signal }) },
  );
  const assembled = assembleContents(ctx.brief, result.draft, ctx.contact);
  const texts = PLATFORMS.map((platform) => ({
    platform,
    text: assembled[platform],
    checks: checkContent(platform, assembled[platform], ctx),
  }));
  return {
    listingId: listing.id,
    externalRef: listing.externalRef,
    texts,
    warnings: [...result.draft.warnings],
    model: result.model,
    promptVersion: CONTENT_PROMPT_VERSION,
    attempts: result.attempts,
    hasErrors: texts.some((item) => hasContentErrors(item.checks)),
  };
}
