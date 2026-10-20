import type { Platform } from "../enums.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { Publication, PublicationActor } from "../publication.js";
import { listingSubject, postSubject, type Subject } from "../subject.js";
import { type LockedSubject, runOnSubject, type SubjectLocks } from "../subject-lock.js";
import {
  channelPublications,
  createPostPublications,
  createPublications,
  type SkippedPublication,
} from "./open-publications.js";
import {
  enqueuePublications,
  type MarketplaceStartOptions,
  type PortalCheckDeps,
  startOne,
  subjectDefinitionsBeforeLock,
} from "./publication-start.js";
import { prepareChannelStart, preparePostChannelStart } from "./start-checks.js";

/** `postLock` hace falta solo para publicar un post (`publishPost`). */
export type PublishListingDeps = PortalCheckDeps &
  SubjectLocks & {
    queue: JobQueue;
    /** Marketplace: el límite diario y si se puede convertir la UF (spec F5 §4.6 y §4.7). */
    marketplace?: MarketplaceStartOptions;
    now?: () => Date;
  };

export type PublishListingResult = {
  /** Las que pasaron a `publishing` ahora. */
  started: Publication[];
  /** Las que ya estaban en `publishing` y se volvieron a encolar (por si su job se perdió). */
  requeued: Publication[];
  /** Las que nacieron ahora (la cuenta se conectó después de aprobar). */
  created: Publication[];
  /** Formatos que no se abrieron porque ya tenían una publicación activa de otro texto. */
  skipped: SkippedPublication[];
  /** Pendientes de una cuenta que ya no está conectada: no se publican (descartarlas o reconectar). */
  stranded: Publication[];
  /** Todas las publicaciones del canal del aviso, después de publicar (leídas en el candado). */
  publications: Publication[];
};

/**
 * Publica un canal de un aviso (spec F3 §4.3, `POST /listings/:id/publish`). Dentro del candado:
 * abre las publicaciones que falten (`openPublications`: la cuenta se conectó después de aprobar),
 * pasa a `publishing` las `approved` y `failed` del canal cuya cuenta sigue conectada, con el modo
 * de la API (`dryRun`, D11) y su evento, y junta las que ya estaban en `publishing`. **Después**,
 * ya confirmado, encola un `publication.publish` por cada una (las que estaban, de nuevo: es
 * idempotente, y así una cola caída a mitad de camino se arregla publicando otra vez). Todas las
 * revisiones van antes de la primera escritura. Errores (`AppError`, 409 salvo los "no existe"):
 * - el aviso no existe → `LISTING_NOT_FOUND` (404); no está en `ready` o `active` → `LISTING_NOT_READY`;
 * - hay una corrida activa (puede reemplazar los medios) → `CONTENT_RUN_ACTIVE`;
 * - el texto vigente del canal no está aprobado → `CONTENT_NOT_APPROVED`;
 * - el corredor no tiene una cuenta conectada en el canal, o lo único pendiente es de una cuenta
 *   desconectada → `ACCOUNT_NOT_CONNECTED`;
 * - una fallida que ya empezó en `live` y se pide en `dry-run` → `PUBLISH_MODE_LOCKED`;
 * - en Portal, si hay algo que pasar a `publishing`: el texto aprobado tiene errores según la
 *   revisión de hoy → `CONTENT_HAS_ERRORS`, o al aviso le falta lo que pide Portal →
 *   `PORTAL_NOT_READY` (con `details.issues`; spec F4 §4.5), o una que ya existía es de otra
 *   versión del aviso → `PUBLICATION_LISTING_CHANGED` (§4.6);
 * - no hay nada que iniciar ni reencolar → `NOTHING_TO_PUBLISH` (si un formato está ocupado por
 *   una publicación de un texto anterior, el mensaje dice que se retire o descarte primero);
 * - la cola no está → `QUEUE_UNAVAILABLE` (503), con las que quedaron sin job en
 *   `details.publicationIds`: siguen en `publishing` y se reencolan publicando otra vez o al
 *   arrancar el worker.
 */
export function publishListing(
  deps: PublishListingDeps,
  {
    listingId,
    platform,
    dryRun,
    actor,
  }: { listingId: string; platform: Platform; dryRun: boolean; actor: PublicationActor },
): Promise<PublishListingResult> {
  return publishSubject(deps, { subject: listingSubject(listingId), platform, dryRun, actor });
}

