import type { AbortSignalLike } from "../abort.js";
import type { PublicationActor } from "../publication.js";
import {
  type OperatedPublication,
  type OperationModeDeps,
  operatePublication,
  type PublicationPlatformDeps,
} from "./publication-operations.js";

export type ClosePublicationDeps = PublicationPlatformDeps & OperationModeDeps;

/**
 * Cierra una publicación de Portal (`published` o `paused` → `unpublished`, spec F4 §4.9). En
 * `live` es **irreversible** (volver a publicar crea otro ítem y gasta otro cupo), así que pide
 * `confirmed` (`CLOSE_NOT_CONFIRMED`). Al cerrar la última publicada o pausada en `live` del aviso,
 * este vuelve a `ready`. Los pasos y los errores, en `operatePublication`.
 */
export function closePublication(
  deps: ClosePublicationDeps,
  params: {
    publicationId: string;
    actor: PublicationActor;
    confirmed?: boolean;
    signal?: AbortSignalLike;
  },
): Promise<OperatedPublication> {
  return operatePublication(deps, { ...params, operation: "close" });
}
