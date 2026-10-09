import type { AbortSignalLike } from "../abort.js";
import type { PublicationActor } from "../publication.js";
import {
  type OperatedPublication,
  type OperationModeDeps,
  operatePublication,
  type PublicationPlatformDeps,
} from "./publication-operations.js";

export type ResumePublicationDeps = PublicationPlatformDeps & OperationModeDeps;

/**
 * Reactiva una publicación de Portal pausada (`paused` → `published`, spec F4 §4.9), también una
 * pausada por moderación de Mercado Libre (nota §4.4). Los pasos y los errores, en
 * `operatePublication`.
 */
export function resumePublication(
  deps: ResumePublicationDeps,
  params: { publicationId: string; actor: PublicationActor; signal?: AbortSignalLike },
): Promise<OperatedPublication> {
  return operatePublication(deps, { ...params, operation: "resume" });
}
