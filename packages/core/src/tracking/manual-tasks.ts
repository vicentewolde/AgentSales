import type { ListingStatus } from "../enums.js";
import type { Publication } from "../publication.js";

/**
 * Tareas a mano (spec F6 §4.8, D4), derivadas y sin tabla: las publicaciones de Instagram o
 * Marketplace `published` en `live` de una propiedad `closed`. Ninguna se puede bajar desde el
 * sistema (Instagram no tiene API para borrar y Marketplace no se automatiza): el operador la borra
 * y la marca como retirada. Las usan cambiar la propiedad (T08), la agenda y el seguimiento (T10).
 */
export function isManualTask(listingStatus: ListingStatus, publication: Publication): boolean {
  return (
    listingStatus === "closed" &&
    publication.platform !== "portal_inmobiliario" &&
    !publication.dryRun &&
    publication.status === "published"
  );
}

/** Las tareas a mano de una propiedad, en el orden de sus publicaciones. */
export const manualTasksOf = (
  listingStatus: ListingStatus,
  publications: readonly Publication[],
): Publication[] => publications.filter((publication) => isManualTask(listingStatus, publication));
