import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import {
  manualEditPayloadSchema,
  type Publication,
  type PublicationActor,
  publishAttemptPayloadSchema,
  type RemoteState,
} from "../publication.js";
import { assemblePublishInput, toPublishListing } from "../publish/input.js";
import { liveModeMismatch } from "../publish-mode.js";
import { listingIdOf, listingSubject } from "../subject.js";
import {
  codeOf,
  enqueueSync,
  failedCall,
  findPublication,
  OPERATION_SYNC_DELAY_MS,
  type OperationModeDeps,
  type PublicationPlatformDeps,
  platformContextFor,
  remoteStateFrom,
  requestSync,
} from "./publication-operations.js";
import { modeOf } from "./publication-start.js";

/** Lo que actualizar necesita además de las operaciones (spec F6 §4.7, ADR-0020). */
export type UpdatePortalPublicationDeps = PublicationPlatformDeps &
  OperationModeDeps & {
    /** Fuera del candado: la publicación y su bitácora (el tipo y la operación enviados). */
    publications: Pick<PublicationRepository, "get" | "listEvents">;
    contents: Pick<ContentRepository, "listCurrent">;
    listings: Pick<ListingRepository, "get" | "getSourceHash">;
    brokers: Pick<BrokerRepository, "findById">;
  };

const UPDATABLE_STATUSES: readonly Publication["status"][] = ["published", "paused"];
const UPDATABLE_LISTING_STATUSES = ["ready", "active", "paused"] as const;

/**
 * Actualizar un aviso de Portal publicado o pausado (`POST /publications/:id/update`, spec F6 §4.7,
 * ADR-0020; síncrona en la API, como pausar o cerrar):
 * 1. Fuera del candado revisa la publicación (Portal, `published` o `paused`: si no,
 *    `INVALID_TRANSITION`), la propiedad (`ready`, `active` o `paused`: `LISTING_NOT_READY`) y el
 *    texto de Portal vigente (aprobado: `CONTENT_NOT_APPROVED`). Qué cambió: el texto (otro
 *    `content_id`) o la propiedad (otra versión). Nada → `PORTAL_NOTHING_TO_UPDATE`. Si cambió el
 *    tipo o la operación respecto de lo enviado al publicar (la bitácora), `PORTAL_UPDATE_NEEDS_RELIST`:
 *    la categoría no se cambia.
 * 2. **El modo lo decide la publicación:** en `dry_run`, simulación sin llamar (ADR-0016); en `live`
 *    exige la API en vivo (`PUBLISH_MODE_MISMATCH`) y `confirmed` (`UPDATE_NOT_CONFIRMED`: un cambio
 *    de precio puede hacer que Mercado Libre la pause por moderación), y llama a `update` de la
 *    plataforma **fuera** del candado. Un error reintentable (la respuesta pudo perderse) pide un
 *    sync; un acceso rechazado deja la cuenta `expired`.
 * 3. Dentro del candado, si la publicación cambió mientras tanto (otro `updatedAt`),
 *    `PUBLICATION_STALE` (en vivo pide un sync); si no, `replacePublishedSource` re-fija el texto,
 *    la versión y el progreso con un evento `manual_edit`, y guarda lo que informó la plataforma.
 * 4. En vivo, pide un sync en 30 s: un precio nuevo puede pausar el aviso.
 */
