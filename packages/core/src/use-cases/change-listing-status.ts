import type { AbortSignalLike } from "../abort.js";
import type { CloseReason, ListingStatus } from "../enums.js";
import { AppError } from "../errors.js";
import { canDoListingAction, type Listing, type ListingAction } from "../listing.js";
import { manualConfirmPending } from "../marketplace/limits.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";
import { manualTasksOf } from "../tracking/manual-tasks.js";
import {
  type OperationModeDeps,
  operatePublication,
  type PublicationOperation,
  type PublicationPlatformDeps,
} from "./publication-operations.js";
import { modeOf } from "./publication-start.js";

// La propiedad manda (ADR-0019, spec F6 §4.8): pausar, reanudar, cerrar (vendida, arrendada o
// retirada), reabrir y archivar una propiedad orquestan sus publicaciones en todas las plataformas.

export type ChangeListingStatusDeps = PublicationPlatformDeps & OperationModeDeps;

export type ListingStatusChange = {
  /** La propiedad, ya cambiada. */
  listing: Listing;
  /** Las publicaciones que cambiaron (desprogramadas, descartadas, pausadas, cerradas…). */
  changed: Publication[];
  /**
   * Lo que el operador tiene que hacer a mano (D4): Instagram y Marketplace en vivo de una
   * propiedad cerrada, que siguen publicados hasta que los borre y los marque como retirados.
   */
  manualTasks: Publication[];
};

const PORTAL = "portal_inmobiliario";
const PENDING_RELEASED: readonly Publication["status"][] = ["approved", "failed", "scheduled"];
const ON_PLATFORM: readonly Publication["status"][] = ["published", "paused"];

const listingNotFound = (listingId: string) =>
  new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, { details: { listingId } });

const invalid = (listing: Listing, action: ListingAction) =>
  new AppError(
    "INVALID_TRANSITION",
    `No se puede ${ACTION_VERB[action]} una propiedad en ${listing.status}`,
    { details: { listingId: listing.id, from: listing.status, action } },
  );

const ACTION_VERB: Readonly<Record<ListingAction, string>> = {
  ready: "dejar lista",
  pause: "pausar",
  resume: "reanudar",
  close: "cerrar",
  reopen: "reabrir",
  archive: "archivar",
};

/** Una llamada a Portal de la fase 2 (fuera del candado). */
type PortalStep = { publicationId: string; operation: PublicationOperation };

/**
 * Cambia el estado de una propiedad y orquesta sus publicaciones (`POST /listings/:id/status`;
 * hasta T10, también la ruta vieja `PATCH`). En **tres fases** (spec F6 §4.8, D14):
 * 1. **Dentro del candado:** valida la acción (`INVALID_TRANSITION`), el motivo al cerrar
 *    (`CLOSE_REASON_REQUIRED`), que nada se esté publicando ni espere el clic final (409
 *    `PUBLICATION_IN_PROGRESS` / `MANUAL_CONFIRM_PENDING`), que archivar no deje nada publicado ni
 *    pausado, en vivo o simulado (`LISTING_HAS_LIVE_PUBLICATIONS`), el modo (una de Portal en vivo con la API en
 *    simulación: `PUBLISH_MODE_MISMATCH`) y la confirmación (cerrar siempre; pausar y archivar si
 *    hay algo que cambiar: `LISTING_ACTION_NOT_CONFIRMED`). Después suelta lo pendiente: pausar
 *    desprograma las `scheduled`; cerrar y archivar descartan las `approved`, `failed` y `scheduled`.
 *    Si no hay nada que hacer en Portal, aplica también la fase 3 en la misma transacción.
 * 2. **Fuera del candado:** Portal, con las piezas de las operaciones de F4 (`operatePublication`,
 *    sin devolver la propiedad a `ready`): pausar las publicadas (marcadas `byListing`), reanudar
 *    solo las que pausó la propiedad, cerrar las publicadas o pausadas. Una que falla detiene todo:
 *    lo ya aplicado queda aplicado y repetir la acción lo salta; la propiedad no cambió.
 * 3. **Dentro del candado otra vez:** relee la propiedad (si cambió, `INVALID_TRANSITION`) y sus
 *    publicaciones (las mismas revisiones y lo pendiente nuevo, igual que la fase 1; una de Portal
 *    que salió mientras tanto, `INVALID_TRANSITION` para repetir), baja las
 *    simulaciones de Instagram y Marketplace al cerrar, y cambia la propiedad (con su
 *    motivo al cerrar; reanudar y reabrir la dejan `active` si le queda algo publicado en vivo).
 */
