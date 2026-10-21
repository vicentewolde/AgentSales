import {
  CAROUSEL_MAX_ITEMS,
  CAROUSEL_MIN_ITEMS,
  composeCarousel,
  composePhotoSet,
  composeReel,
  variantOf,
  videosOf,
} from "../content/compose.js";
import type { Content } from "../content.js";
import { isPostPlatform, type Language, type Platform, type PublicationFormat } from "../enums.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import type { Post } from "../post.js";
import type { Publication, PublicationActor } from "../publication.js";
import { ACTIVE_PUBLICATION_STATUSES } from "../publication-state.js";
import { X_MAX_IMAGES } from "../social/networks.js";
import {
  listingSubject,
  type PostSubject,
  postSubject,
  type Subject,
  sameSubject,
} from "../subject.js";

/** Lo que se publica de un canal: un formato con sus medios, en orden. */
export type PublicationPlanItem = { format: PublicationFormat; mediaIds: string[] };

/**
 * Los formatos de un canal y sus medios (ADR-0014): Instagram da `post` (el carrusel: portada,
 * fotos y ficha) y, si el aviso tiene reel, `reel`; Portal y Marketplace dan `post` con las fotos
 * 4:3. Un `post` sin medios es `CONTENT_NOT_READY`: falta preparar las fotos.
 */
export function publicationPlan(
  platform: Platform,
  media: readonly Media[],
): PublicationPlanItem[] {
  const post = platform === "instagram" ? composeCarousel(media) : composePhotoSet(media);
  if (post.length === 0) {
    throw new AppError(
      "CONTENT_NOT_READY",
      "Faltan las fotos procesadas: prepara el contenido antes de aprobar",
      { details: { platform } },
    );
  }
  const plan: PublicationPlanItem[] = [{ format: "post", mediaIds: post.map((item) => item.id) }];
  const reel = platform === "instagram" ? composeReel(media) : null;
  if (reel !== null) plan.push({ format: "reel", mediaIds: [reel.id] });
  return plan;
}

/** Un formato que no se abrió porque ya tenía una publicación activa **de otro texto** en esa cuenta. */
export type SkippedPublication = {
  platformAccountId: string;
  format: PublicationFormat;
  publicationId: string;
};

/** Una publicación por abrir: su cuenta, su formato y sus medios. */
export type PlannedPublication = PublicationPlanItem & { platformAccountId: string };

/** Lo que se va a abrir y lo que se salta, sin haber escrito nada. */
export type PublicationOpening = { toCreate: PlannedPublication[]; skipped: SkippedPublication[] };

/**
 * Planifica las publicaciones de un texto (ADR-0014, spec F3 §4.2), **sin escribir**: una por
 * cuenta conectada del corredor en el canal y por formato. Un formato que ya tiene una publicación
 * activa en esa cuenta no se abre: si es de este mismo texto, ya está (aprobar de nuevo es
 * idempotente); si es de otro (por ejemplo, una `published` de un texto anterior), se informa en
 * `skipped`. Sin cuentas conectadas no hay nada que abrir. Con cuentas, un `post` sin medios es
 * `CONTENT_NOT_READY` (también si todos los formatos se fueran a saltar: el plan se arma antes).
 * Se llama antes de cualquier escritura, así un rechazo no deja nada a medias (el candado en memoria
 * no deshace).
 */
export async function planPublications(
  repos: Pick<LockedRepositories, "platformAccounts" | "media" | "publications">,
  { listing, content }: { listing: Listing; content: Content },
): Promise<PublicationOpening> {
  const accounts = (
    await repos.platformAccounts.listByBroker(listing.brokerId, content.platform)
  ).filter((account) => account.status === "connected");
  if (accounts.length === 0) return { toCreate: [], skipped: [] };

  const plan = publicationPlan(
    content.platform,
    await repos.media.listBySubject(listingSubject(listing.id)),
  );
  const active = (await repos.publications.listBySubject(listingSubject(listing.id))).filter(
    (publication) => ACTIVE_PUBLICATION_STATUSES.includes(publication.status),
  );
  const toCreate: PlannedPublication[] = [];
  const skipped: SkippedPublication[] = [];
  for (const account of accounts) {
    for (const item of plan) {
      const existing = active.find(
        (publication) =>
          publication.platformAccountId === account.id && publication.format === item.format,
      );
      if (existing === undefined) {
        toCreate.push({ ...item, platformAccountId: account.id });
      } else if (existing.contentId !== content.id) {
        skipped.push({
          platformAccountId: account.id,
          format: item.format,
          publicationId: existing.id,
        });
      }
    }
  }
  return { toCreate, skipped };
}

