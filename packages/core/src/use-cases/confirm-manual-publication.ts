import { AppError } from "../errors.js";
import { parseMarketplaceItemUrl } from "../marketplace/url.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { dryRunExternalId } from "../publish/dry-run.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

export type ManualPublicationDeps = {
  lock: ListingLock;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
  now?: () => Date;
};

/** Lo que devuelve confirmar: la publicación y si se cambió ahora (`false` = ya estaba así). */
export type ConfirmManualPublicationResult = { publication: Publication; changed: boolean };

const urlRequired = (publicationId: string) =>
  new AppError(
    "MARKETPLACE_URL_REQUIRED",
    "Pega el enlace del aviso publicado (https://www.facebook.com/marketplace/item/<número>)",
    { details: { publicationId } },
  );

const notWaiting = (publication: Publication, to: "published" | "failed") =>
  new AppError(
    "INVALID_TRANSITION",
    publication.status === "publishing"
      ? "El formulario todavía se está llenando: espera a que quede listo"
      : "Esta publicación no está esperando tu clic final",
    { details: { publicationId: publication.id, from: publication.status, to } },
  );

/**
 * "Lo publiqué" (spec F5 §4.3, ADR-0017; `POST /publications/:id/confirm`): una publicación que
 * espera el clic del operador (`awaiting_manual_confirm`) pasa a `published`, dentro del candado del
 * aviso y de forma condicional. Lo llama el operador (panel o CLI) con el enlace que pegó, o el
 * worker (actor `system`) con el que vio en la ventana.
 * - En `live`, el enlace es obligatorio (`MARKETPLACE_URL_REQUIRED`) y se normaliza
 *   (`parseMarketplaceItemUrl`: `MARKETPLACE_URL_INVALID`): `external_id` = el número del aviso y
 *   `external_url` = la forma limpia. El aviso pasa de `ready` a `active`.
 * - En `dry-run`, un enlace se ignora: `external_id = dry-run:<id>`, sin enlace.
 * - Ya publicada: con el mismo enlace (o en `dry-run`), no cambia nada (`changed: false`); con otro,
 *   `PUBLICATION_ALREADY_CONFIRMED` (409). En otro estado, `INVALID_TRANSITION`.
 */
export async function confirmManualPublication(
  deps: ManualPublicationDeps,
  { publicationId, url, actor }: { publicationId: string; url?: string; actor: PublicationActor },
): Promise<ConfirmManualPublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const now = deps.now ?? (() => new Date());
  // El enlace se revisa antes del candado: un enlace malo no toca nada.
  const item = found.dryRun || url === undefined ? null : parseMarketplaceItemUrl(url);

  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    const live = !publication.dryRun;
    if (publication.status === "published") {
      if (!live || (item !== null && item.itemId === publication.externalId)) {
        return { publication, changed: false };
      }
      if (item === null) throw urlRequired(publicationId);
      throw new AppError(
        "PUBLICATION_ALREADY_CONFIRMED",
        "Esta publicación ya se confirmó con otro enlace",
        { details: { publicationId } },
      );
    }
    if (publication.status !== "awaiting_manual_confirm")
      throw notWaiting(publication, "published");
    if (live && item === null) throw urlRequired(publicationId);
    const published = await locked.publications.transition(
      publicationId,
      {
        from: "awaiting_manual_confirm",
        to: "published",
        changes: {
          externalId: item?.itemId ?? dryRunExternalId(publicationId),
          externalUrl: item?.url ?? null,
          publishedAt: now(),
          lastError: null,
        },
      },
      {
        actor,
        payload: {
          mode: modeOf(publication.dryRun),
          confirmedBy: actor === "system" ? "window" : "operator",
        },
      },
    );
    if (live) {
      // Como el intento al publicar (spec F3 §4.3): el aviso pasa a `active` si estaba `ready`.
      const listing = await locked.listings.get(publication.listingId);
      if (listing?.status === "ready") {
        await locked.listings.changeStatus(publication.listingId, "ready", "active");
      }
    }
    return { publication: published, changed: true };
  });
}

/**
 * "No lo publiqué" (spec F5 §4.3; `POST /publications/:id/not-published`): la palabra del
 * operador de que el formulario no se publicó. `awaiting_manual_confirm` → `failed` con
 * `MARKETPLACE_NOT_PUBLISHED`, para reintentar (abre un formulario nuevo) o descartar. No se
 * deshace (D14): la máquina no permite `failed → published`. La ventana, si seguía abierta, la
 * cierra el worker al ver que ya no espera.
 */
export async function markNotPublished(
  deps: ManualPublicationDeps,
  { publicationId, actor }: { publicationId: string; actor: PublicationActor },
): Promise<Publication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);

  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "awaiting_manual_confirm") throw notWaiting(publication, "failed");
    return locked.publications.transition(
      publicationId,
      {
        from: "awaiting_manual_confirm",
        to: "failed",
        changes: {
          lastError: {
            code: "MARKETPLACE_NOT_PUBLISHED",
            message:
              "No se publicó: reintenta para abrir el formulario de nuevo o descarta la publicación",
            retriable: false,
          },
        },
      },
      { actor, payload: { mode: modeOf(publication.dryRun), reason: "not_published" } },
    );
  });
}