export async function changeListingStatus(
  deps: ChangeListingStatusDeps,
  {
    listingId,
    action,
    reason,
    confirmed = false,
    actor,
    signal,
  }: {
    listingId: string;
    action: ListingAction;
    reason?: CloseReason;
    confirmed?: boolean;
    actor: PublicationActor;
    signal?: AbortSignalLike;
  },
): Promise<ListingStatusChange> {
  const changed: Publication[] = [];
  const first = await deps.lock.run(listingId, async (locked) => {
    const listing = await locked.listings.get(listingId);
    if (listing === null) throw listingNotFound(listingId);
    if (!canDoListingAction(action, listing.status)) throw invalid(listing, action);
    if (action === "close" && reason === undefined) {
      throw new AppError(
        "CLOSE_REASON_REQUIRED",
        "Di por qué se cierra: vendida, arrendada o retirada",
        { details: { listingId } },
      );
    }
    if (action === "ready") await requirePhoto(locked, listing);
    const publications = await locked.publications.listByListing(listingId);
    requireNothingInFlight(action, publications);
    const portal = await portalSteps(locked, action, publications);
    requireLiveCompatible(deps, action, publications, portal);
    if (needsConfirmation(action, publications, portal) && !confirmed) {
      throw new AppError("LISTING_ACTION_NOT_CONFIRMED", CONFIRM_TEXT[action], {
        details: { listingId, action },
      });
    }
    changed.push(...(await releasePending(locked, action, publications, actor)));
    if (portal.length > 0) return { listing, portal, done: null };
    return { listing, portal, done: await applyFinal(locked, listing, { action, reason, actor }) };
  });

  if (first.done !== null) return { ...first.done, changed: [...changed, ...first.done.changed] };

  for (const step of first.portal) {
    const { publication } = await operatePublication(deps, {
      publicationId: step.publicationId,
      operation: step.operation,
      actor,
      confirmed: true,
      keepListing: true,
      byListing: step.operation === "pause",
      ...(signal === undefined ? {} : { signal }),
    });
    changed.push(publication);
  }

  const done = await deps.lock.run(listingId, async (locked) => {
    const listing = await locked.listings.get(listingId);
    if (listing === null) throw listingNotFound(listingId);
    if (listing.status !== first.listing.status) throw invalid(listing, action);
    const publications = await locked.publications.listByListing(listingId);
    requireNothingInFlight(action, publications);
    // Una de Portal que salió (o se pausó) mientras se llamaba a Portal quedaría viva sin dueño:
    // se repite la acción, que la incluye.
    const pending = await portalSteps(locked, action, publications);
    if (pending.length > 0) {
      throw new AppError(
        "INVALID_TRANSITION",
        "Una publicación de Portal cambió mientras se cambiaba la propiedad: vuelve a intentarlo",
        { details: { listingId, action, publicationId: pending[0]?.publicationId } },
      );
    }
    changed.push(...(await releasePending(locked, action, publications, actor)));
    return applyFinal(locked, listing, { action, reason, actor });
  });
  return { ...done, changed: [...changed, ...done.changed] };
}

