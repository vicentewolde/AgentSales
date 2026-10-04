import type { AbortSignalLike } from "../abort.js";
import { hasContentErrors } from "../content/check.js";
import { type ContentCheckDeps, loadCheckContext } from "../content/check-context.js";
import { type DraftedText, draftListingTexts } from "../content/draft-texts.js";
import { CONTENT_PROMPT_VERSION } from "../content/prompt.js";
import type { LLMProvider } from "../ports/llm-provider.js";

export type EvaluateListingContentDeps = ContentCheckDeps & { llm: LLMProvider };

/** Un canal evaluado: el texto que se publicaría y su revisión editorial. */
export type EvaluatedText = DraftedText;

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
 * camino que la etapa `texts` de una corrida (`draftListingTexts`: brief → IA → ensamblado →
 * revisión), con el contexto armado una vez (`loadCheckContext`). Sirve para probar el prompt sobre avisos reales. Errores:
 * los del aviso (`LISTING_NOT_FOUND`, `BROKER_NOT_FOUND`) y los de la IA (`LLM_*`).
 */
export async function evaluateListingContent(
  deps: EvaluateListingContentDeps,
  { listingId, signal }: { listingId: string; signal?: AbortSignalLike },
): Promise<ListingEvaluation> {
  const { listing, ctx } = await loadCheckContext(deps, listingId);
  const { texts, ...result } = await draftListingTexts({ llm: deps.llm }, ctx, signal);
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