export async function updatePortalPublication(
  deps: UpdatePortalPublicationDeps,
  {
    publicationId,
    actor,
    confirmed = false,
    signal,
  }: {
    publicationId: string;
    actor: PublicationActor;
    confirmed?: boolean;
    signal?: AbortSignalLike;
  },
): Promise<Publication> {
  const found = await findPublication(deps, publicationId);
  if (found.platform !== "portal_inmobiliario" || !UPDATABLE_STATUSES.includes(found.status)) {
    throw new AppError(
      "INVALID_TRANSITION",
      "Solo se actualiza un aviso de Portal publicado o pausado",
      { details: { publicationId, from: found.status, to: found.status } },
    );
  }
  const listing = await deps.listings.get(listingIdOf(found.subject));
  if (
    listing === null ||
    !(UPDATABLE_LISTING_STATUSES as readonly string[]).includes(listing.status)
  ) {
    throw new AppError(
      "LISTING_NOT_READY",
      "La propiedad no está lista, activa ni pausada: no se actualiza su aviso",
      { details: { listingId: found.listingId, status: listing?.status ?? null } },
    );
  }
  const content = (
    await deps.contents.listCurrent(listingSubject(listingIdOf(found.subject)))
  ).find((current) => current.platform === "portal_inmobiliario");
  if (content === undefined || content.status !== "approved") {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El texto de Portal vigente no está aprobado: apruébalo antes de actualizar el aviso",
      { details: { publicationId, status: content?.status ?? null } },
    );
  }
  const currentHash = await deps.listings.getSourceHash(listingIdOf(found.subject));
  if (currentHash === null || currentHash === "") {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${found.listingId}`, {
      details: { listingId: found.listingId },
    });
  }
  const text = content.id !== found.contentId;
  const listingChanged = currentHash !== found.listingSourceHash;
  if (!text && !listingChanged) {
    throw new AppError(
      "PORTAL_NOTHING_TO_UPDATE",
      "El aviso ya tiene el texto aprobado y los datos de la propiedad de hoy: no hay nada que actualizar",
      { details: { publicationId } },
    );
  }
  await requireSameCategory(deps, found, listing);

  const live = !found.dryRun;
  let remote: RemoteState | undefined;
  let progress: unknown = found.progress;
  let fields = [
    ...(text ? ["title", "description"] : []),
    ...(listingChanged ? ["price", "attributes"] : []),
  ];
  if (live) {
    if (deps.apiMode !== "live") {
      throw liveModeMismatch({
        what: "Este aviso está en vivo",
        nothing: "no se cambió nada en la plataforma",
        serverMode: deps.serverMode,
        portal: true,
        publicationId,
      });
    }
    if (!confirmed) {
      throw new AppError(
        "UPDATE_NOT_CONFIRMED",
        "Actualizar cambia el aviso en Mercado Libre (un precio nuevo puede hacer que lo pause para revisarlo): confirma que quieres actualizarlo",
        { details: { publicationId } },
      );
    }
    const externalId = found.externalId;
    if (externalId === null) {
      throw new AppError("PUBLICATION_NOT_PUBLISHED", "El aviso no tiene id en la plataforma", {
        details: { publicationId },
      });
    }
    const update = deps.operationsFor(found.platform)?.update;
    if (update === undefined) {
      throw new AppError(
        "PUBLISHER_NOT_CONFIGURED",
        "Esta plataforma todavía no se puede actualizar desde aquí",
        { details: { platform: found.platform } },
      );
    }
    const broker = await deps.brokers.findById(listing.brokerId);
    if (broker === null) {
      throw new AppError("BROKER_NOT_FOUND", "No existe el corredor del aviso", {
        details: { publicationId, brokerId: listing.brokerId },
      });
    }
    const input = assemblePublishInput({
      publicationId: found.id,
      platform: found.platform,
      format: found.format,
      content,
      // Las fotos no se envían: van las del ítem, guardadas en el progreso.
      media: [],
      listingData: {
        listing: toPublishListing(listing),
        brokerContact: { name: broker.name, email: broker.email, whatsapp: broker.whatsapp },
      },
    });
    const ctx = await platformContextFor(deps, found, signal);
    try {
      const result = await update({ externalId, progress: found.progress }, ctx, {
        input,
        text,
        listing: listingChanged,
      });
      progress = result.progress;
      fields = result.fields;
      remote = remoteStateFrom(deps, publicationId, result.remote);
    } catch (error) {
      // Aunque el error no sea pasajero, el `PUT` del ítem pudo aplicarse antes (por ejemplo, si
      // falló la descripción): el sync deja el estado como está allá.
      await requestSync(deps, found);
      return failedCall(deps, found, error);
    }
  }

  let publication: Publication;
  try {
    publication = await deps.lock.run(listingIdOf(found.subject), async (locked) => {
      const current = await locked.publications.get(publicationId);
      if (current === null || current.updatedAt.getTime() !== found.updatedAt.getTime()) {
        throw new AppError(
          "PUBLICATION_STALE",
          "El aviso cambió mientras se actualizaba: recarga y revisa su estado",
          { details: { publicationId } },
        );
      }
      const replaced = await locked.publications.replacePublishedSource(
        publicationId,
        { from: current.status },
        { contentId: content.id, listingSourceHash: currentHash, progress },
        {
          actor,
          payload: manualEditPayloadSchema.parse({
            mode: modeOf(found.dryRun),
            fields,
            ...(remote === undefined ? {} : { remote }),
          }),
        },
      );
      return remote === undefined
        ? replaced
        : locked.publications.setRemoteState(publicationId, remote);
    });
  } catch (error) {
    // Mercado Libre ya cambió: el sync deja el estado como está allá.
    if (live) await requestSync(deps, found);
    throw error;
  }
  if (live) {
    const now = deps.now ?? (() => new Date());
    await enqueueSync(deps.queue, publicationId, {
      startAfter: new Date(now().getTime() + OPERATION_SYNC_DELAY_MS),
    }).catch((failure: unknown) =>
      deps.onWarning?.({ publicationId, step: "enqueue_sync", code: codeOf(failure) }),
    );
  }
  return publication;
}

/**
 * La categoría del ítem no se cambia (ADR-0020): si el tipo o la operación de la propiedad no son
 * los que se enviaron al publicar (el último `publish_attempt` con el aviso enviado),
 * `PORTAL_UPDATE_NEEDS_RELIST`. Sin ese registro (una publicación antigua), no se puede saber y se
 * sigue: la plataforma rechaza lo que no calce con su categoría.
 */
async function requireSameCategory(
  deps: Pick<UpdatePortalPublicationDeps, "publications">,
  publication: Publication,
  listing: { propertyType: string | null; operation: string | null },
): Promise<void> {
  const events = await deps.publications.listEvents(publication.id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "publish_attempt") continue;
    const parsed = publishAttemptPayloadSchema.safeParse(event.payload);
    const sent = parsed.success ? parsed.data.sent?.listing : undefined;
    if (sent === undefined) continue;
    if (sent.propertyType !== listing.propertyType || sent.operation !== listing.operation) {
      throw new AppError(
        "PORTAL_UPDATE_NEEDS_RELIST",
        "Cambió el tipo o la operación de la propiedad: Mercado Libre no cambia la categoría de un aviso. Ciérralo y publica uno nuevo",
        { details: { publicationId: publication.id } },
      );
    }
    return;
  }
}