const CONFIRM_TEXT: Readonly<Record<ListingAction, string>> = {
  ready: "Confirma el cambio",
  pause:
    "Pausar la propiedad pausa su aviso de Portal y desprograma lo programado: confirma que quieres pausarla",
  resume: "Confirma el cambio",
  close:
    "Cerrar la propiedad cierra su aviso de Portal (en vivo es definitivo) y descarta lo pendiente: confirma que quieres cerrarla",
  reopen: "Confirma el cambio",
  archive:
    "Archivar la propiedad descarta sus publicaciones pendientes: confirma que quieres archivarla",
};

/** Dejarla lista exige al menos una foto (un video no cuenta), como desde F1. */
async function requirePhoto(locked: LockedRepositories, listing: Listing): Promise<void> {
  const media = await locked.media.listOriginals(listing.id);
  if (!media.some((item) => item.kind === "image")) {
    throw new AppError("INVALID_TRANSITION", "Para dejarla lista hace falta al menos una foto", {
      details: { listingId: listing.id, from: listing.status, to: "ready" },
    });
  }
}

/** Pausar, cerrar y archivar esperan a que nada se esté publicando ni espere el clic final. */
function requireNothingInFlight(action: ListingAction, publications: readonly Publication[]): void {
  if (action !== "pause" && action !== "close" && action !== "archive") return;
  const waiting = publications.find((p) => p.status === "awaiting_manual_confirm");
  if (waiting !== undefined) throw manualConfirmPending(waiting.id);
  const publishing = publications.find((p) => p.status === "publishing");
  if (publishing !== undefined) {
    throw new AppError(
      "PUBLICATION_IN_PROGRESS",
      "Una publicación de esta propiedad se está publicando: espera a que termine",
      { details: { publicationId: publishing.id } },
    );
  }
}

/** Lo que hay que hacer en Portal fuera del candado (fase 2). */
async function portalSteps(
  locked: LockedRepositories,
  action: ListingAction,
  publications: readonly Publication[],
): Promise<PortalStep[]> {
  const portal = publications.filter((p) => p.platform === PORTAL);
  switch (action) {
    case "pause":
      return portal
        .filter((p) => p.status === "published")
        .map((p) => ({ publicationId: p.id, operation: "pause" }));
    case "resume": {
      const steps: PortalStep[] = [];
      for (const publication of portal.filter((p) => p.status === "paused")) {
        if (await pausedByListing(locked, publication.id)) {
          steps.push({ publicationId: publication.id, operation: "resume" });
        }
      }
      return steps;
    }
    case "close":
      return portal
        .filter((p) => ON_PLATFORM.includes(p.status))
        .map((p) => ({ publicationId: p.id, operation: "close" }));
    default:
      return [];
  }
}

/** Si la última pausa de la publicación la pidió la propiedad (`byListing`). */
async function pausedByListing(
  locked: LockedRepositories,
  publicationId: string,
): Promise<boolean> {
  const events = await locked.publications.listEvents(publicationId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status_changed" && event.toStatus === "paused") {
      return event.payload.byListing === true;
    }
  }
  return false;
}

/**
 * Nunca se cambia algo real estando en simulación (como las operaciones de F4), y archivar no deja
 * nada publicado, ni en vivo ni simulado (la tabla de §4.8): primero se cierra.
 */
function requireLiveCompatible(
  deps: Pick<ChangeListingStatusDeps, "apiMode">,
  action: ListingAction,
  publications: readonly Publication[],
  portal: readonly PortalStep[],
): void {
  if (action === "archive") {
    const live = publications.find((p) => ON_PLATFORM.includes(p.status));
    if (live !== undefined) {
      throw new AppError(
        "LISTING_HAS_LIVE_PUBLICATIONS",
        "La propiedad tiene publicaciones publicadas o pausadas: ciérrala antes de archivarla",
        { details: { publicationId: live.id } },
      );
    }
  }
  const touchesLive = portal.some(
    (step) => publications.find((p) => p.id === step.publicationId)?.dryRun === false,
  );
  if (touchesLive && deps.apiMode !== "live") {
    throw new AppError(
      "PUBLISH_MODE_MISMATCH",
      "La propiedad tiene un aviso de Portal en vivo, pero AgentSales está en simulación: no se cambió nada",
      { details: { action } },
    );
  }
}