/**
 * Crea las publicaciones planificadas, en `approved`, con `content_id`, `media_ids` y la versión
 * del aviso (`listing_source_hash`, spec F4 §4.6) fijos. La versión se lee dentro del candado: una
 * carga del Excel no se cruza.
 */
export async function createPublications(
  repos: Pick<LockedRepositories, "publications" | "listings">,
  {
    listing,
    content,
    planned,
    actor,
    relistedFrom,
  }: {
    listing: Listing;
    content: Content;
    planned: readonly PlannedPublication[];
    actor: PublicationActor;
    /** Republicar (ADR-0020): la publicación que estas republican. */
    relistedFrom?: string;
  },
): Promise<Publication[]> {
  const created: Publication[] = [];
  if (planned.length === 0) return created;
  const listingSourceHash = await repos.listings.getSourceHash(listing.id);
  // Una versión vacía tampoco sirve: el repositorio la guardaría como "sin versión".
  if (listingSourceHash === null || listingSourceHash === "") {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listing.id}`, {
      details: { listingId: listing.id },
    });
  }
  for (const item of planned) {
    created.push(
      await repos.publications.create(
        {
          listingId: listing.id,
          platformAccountId: item.platformAccountId,
          platform: content.platform,
          format: item.format,
          contentId: content.id,
          mediaIds: item.mediaIds,
          listingSourceHash,
          ...(relistedFrom === undefined ? {} : { relistedFrom }),
        },
        { actor, payload: { contentId: content.id, mediaCount: item.mediaIds.length } },
      ),
    );
  }
  return created;
}

/**
 * Las publicaciones de un canal del aviso o del post (todos sus idiomas), para devolverlas leídas
 * dentro del candado.
 */
export async function channelPublications(
  repos: Pick<LockedRepositories, "publications">,
  subject: Subject,
  platform: Platform,
): Promise<Publication[]> {
  return (await repos.publications.listBySubject(subject)).filter(
    (publication) => publication.platform === platform,
  );
}

// ---------------------------------------------------------------------------------------------
// Posts (F9, ADR-0029): una publicación por cuenta, formato **e idioma**. Lo propio del aviso
// (`listing_source_hash`, las reglas de Portal y Marketplace, republicar) no aplica.

/** Las imágenes de un post: el `ig_4x5` de cada foto original, en su orden. */
const postImages = (media: readonly Media[]): Media[] =>
  media
    .filter((item) => item.role === "original" && item.kind === "image")
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
    .map((photo) => variantOf(media, photo.id, "ig_4x5"))
    .filter((variant): variant is Media => variant !== null);

/** El video de un post: el `ig_reel` (9:16, hasta 90 s) de su primer video original. */
const postVideo = (media: readonly Media[]): Media | null => {
  const first = videosOf(media)[0];
  return first === undefined ? null : variantOf(media, first.id, "ig_reel");
};

/**
 * El video de un post para Discord (spec F9 §4.5, D8; F9-T14): la variante más liviana del primer
 * video entre el video reducido de X (`x_video`, 720p) y el reel (`ig_reel`), para que quepa en los
 * 20 MiB por archivo de Discord. Si igual no cabe, el publisher no lo adjunta (`discord.md`).
 */
const discordVideo = (media: readonly Media[]): Media | null => {
  const first = videosOf(media)[0];
  if (first === undefined) return null;
  const candidates = [variantOf(media, first.id, "x_video"), variantOf(media, first.id, "ig_reel")]
    .filter((variant): variant is Media => variant !== null)
    .sort((a, b) => a.bytes - b.bytes);
  return candidates[0] ?? null;
};

/**
 * El video de un post para X (F9-T16): el video reducido de X (`x_video`, 720p, F9-T10) de su
 * primer video, que cabe en el máximo de 1280×1024 de la doc (`x.md` §5.3). Sin él, falta procesar.
 */
const xVideo = (media: readonly Media[]): Media | null => {
  const first = videosOf(media)[0];
  return first === undefined ? null : variantOf(media, first.id, "x_video");
};

const postMediaMissing = (platform: Platform, message: string) =>
  new AppError("CONTENT_NOT_READY", message, { details: { platform } });

/**
 * Instagram (spec F9 §4.4 y §4.6, F9-T13): lo que publica según lo que lleva el post. Una imagen
 * va como imagen suelta (el `ig_4x5` de su primera foto, aunque el post tenga más); un carrusel,
 * con el `ig_4x5` de 2 a 10 fotos en su orden (con menos de 2 procesadas no es carrusel y falta
 * esperar o subir otra; sobre 10, la revisión del texto ya lo frena y aquí se cortan); un video,
 * como `reel` con su `ig_reel` (9:16, de 3 a 90 s, sin texto encima; la portada es el cuadro del
 * segundo 1, el mismo de su `thumb`). Un post de solo texto no se publica en Instagram. Lo que
 * falta procesar es `CONTENT_NOT_READY`. El carrusel de un aviso (`composeCarousel`) no cambia.
 */
function instagramPostPlan(kind: Post["kind"], media: readonly Media[]): PublicationPlanItem {
  if (kind === "text") {
    throw postMediaMissing(
      "instagram",
      "Instagram necesita una imagen o un video: súbelos al post y cambia su tipo",
    );
  }
  if (kind === "video") {
    const video = postVideo(media);
    if (video === null) {
      throw postMediaMissing(
        "instagram",
        "Falta el video procesado del post: espera a que termine",
      );
    }
    return { format: "reel", mediaIds: [video.id] };
  }
  const images = postImages(media);
  if (kind === "image") {
    const [first] = images;
    if (first === undefined) {
      throw postMediaMissing(
        "instagram",
        "Falta la imagen procesada del post: espera a que termine",
      );
    }
    return { format: "post", mediaIds: [first.id] };
  }
  if (images.length < CAROUSEL_MIN_ITEMS) {
    throw postMediaMissing(
      "instagram",
      `Un carrusel de Instagram lleva de ${CAROUSEL_MIN_ITEMS} a ${CAROUSEL_MAX_ITEMS} imágenes procesadas y este post tiene ${images.length}: espera a que terminen o súbelas`,
    );
  }
  return {
    format: "post",
    mediaIds: images.slice(0, CAROUSEL_MAX_ITEMS).map((item) => item.id),
  };
}

/**
 * El formato y los medios de un post en una red (spec F9 §4.4 y §4.6), según lo que lleva
 * (`post.kind`). Instagram tiene su propia selección (`instagramPostPlan`, F9-T13). En las demás
 * redes: un texto solo va sin medios (TikTok lo rechaza); una imagen o un carrusel, con sus
 * `ig_4x5`; un video, con su `ig_reel` (en Discord, la variante más liviana, `discordVideo`, F9-T14;
 * en X, el video reducido `x_video` y hasta 4 imágenes, F9-T16).
 * Las verificaciones de cada red (X: hasta 4 imágenes, spec F9 §4.4) son de la revisión del texto,
 * no de aquí, y las variantes propias de cada red (el video reducido de X) las afinan sus tareas
 * (F9-T14 a T16). Lo que falta procesar es `CONTENT_NOT_READY`. Portal y Marketplace no publican
 * posts: `CONTENT_PLATFORM_INVALID`.
 */
export function postPublicationPlan(
  platform: Platform,
  kind: Post["kind"],
  media: readonly Media[],
): PublicationPlanItem {
  if (!isPostPlatform(platform)) {
    throw new AppError("CONTENT_PLATFORM_INVALID", "Esa plataforma no publica posts", {
      details: { platform },
    });
  }
  if (platform === "instagram") return instagramPostPlan(kind, media);
  if (kind === "text") {
    if (platform === "tiktok") {
      throw postMediaMissing(platform, "Esta red necesita una imagen o un video: súbelos al post");
    }
    return { format: "post", mediaIds: [] };
  }
  if (kind === "video") {
    const video =
      platform === "discord"
        ? discordVideo(media)
        : platform === "x"
          ? xVideo(media)
          : postVideo(media);
    if (video === null) {
      throw postMediaMissing(platform, "Falta el video procesado del post: espera a que termine");
    }
    return { format: "post", mediaIds: [video.id] };
  }
  if (platform === "tiktok") {
    throw postMediaMissing(platform, "TikTok publica solo video: súbelo al post");
  }
  const images = postImages(media);
  if (images.length === 0) {
    throw postMediaMissing(
      platform,
      "Faltan las imágenes procesadas del post: espera a que terminen",
    );
  }
  // X lleva hasta 4 imágenes (la revisión del texto ya frena un post con más, F9-T11).
  const kept = platform === "x" ? images.slice(0, X_MAX_IMAGES) : images;
  return { format: "post", mediaIds: kept.map((item) => item.id) };
}

/** Una publicación de un post por abrir: la de un aviso más su idioma (el del texto). */
export type PlannedPostPublication = PlannedPublication & { language: Language };

/** Lo que se va a abrir de un post y lo que se salta, sin haber escrito nada. */
export type PostPublicationOpening = {
  toCreate: PlannedPostPublication[];
  skipped: SkippedPublication[];
};

/**
 * Planifica las publicaciones del texto de un post, **sin escribir**, como `planPublications`: una
 * por cuenta conectada de la marca en la red, en el formato que da `postPublicationPlan` y en el
 * idioma del texto. Un formato que ya tiene una publicación activa en esa cuenta **y en ese
 * idioma** no se abre (la del otro idioma es otra publicación, spec F9 §4.4): si es de este texto,
 * ya está; si es de otro, se informa en `skipped`.
 */
export async function planPostPublications(
  repos: Pick<PostLockedRepositories, "platformAccounts" | "media" | "publications">,
  { post, content }: { post: Post; content: Content },
): Promise<PostPublicationOpening> {
  const accounts = (
    await repos.platformAccounts.listByBroker(post.brokerId, content.platform)
  ).filter((account) => account.status === "connected");
  if (accounts.length === 0) return { toCreate: [], skipped: [] };

  const subject = postSubject(post.id);
  const item = postPublicationPlan(
    content.platform,
    post.kind,
    await repos.media.listBySubject(subject),
  );
  const active = (await repos.publications.listBySubject(subject)).filter(
    (publication) =>
      ACTIVE_PUBLICATION_STATUSES.includes(publication.status) &&
      publication.language === content.language,
  );
  const toCreate: PlannedPostPublication[] = [];
  const skipped: SkippedPublication[] = [];
  for (const account of accounts) {
    const existing = active.find(
      (publication) =>
        publication.platformAccountId === account.id && publication.format === item.format,
    );
    if (existing === undefined) {
      toCreate.push({ ...item, platformAccountId: account.id, language: content.language });
    } else if (existing.contentId !== content.id) {
      skipped.push({
        platformAccountId: account.id,
        format: item.format,
        publicationId: existing.id,
      });
    }
  }
  return { toCreate, skipped };
}

/**
 * Si una publicación de un post calza con su sujeto (ADR-0029, spec F9 §4.2): su texto es de ese
 * post y de su idioma, y cada uno de sus medios es de ese post. Es una regla de core (no un `CHECK`
 * de la base): `createPostPublications` la exige antes de escribir.
 */
export function postPublicationMatchesSubject(
  subject: PostSubject,
  publication: { language: Language; mediaIds: readonly string[] },
  content: Pick<Content, "subject" | "language">,
  media: readonly Pick<Media, "id" | "postId">[],
): boolean {
  if (!sameSubject(content.subject, subject) || content.language !== publication.language) {
    return false;
  }
  const own = new Set(media.filter((item) => item.postId === subject.id).map((item) => item.id));
  return publication.mediaIds.every((id) => own.has(id));
}

/**
 * Crea las publicaciones planificadas de un post, en `approved`, con su texto, sus medios y su
 * idioma fijos, sin `listing_source_hash` (un post no tiene ficha que versionar). Antes de escribir
 * revisa que cada una calce con el post (`postPublicationMatchesSubject`); si no, es un bug de
 * quien llama: `PUBLICATION_SUBJECT_MISMATCH`, no reintentable, sin escribir nada.
 */
export async function createPostPublications(
  repos: Pick<PostLockedRepositories, "publications" | "media">,
  {
    post,
    content,
    planned,
    actor,
  }: {
    post: Post;
    content: Content;
    planned: readonly PlannedPostPublication[];
    actor: PublicationActor;
  },
): Promise<Publication[]> {
  if (planned.length === 0) return [];
  const subject = postSubject(post.id);
  const media = await repos.media.listBySubject(subject);
  const mismatch = planned.find(
    (item) => !postPublicationMatchesSubject(subject, item, content, media),
  );
  if (mismatch !== undefined) {
    throw new AppError(
      "PUBLICATION_SUBJECT_MISMATCH",
      "La publicación no calza con el texto o los medios del post",
      { details: { postId: post.id, contentId: content.id } },
    );
  }
  const created: Publication[] = [];
  for (const item of planned) {
    created.push(
      await repos.publications.create(
        {
          postId: post.id,
          platformAccountId: item.platformAccountId,
          platform: content.platform,
          format: item.format,
          language: item.language,
          contentId: content.id,
          mediaIds: item.mediaIds,
        },
        { actor, payload: { contentId: content.id, mediaCount: item.mediaIds.length } },
      ),
    );
  }
  return created;
}
