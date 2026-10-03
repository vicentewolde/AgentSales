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
  /** Largo del prompt del intento válido, para los logs (spec F2 §4.5); nunca el prompt. */
  promptChars: number;
};

/** Texto fijo por tipo de problema: nunca el mensaje de zod, que puede citar lo que respondió la IA. */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `tipo incorrecto (se esperaba ${issue.expected})`;
    case "too_big":
      return `demasiado largo (máximo ${String(issue.maximum)})`;
    case "too_small":
      return `demasiado corto o vacío (mínimo ${String(issue.minimum)})`;
    case "unrecognized_keys":
      return "tiene claves que no están en el formato pedido";
    default:
      return "valor no válido";
  }
}

/**
 * Los motivos de una validación fallida, como `instagram.hook: demasiado largo (máximo 150)`: la
 * ruta (claves del esquema e índices) y un texto fijo, sin valores ni claves que haya inventado la
 * IA (podrían repetir datos del aviso o una instrucción, y van al prompt de reintento sin escape).
 */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? describeIssue(issue) : `${path}: ${describeIssue(issue)}`;
  });
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
    if (parsed.success) {
      return {
        draft: parsed.data,
        model: response.model,
        attempts: attempt,
        promptChars: system.length + prompt.length,
      };
    }
    issues = describeIssues(parsed.error);
  }
  throw new AppError(
    "LLM_OUTPUT_INVALID",
    "La IA no entregó los textos en el formato pedido después de reintentar",
    { details: { attempts: MAX_ATTEMPTS, issues } },
  );
}