/**
 * Cerrar siempre; pausar y archivar solo si hay algo que cambiar (spec F6 §4.8): Portal en vivo, o
 * pendientes que se desprograman o descartan.
 */
function needsConfirmation(
  action: ListingAction,
  publications: readonly Publication[],
  portal: readonly PortalStep[],
): boolean {
  if (action === "close") return true;
  if (action === "pause") {
    return (
      portal.some(
        (step) => publications.find((p) => p.id === step.publicationId)?.dryRun === false,
      ) || publications.some((p) => p.status === "scheduled")
    );
  }
  if (action === "archive") return publications.some((p) => PENDING_RELEASED.includes(p.status));
  return false;
}

/** Suelta lo pendiente: pausar desprograma; cerrar y archivar descartan. */
async function releasePending(
  locked: LockedRepositories,
  action: ListingAction,
  publications: readonly Publication[],
  actor: PublicationActor,
): Promise<Publication[]> {
  const released: Publication[] = [];
  if (action === "pause") {
    for (const publication of publications.filter((p) => p.status === "scheduled")) {
      released.push(
        await locked.publications.transition(
          publication.id,
          { from: "scheduled", to: "approved" },
          {
            actor,
            payload: {
              byListing: true,
              unscheduled: publication.scheduledAt?.toISOString() ?? null,
            },
          },
        ),
      );
    }
  }
  if (action === "close" || action === "archive") {
    for (const publication of publications.filter((p) => PENDING_RELEASED.includes(p.status))) {
      released.push(
        await locked.publications.transition(
          publication.id,
          { from: publication.status, to: "cancelled" },
          { actor, payload: { byListing: true, action } },
        ),
      );
    }
  }
  return released;
}

/**
 * La fase 3: baja las simulaciones de Instagram y Marketplace al cerrar (no hay nada que
 * borrar a mano), cambia la propiedad y junta las tareas a mano.
 */
async function applyFinal(
  locked: LockedRepositories,
  listing: Listing,
  {
    action,
    reason,
    actor,
  }: { action: ListingAction; reason: CloseReason | undefined; actor: PublicationActor },
): Promise<ListingStatusChange> {
  const changed: Publication[] = [];
  if (action === "close") {
    for (const publication of await locked.publications.listByListing(listing.id)) {
      if (publication.platform === PORTAL || !publication.dryRun) continue;
      if (publication.status !== "published") continue;
      changed.push(
        await locked.publications.transition(
          publication.id,
          { from: "published", to: "unpublished" },
          { actor, payload: { mode: modeOf(true), byListing: true, action } },
        ),
      );
    }
  }
  const publications = await locked.publications.listByListing(listing.id);
  const stillLive = publications.some((p) => !p.dryRun && ON_PLATFORM.includes(p.status));
  const to: ListingStatus = TARGET[action](stillLive);
  const moved = await locked.listings.changeStatus(
    listing.id,
    listing.status,
    to,
    action === "close" && reason !== undefined ? { closeReason: reason } : {},
  );
  if (!moved) {
    throw new AppError(
      "INVALID_TRANSITION",
      "El estado de la propiedad cambió mientras tanto: vuelve a intentarlo",
      { details: { listingId: listing.id, from: listing.status, to } },
    );
  }
  const updated = await locked.listings.get(listing.id);
  if (updated === null) throw listingNotFound(listing.id);
  return { listing: updated, changed, manualTasks: manualTasksOf(updated.status, publications) };
}

/** El estado de destino de cada acción; reanudar y reabrir dependen de si queda algo en vivo. */
const TARGET: Readonly<Record<ListingAction, (stillLive: boolean) => ListingStatus>> = {
  ready: () => "ready",
  pause: () => "paused",
  resume: (stillLive) => (stillLive ? "active" : "ready"),
  close: () => "closed",
  reopen: (stillLive) => (stillLive ? "active" : "ready"),
  archive: () => "archived",
};
