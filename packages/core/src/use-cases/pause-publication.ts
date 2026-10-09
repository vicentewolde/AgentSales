import type { AbortSignalLike } from "../abort.js";
import type { PublicationActor } from "../publication.js";
import {
  type OperatedPublication,
  type OperationModeDeps,
  operatePublication,
  type PublicationPlatformDeps,
} from "./publication-operations.js";

export type PausePublicationDeps = PublicationPlatformDeps & OperationModeDeps;

/**
 * Pausa una publicación de Portal (`published` → `paused`, spec F4 §4.9): en Mercado Libre deja de
 * verse y no recibe contactos, y se reactiva cuando se quiera. Pausar no cambia el aviso. Los pasos
 * y los errores, en `operatePublication`.
 */
export function pausePublication(
  deps: PausePublicationDeps,
  params: { publicationId: string; actor: PublicationActor; signal?: AbortSignalLike },
): Promise<OperatedPublication> {
  return operatePublication(deps, { ...params, operation: "pause" });
}
