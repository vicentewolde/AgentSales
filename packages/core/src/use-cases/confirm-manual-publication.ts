import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { dryRunExternalId } from "../publish/dry-run.js";
import { parsePublishedUrl } from "../publish/published-url.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

export type ManualPublicationDeps = SubjectLocks & {
  /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
  publications: Pick<PublicationRepository, "get">;
  now?: () => Date;
};

/** Lo que devuelve confirmar: la publicación y si se cambió ahora (`false` = ya estaba así). */
export type ConfirmManualPublicationResult = { publication: Publication; changed: boolean };

const urlRequired = (publicationId: string, platform: Platform) =>
  platform === "fb_marketplace"
    ? new AppError(
        "MARKETPLACE_URL_REQUIRED",
        "Pega el enlace del aviso publicado (https://www.facebook.com/marketplace/item/<número>)",
        { details: { publicationId } },
      )
    : new AppError(
        "PUBLISHED_URL_REQUIRED",
        "Pega el enlace de la publicación (empieza con https://)",
        { details: { publicationId } },
      );

const notWaiting = (publication: Publication, to: "published" | "failed") => {
  const marketplace = publication.platform === "fb_marketplace";
  const message =
    publication.status === "publishing"
      ? marketplace
        ? "El formulario todavía se está llenando: espera a que quede listo"
        : "La publicación todavía se está preparando: espera a que quede lista"
      : marketplace
        ? "Esta publicación no está esperando tu clic final"
        : "Esta publicación no está esperando que la publiques a mano";
  return new AppError("INVALID_TRANSITION", message, {
    details: { publicationId: publication.id, from: publication.status, to },
  });
};

/**
 * "Lo publiqué" (spec F5 §4.3, ADR-0017; `POST /publications/:id/confirm`; genérico desde F9-T06,
 * ADR-0029 punto 9): una publicación que espera el clic del operador o que se publica a mano
 * (`awaiting_manual_confirm`) pasa a `published`, dentro del candado de su sujeto (el del aviso o
 * el del post) y de forma condicional. Lo llama el operador (panel o CLI) con el enlace que pegó, o
 * el worker (actor `system`) con el que vio en la ventana de Marketplace.
 * - En `live`, el enlace es obligatorio (`MARKETPLACE_URL_REQUIRED` en Marketplace,
 *   `PUBLISHED_URL_REQUIRED` en las demás) y se normaliza (`parsePublishedUrl`): en Marketplace,
 *   `external_id` = el número del aviso; en las demás, el enlace limpio. Un aviso pasa de `ready` a
 *   `active`; un post nunca (ADR-0029 punto 4).
 * - En `dry-run`, un enlace se ignora: `external_id = dry-run:<id>`, sin enlace.
 * - Ya publicada: con el mismo enlace (o en `dry-run`), no cambia nada (`changed: false`); con otro,
 *   `PUBLICATION_ALREADY_CONFIRMED` (409). En otro estado, `INVALID_TRANSITION`.
 * Un post sin `postLock` en las dependencias es `SUBJECT_NOT_LISTING` (`runOnSubject`).
 */
export async function confirmManualPublication(
  deps: ManualPublicationDeps,
  { publicationId, url, actor }: { publicationId: string; url?: string; actor: PublicationActor },
): Promise<ConfirmManualPublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const now = deps.now ?? (() => new Date());
  // El enlace se revisa antes del candado: un enlace malo no toca nada.
  const item = found.dryRun || url === undefined ? null : parsePublishedUrl(found.platform, url);

  return runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    const live = !publication.dryRun;
    if (publication.status === "published") {
      if (!live || (item !== null && item.externalId === publication.externalId)) {
        return { publication, changed: false };
      }
      if (item === null) throw urlRequired(publicationId, publication.platform);
      throw new AppError(
        "PUBLICATION_ALREADY_CONFIRMED",
        "Esta publicación ya se confirmó con otro enlace",
        { details: { publicationId } },
      );
    }
    if (publication.status !== "awaiting_manual_confirm")
      throw notWaiting(publication, "published");
    if (live && item === null) throw urlRequired(publicationId, publication.platform);
    const published = await locked.repos.publications.transition(
      publicationId,
      {
        from: "awaiting_manual_confirm",
        to: "published",
        changes: {
          externalId: item?.externalId ?? dryRunExternalId(publicationId),
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
    if (live && locked.kind === "listing") {
      // Como el intento al publicar (spec F3 §4.3): el aviso pasa a `active` si estaba `ready`.
      // Un post nunca (ADR-0029 punto 4).
      const listing = await locked.repos.listings.get(locked.subject.id);
      if (listing?.status === "ready") {
        await locked.repos.listings.changeStatus(locked.subject.id, "ready", "active");
      }
    }
    return { publication: published, changed: true };
  });
}

/** El motivo de "no lo publiqué": el de Marketplace (F5) o el genérico de una cuenta a mano. */
const notPublishedError = (platform: Platform) =>
  platform === "fb_marketplace"
    ? {
        code: "MARKETPLACE_NOT_PUBLISHED",
        message:
          "No se publicó: reintenta para abrir el formulario de nuevo o descarta la publicación",
        retriable: false,
      }
    : {
        code: "MANUAL_NOT_PUBLISHED",
        message:
          "No se publicó: reintenta para dejar el texto listo de nuevo o descarta la publicación",
        retriable: false,
      };

/**
 * "No lo publiqué" (spec F5 §4.3; `POST /publications/:id/not-published`; genérico desde F9-T06):
 * la palabra del operador de que no se publicó. `awaiting_manual_confirm` → `failed` con
 * `MARKETPLACE_NOT_PUBLISHED` (Marketplace) o `MANUAL_NOT_PUBLISHED` (las demás), para reintentar
 * (abre un formulario nuevo, o deja todo listo otra vez) o descartar, dentro del candado de su
 * sujeto. Fuera de Marketplace borra el progreso del traspaso (el reintento parte de cero, también
 * si la cuenta pasó a modo `api`). No se deshace (D14): la máquina no permite `failed → published`. La ventana de
 * Marketplace, si seguía abierta, la cierra el worker al ver que ya no espera.
 */
export async function markNotPublished(
  deps: ManualPublicationDeps,
  { publicationId, actor }: { publicationId: string; actor: PublicationActor },
): Promise<Publication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);

  return runOnSubject(deps, found.subject, async ({ repos }) => {
    const publication = await repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "awaiting_manual_confirm") throw notWaiting(publication, "failed");
    return repos.publications.transition(
      publicationId,
      {
        from: "awaiting_manual_confirm",
        to: "failed",
        // Fuera de Marketplace se borra el traspaso (`{ manual }`): si la cuenta pasa después a
        // modo `api`, el reintento envía desde cero. Marketplace conserva su formulario (F5).
        changes: {
          lastError: notPublishedError(publication.platform),
          ...(publication.platform === "fb_marketplace" ? {} : { progress: null }),
        },
      },
      { actor, payload: { mode: modeOf(publication.dryRun), reason: "not_published" } },
    );
  });
}
