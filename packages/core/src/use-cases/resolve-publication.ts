import { AppError } from "../errors.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { dryRunExternalId } from "../publish/dry-run.js";
import { parsePublishedUrl } from "../publish/published-url.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

/** Lo que dice el operador de una publicación con resultado dudoso. */
export const PUBLICATION_RESOLUTIONS = ["published", "not_published"] as const;
export type PublicationResolution = (typeof PUBLICATION_RESOLUTIONS)[number];

export type ResolvePublicationDeps = SubjectLocks & {
  /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
  publications: Pick<PublicationRepository, "get">;
  now?: () => Date;
};

/** Lo que devuelve resolver: la publicación y si se cambió ahora (`false` = ya estaba así). */
export type ResolvePublicationResult = { publication: Publication; changed: boolean };

/** El motivo que queda en `last_error` cuando el operador dice que no salió. */
export const NOT_PUBLISHED_RESOLUTION_CODE = "OUTCOME_RESOLVED_NOT_PUBLISHED";

const notPublishedError = () => ({
  code: NOT_PUBLISHED_RESOLUTION_CODE,
  message: "Dijiste que no salió: reintenta para publicarla de nuevo o descártala",
  retriable: false,
});

/**
 * Resuelve una publicación con resultado dudoso (ADR-0029 punto 8; `POST /publications/:id/resolve`
 * y `publications resolve`, F9-T12): la palabra del operador, dentro del candado de su sujeto (el
 * del aviso o el del post) y de forma condicional.
 * - `published` ("salió"): `outcome_unknown` → `published`, con el enlace si lo tiene
 *   (`parsePublishedUrl`: `MARKETPLACE_URL_INVALID` o `PUBLISHED_URL_INVALID`, revisado antes del
 *   candado); `external_id` = el id del enlace, o `null` si no lo pegó; en simulación el enlace
 *   se ignora (`dry-run:<id>`, sin enlace), como en `confirmManualPublication`. En `live`, un aviso pasa de `ready` a `active`, como al publicar; un post nunca.
 * - `not_published` ("no salió"): → `failed` con `OUTCOME_RESOLVED_NOT_PUBLISHED` y **sin el
 *   progreso**, desde donde se puede volver a intentar (envía desde cero: el "enviando" ya no
 *   está) o descartar.
 * Repetir lo mismo no cambia nada (`changed: false`): "salió" sobre una ya publicada sin enlace o
 * con el mismo, y "no salió" sobre una que ya quedó así. Otra cosa sobre una publicada con otro
 * enlace es `PUBLICATION_ALREADY_CONFIRMED`; en cualquier otro estado, `INVALID_TRANSITION`. Un
 * post sin `postLock` en las dependencias es `SUBJECT_NOT_LISTING`.
 */
export async function resolvePublication(
  deps: ResolvePublicationDeps,
  {
    publicationId,
    outcome,
    url,
    actor,
  }: {
    publicationId: string;
    outcome: PublicationResolution;
    url?: string;
    actor: PublicationActor;
  },
): Promise<ResolvePublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const now = deps.now ?? (() => new Date());
  // El enlace se revisa antes del candado: un enlace malo no toca nada.
  // En `dry-run` un enlace se ignora, como al confirmar: nada salió de verdad.
  const item =
    outcome !== "published" || url === undefined || found.dryRun
      ? null
      : parsePublishedUrl(found.platform, url);

  return runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    const mode = modeOf(publication.dryRun);
    if (publication.status !== "outcome_unknown") {
      const repeated =
        outcome === "published"
          ? publication.status === "published" &&
            (item === null || item.externalId === publication.externalId)
          : publication.status === "failed" &&
            publication.lastError?.code === NOT_PUBLISHED_RESOLUTION_CODE;
      if (repeated) return { publication, changed: false };
      if (outcome === "published" && publication.status === "published") {
        throw new AppError(
          "PUBLICATION_ALREADY_CONFIRMED",
          "Esta publicación ya se confirmó con otro enlace",
          { details: { publicationId } },
        );
      }
      throw new AppError(
        "INVALID_TRANSITION",
        "Esta publicación no espera que digas si salió: su resultado ya se sabe",
        {
          details: {
            publicationId,
            from: publication.status,
            to: outcome === "published" ? "published" : "failed",
          },
        },
      );
    }
    if (outcome === "not_published") {
      const failed = await locked.repos.publications.transition(
        publicationId,
        // Sin el progreso: con la palabra del operador, el reintento vuelve a enviar desde cero (el
        // "enviando" que quedó lo dejaría dudoso otra vez).
        {
          from: "outcome_unknown",
          to: "failed",
          changes: { lastError: notPublishedError(), progress: null },
        },
        { actor, payload: { mode, reason: "not_published", outcome } },
      );
      return { publication: failed, changed: true };
    }
    const published = await locked.repos.publications.transition(
      publicationId,
      {
        from: "outcome_unknown",
        to: "published",
        changes: {
          externalId:
            item?.externalId ?? (publication.dryRun ? dryRunExternalId(publicationId) : null),
          externalUrl: item?.url ?? null,
          publishedAt: now(),
          lastError: null,
        },
      },
      { actor, payload: { mode, outcome } },
    );
    if (!publication.dryRun && locked.kind === "listing") {
      // Como el intento al publicar (spec F3 §4.3): el aviso pasa a `active` si estaba `ready`.
      const listing = await locked.repos.listings.get(locked.subject.id);
      if (listing?.status === "ready") {
        await locked.repos.listings.changeStatus(locked.subject.id, "ready", "active");
      }
    }
    return { publication: published, changed: true };
  });
}
