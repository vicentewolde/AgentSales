import type { AbortSignalLike } from "../abort.js";
import { PLATFORMS, type Platform } from "../enums.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import { type AssembledText, assembleContents } from "./assemble.js";
import { type ContentCheck, type ContentCheckContext, checkContent } from "./check.js";
import { type GenerateContentDraftResult, generateContentDraft } from "./generate.js";

/** Un canal redactado: el texto que se publicaría y su revisión editorial. */
export type DraftedText = { platform: Platform; text: AssembledText; checks: ContentCheck[] };

export type DraftListingTextsResult = GenerateContentDraftResult & { texts: DraftedText[] };

/**
 * El camino de los textos de un aviso (spec F2 §4.4 y §4.6, ADR-0013): el brief del contexto a la
 * IA, el ensamblado de los tres canales con los datos por código y la revisión de cada uno. Lo
 * comparten la etapa `texts` de una corrida (`prepareContent`) y la evaluación del prompt
 * (`evaluateListingContent`), así lo que se evalúa es lo que se publicaría.
 */
export async function draftListingTexts(
  deps: { llm: LLMProvider },
  ctx: ContentCheckContext,
  signal?: AbortSignalLike,
): Promise<DraftListingTextsResult> {
  const result = await generateContentDraft(deps, {
    brief: ctx.brief,
    ...(signal === undefined ? {} : { signal }),
  });
  const assembled = assembleContents(ctx.brief, result.draft, ctx.contact);
  return {
    ...result,
    texts: PLATFORMS.map((platform) => ({
      platform,
      text: assembled[platform],
      checks: checkContent(platform, assembled[platform], ctx),
    })),
  };
}
