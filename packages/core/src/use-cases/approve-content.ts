import { hasContentErrors } from "../content/check.js";
import { composePhotoSet } from "../content/compose.js";
import {
  beforeContentLock,
  type CheckedContent,
  type ContentLockDeps,
  type LockedContent,
  lockedCurrentContent,
  settlePostStatus,
} from "../content/locked-content.js";
import type { Content } from "../content.js";
import { AppError, isAppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import { type MarketplaceReadiness, marketplaceReadiness } from "../marketplace/readiness.js";
import { type PortalReadiness, portalReadiness } from "../portal/readiness.js";
import { canDraftPost, postNotReady } from "../post.js";
import type { Publication, PublicationActor } from "../publication.js";
import { requirePostPlatform } from "../social/post-networks.js";
import { listingSubject } from "../subject.js";
import {
  runOnSubject,
  type SubjectLockedRepositories,
  type SubjectLocks,
} from "../subject-lock.js";
import {
  channelPublications,
  createPostPublications,
  createPublications,
  type PostPublicationOpening,
  planPostPublications,
  planPublications,
  type SkippedPublication,
} from "./open-publications.js";

export type ApproveContentDeps = ContentLockDeps &
  SubjectLocks & {
    /** Marketplace: si hay token para convertir la UF (`BCCH_API_TOKEN`; spec F5 §4.6). */
    ufConfigured?: boolean;
  };

export type ApprovedContent = CheckedContent & {
  /** Las publicaciones que nacieron ahora. */
  created: Publication[];
  /** Formatos que no se abrieron porque ya tenían una publicación activa de otro texto. */
  skipped: SkippedPublication[];
  /**
   * Todas las publicaciones del canal del aviso o del post (en un post, de todos sus idiomas),
   * después de aprobar (leídas en el candado).
   */
  publications: Publication[];
  /**
   * Solo en Portal: lo que le falta al aviso para Mercado Libre (`portalReadiness`, spec F4 §4.5).
   * Es una advertencia: el texto se aprueba igual, y publicar lo bloquea con `PORTAL_NOT_READY`.
   */
  portalReadiness?: PortalReadiness;
  /**
   * Solo en Marketplace: lo que le falta al aviso para el formulario (`marketplaceReadiness`, spec
   * F5 §4.6). Advertencia, como en Portal: publicar lo bloquea con `MARKETPLACE_NOT_READY`.
   */
  marketplaceReadiness?: MarketplaceReadiness;
  /**
   * Solo en un post (F9.5-T21): `true` si el texto se aprobó pero no se abrieron publicaciones
   * porque faltan los medios que pide la red o todavía se están procesando (`CONTENT_NOT_READY`
   * de `planPostPublications`). Publicar y programar esperan a que existan.
   */
  mediaPending?: boolean;
};

/**
 * Aprueba el texto **vigente** de un canal (ADR-0014, spec F3 §4.2, `POST /contents/:id/approve`):
 * lo deja en `approved` y, si el corredor tiene una cuenta conectada en ese canal, abre sus
 * publicaciones (Instagram: carrusel y, con video, reel), todo dentro del candado de su sujeto: el
 * del aviso o, desde F9, el del post (ADR-0029; un post abre una por cuenta, formato e idioma y
 * pasa a `ready`). Todas las revisiones van antes de la primera escritura. Errores (`AppError`, 409
 * salvo los "no existe"):
 * - el texto o su aviso o post no existen → `CONTENT_NOT_FOUND`, `LISTING_NOT_FOUND` o
 *   `POST_NOT_FOUND` (404);
 * - no es el vigente → `CONTENT_NOT_CURRENT`;
 * - el aviso no está en `ready`, `active` o `paused` → `LISTING_NOT_READY`; el post no está en
 *   `draft` ni `ready` → `POST_NOT_READY`;
 * - hay una corrida activa (de textos o de imágenes, que reemplaza los medios) → `CONTENT_RUN_ACTIVE`;
 * - el texto es de una red que no está entre las del post (`posts.platforms`, F9-T21) →
 *   `POST_PLATFORM_EXCLUDED`;
 * - la revisión editorial tiene errores → `CONTENT_HAS_ERRORS` (las advertencias no bloquean);
 * - de un aviso, con una cuenta conectada, faltan los medios del canal → `CONTENT_NOT_READY`. Un
 *   post se aprueba sin sus medios (F9.5-T21): sin ellos no abre publicaciones todavía.
 * Aprobar un texto ya aprobado vuelve a revisar y abre lo que falte (idempotente). En Portal,
 * devuelve además lo que le falta al aviso (`portalReadiness`), como advertencia. Lo propio del
 * aviso (Portal, Marketplace, `listing_source_hash`) no aplica a los posts.
 */
export async function approveContent(
  deps: ApproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<ApprovedContent> {
  const before = await beforeContentLock(deps, contentId);

  return runOnSubject(deps, before.subject, async (locked) => {
    const found = await lockedCurrentContent(locked, contentId, before);
    if (found.kind === "listing" && !canPrepareContent(found.listing.status)) {
      throw new AppError("LISTING_NOT_READY", LISTING_NOT_PREPARABLE_TEXT, {
        details: { listingId: found.listing.id, status: found.listing.status },
      });
    }
    if (found.kind === "post" && !canDraftPost(found.post.status)) throw postNotReady(found.post);
    const review = await approvable(found, contentId);
    return found.kind === "listing"
      ? approveListingContent(deps, found, review, actor)
      : approvePostContent(found, review, actor);
  });
}

/** Lo común, antes de escribir: sin corrida activa y sin errores en la revisión. */
async function approvable(
  { repos, content, review }: LockedContent,
  contentId: string,
): Promise<CheckedContent> {
  const active = await repos.contentRuns.findActive(content.subject);
  if (active !== null) {
    throw new AppError(
      "CONTENT_RUN_ACTIVE",
      "Hay una preparación de contenido en curso: espera a que termine para aprobar",
      { details: { contentId, contentRunId: active.id } },
    );
  }
  const reviewed = review(content);
  if (hasContentErrors(reviewed.checks)) {
    throw new AppError(
      "CONTENT_HAS_ERRORS",
      "La revisión encontró errores en el texto: corrígelos antes de aprobar",
      {
        details: {
          contentId,
          // Solo los errores, como al publicar (`requirePortalPublishable`).
          codes: reviewed.checks
            .filter((check) => check.severity === "error")
            .map((check) => check.code),
        },
      },
    );
  }
  return reviewed;
}

/** El texto en `approved` (sin escribir si ya lo estaba). */
const markApproved = (repos: SubjectLockedRepositories, content: Content) =>
  content.status === "approved"
    ? Promise.resolve(content)
    : repos.contents.update(content.id, { status: "approved" });

/** Aviso: abre sus publicaciones y devuelve lo que le falta para Portal o Marketplace. */
async function approveListingContent(
  deps: Pick<ApproveContentDeps, "ufConfigured">,
  { repos: locked, content, listing }: Extract<LockedContent, { kind: "listing" }>,
  review: CheckedContent,
  actor: PublicationActor,
): Promise<ApprovedContent> {
  const opening = await planPublications(locked, { listing, content });
  let readiness: PortalReadiness | undefined;
  if (content.platform === "portal_inmobiliario") {
    const broker = await locked.brokers.findById(listing.brokerId);
    if (broker === null) {
      throw new AppError("BROKER_NOT_FOUND", "No existe el corredor del aviso", {
        details: { listingId: listing.id },
      });
    }
    readiness = portalReadiness(listing, {
      name: broker.name,
      email: broker.email,
      whatsapp: broker.whatsapp,
    });
  }

  const marketplace =
    content.platform === "fb_marketplace"
      ? marketplaceReadiness(listing, {
          photos: composePhotoSet(await locked.media.listBySubject(listingSubject(listing.id)))
            .length,
          ufConfigured: deps.ufConfigured ?? false,
        })
      : undefined;

  // Recién aquí se escribe: nada de lo anterior puede dejar el texto aprobado a medias.
  const approved = await markApproved(locked, content);
  const created = await createPublications(locked, {
    listing,
    content: approved,
    planned: opening.toCreate,
    actor,
  });
  return {
    content: approved,
    checks: review.checks,
    created,
    skipped: opening.skipped,
    publications: await channelPublications(locked, listingSubject(listing.id), approved.platform),
    ...(readiness === undefined ? {} : { portalReadiness: readiness }),
    ...(marketplace === undefined ? {} : { marketplaceReadiness: marketplace }),
  };
}

/**
 * F9.5-T21: el texto de un post se aprueba **sin tener los medios** (llegan después: subidos o
 * generados). Si faltan (`CONTENT_NOT_READY`), no se abre ninguna publicación todavía: las abren
 * publicar o programar, que sí esperan a los medios, y `mediaPending` lo dice. Cualquier otro error
 * sigue subiendo.
 */
async function planWithoutMedia(
  locked: Parameters<typeof planPostPublications>[0],
  params: Parameters<typeof planPostPublications>[1],
): Promise<{ opening: PostPublicationOpening; mediaPending: boolean }> {
  try {
    return { opening: await planPostPublications(locked, params), mediaPending: false };
  } catch (error) {
    if (isAppError(error) && error.code === "CONTENT_NOT_READY") {
      return { opening: { toCreate: [], skipped: [] }, mediaPending: true };
    }
    throw error;
  }
}

/** Post: abre una publicación por cuenta, formato e idioma, y deja el post en `ready`. */
async function approvePostContent(
  { repos: locked, content, post }: Extract<LockedContent, { kind: "post" }>,
  review: CheckedContent,
  actor: PublicationActor,
): Promise<ApprovedContent> {
  // F9-T21: el texto de una red que se le quitó al post no se aprueba (abriría publicaciones).
  requirePostPlatform(post, content.platform);
  const { opening, mediaPending } = await planWithoutMedia(locked, { post, content });

  // Recién aquí se escribe.
  const approved = await markApproved(locked, content);
  const created = await createPostPublications(locked, {
    post,
    content: approved,
    planned: opening.toCreate,
    actor,
  });
  await settlePostStatus(locked, post);
  return {
    content: approved,
    checks: review.checks,
    created,
    skipped: opening.skipped,
    publications: await channelPublications(locked, approved.subject, approved.platform),
    mediaPending,
  };
}
