import type { z } from "zod";
import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import type { ContentBrief } from "./brief.js";
import { CONTENT_DRAFT_JSON_SCHEMA, type ContentDraft, contentDraftSchema } from "./draft.js";
import { buildContentPrompt } from "./prompt.js";

/** Intentos con la misma IA: el primero y un reintento con el error de validación (spec F2 §4.5). */
const MAX_ATTEMPTS = 2;

export type GenerateContentDraftResult = {
  draft: ContentDraft;
  /** El modelo que respondió (el del intento válido). */
  model: string;
  /** 1 o 2. */
  attempts: number;
};

/**
 * Los motivos de una validación fallida, como `instagram.hook: Too big…`: la ruta y el mensaje de
 * zod, sin los valores (traen datos del aviso).
 */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
  );
}

/**
 * Pide el borrador a la IA y lo valida con `contentDraftSchema` (ADR-0013). Si no calza, reintenta
 * **una vez** con los motivos en el prompt; si vuelve a fallar, `LLM_OUTPUT_INVALID` (no
 * reintentable: el contenido anterior sigue vigente). Los errores del proveedor (`LLM_*`) suben
 * tal cual; el job decide si reintenta.
 */
export async function generateContentDraft(
  deps: { llm: LLMProvider },
  params: { brief: ContentBrief; signal?: AbortSignalLike },
): Promise<GenerateContentDraftResult> {
  let issues: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { system, prompt } = buildContentPrompt(params.brief, issues);
    const response = await deps.llm.generateStructured({
      system,
      prompt,
      jsonSchema: CONTENT_DRAFT_JSON_SCHEMA,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    const parsed = contentDraftSchema.safeParse(response.data);
    if (parsed.success) return { draft: parsed.data, model: response.model, attempts: attempt };
    issues = describeIssues(parsed.error);
  }
  throw new AppError(
    "LLM_OUTPUT_INVALID",
    "La IA no entregó los textos en el formato pedido después de reintentar",
    { details: { attempts: MAX_ATTEMPTS, issues } },
  );
}