/**
 * Publica un canal de un **post** (F9-T07, ADR-0029 punto 4; `POST /posts/:id/publish`, F9-T12):
 * como `publishListing`, dentro del candado del post, con una red y todos sus idiomas (abre las que
 * falten de cada texto aprobado y pasa a `publishing` las pendientes de cuentas conectadas), y
 * encola después. Errores: los de `preparePostChannelStart` y `QUEUE_UNAVAILABLE`. Un post nunca
 * pasa a `active` (lo del aviso no aplica).
 */
export function publishPost(
  deps: PublishListingDeps,
  {
    postId,
    platform,
    dryRun,
    actor,
  }: { postId: string; platform: Platform; dryRun: boolean; actor: PublicationActor },
): Promise<PublishListingResult> {
  return publishSubject(deps, { subject: postSubject(postId), platform, dryRun, actor });
}

/** Publica un canal del sujeto (aviso o post) dentro de su candado y encola después. */
async function publishSubject(
  deps: PublishListingDeps,
  {
    subject,
    platform,
    dryRun,
    actor,
  }: { subject: Subject; platform: Platform; dryRun: boolean; actor: PublicationActor },
): Promise<PublishListingResult> {
  const definitions = await subjectDefinitionsBeforeLock(deps, subject, platform);
  const result = await runOnSubject(deps, subject, (locked) =>
    locked.kind === "listing"
      ? publishListingChannel(deps, locked, { platform, dryRun, actor, definitions })
      : publishPostChannel(locked, { platform, dryRun, actor }),
  );

  // Ya confirmado: encolar todas, también las que ya estaban en curso (idempotente).
  await enqueuePublications(deps.queue, [...result.started, ...result.requeued]);
  return result;
}

type ChannelParams = { platform: Platform; dryRun: boolean; actor: PublicationActor };

/** El canal de un aviso, dentro de su candado (lo de siempre, spec F3 §4.3). */
async function publishListingChannel(
  deps: Pick<PublishListingDeps, "marketplace" | "now">,
  { subject, repos: locked }: Extract<LockedSubject, { kind: "listing" }>,
  {
    platform,
    dryRun,
    actor,
    definitions,
  }: ChannelParams & { definitions: Awaited<ReturnType<typeof subjectDefinitionsBeforeLock>> },
): Promise<PublishListingResult> {
  const listingId = subject.id;
  const { listing, content, opening, startable, stranded, inFlight } = await prepareChannelStart(
    locked,
    { listingId, platform },
    {
      dryRun,
      definitions,
      marketplace: deps.marketplace ?? {},
      now: (deps.now ?? (() => new Date()))(),
      manualLimits: true,
      countInFlight: true,
      nothingMessage: "No hay nada que publicar en este canal: todo está publicado",
    },
  );

  // Recién aquí se escribe.
  const created = await createPublications(locked, {
    listing,
    content,
    planned: opening.toCreate,
    actor,
  });
  const started: Publication[] = [];
  for (const publication of [...startable, ...created]) {
    started.push(await startOne(locked.publications, publication, { dryRun, actor }));
  }
  return {
    started,
    requeued: inFlight,
    created,
    skipped: opening.skipped,
    stranded,
    publications: await channelPublications(locked, listingSubject(listingId), platform),
  };
}

/** El canal de un post (una red, todos sus idiomas), dentro de su candado. */
async function publishPostChannel(
  { subject, repos: locked }: Extract<LockedSubject, { kind: "post" }>,
  { platform, dryRun, actor }: ChannelParams,
): Promise<PublishListingResult> {
  const { post, opening, startable, stranded, inFlight } = await preparePostChannelStart(
    locked,
    { subject, platform },
    {
      dryRun,
      countInFlight: true,
      nothingMessage: "No hay nada que publicar en esta red: todo está publicado",
    },
  );

  // Recién aquí se escribe.
  const created: Publication[] = [];
  for (const { content, planned } of opening.toCreate) {
    created.push(...(await createPostPublications(locked, { post, content, planned, actor })));
  }
  const started: Publication[] = [];
  for (const publication of [...startable, ...created]) {
    started.push(await startOne(locked.publications, publication, { dryRun, actor }));
  }
  return {
    started,
    requeued: inFlight,
    created,
    skipped: opening.skipped,
    stranded,
    publications: await channelPublications(locked, subject, platform),
  };
}
