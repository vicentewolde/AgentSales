import type { Language, PostPlatform } from "../enums.js";
import { isPostPlatform } from "../enums.js";
import { AppError } from "../errors.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { parsePublishedUrl } from "../publish/published-url.js";
import { postSubject } from "../subject.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";

export type RecordExternalPublicationDeps = SubjectLocks & {
  now?: () => Date;
};

export type RecordExternalPublicationResult = {
  publication: Publication;
  /** La publicación simulada que quedó superada (retirada, sin borrar nada), si había una. */
  superseded: Publication[];
};

/** Hasta cuánto en el futuro se acepta la fecha (relojes distintos): 5 minutos. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * «Ya lo publiqué fuera de AgentSales» (F9.5, nota del spec): registra que el texto de un post, de
 * una red e idioma, **ya está en la red** con su enlace, aunque se publicó a mano o antes. Crea una
 * publicación `published` en vivo (`dry_run = false`), con `external_id` y `external_url` del enlace
 * (`parsePublishedUrl`, obligatorio), la fecha de publicación (por defecto, ahora) y en la bitácora
 * un evento `manual_edit` con `recorded: true`. Todo dentro del candado del post.
 * - Si el texto tenía una publicación **simulada** `published` (`dry_run = true`, por ejemplo una
 *   confirmada a mano con el servidor en simulación), queda superada de forma no destructiva:
 *   `published` → `unpublished` con `reason: "superseded_by_record"`. Así Seguimiento y el avance
 *   del post ven solo la real. Si hay otra sin publicar (`approved`, `scheduled`, `failed`), se
 *   descarta (`cancelled`): el texto ya salió.
 * - Si ya hay una real publicada (o pausada) de ese texto, `PUBLICATION_ALREADY_CONFIRMED` (409);
 *   para agregarle el enlace a una sin enlace, se usa «Ya lo publiqué» (`confirm`).
 * - Si hay una publicándose, esperando tu clic o con resultado dudoso, `PUBLICATION_IN_PROGRESS`
 *   (409): primero se resuelve esa.
 * Errores: `POST_NOT_FOUND`, `CONTENT_NOT_FOUND` (no hay texto de esa red e idioma),
 * `CONTENT_PLATFORM_INVALID`, `ACCOUNT_NOT_CONNECTED`, `PUBLISHED_URL_INVALID` (antes del candado),
 * `PUBLISHED_AT_INVALID` (fecha futura).
 */
export async function recordExternalPublication(
  deps: RecordExternalPublicationDeps,
  {
    postId,
    platform,
    language,
    url,
    publishedAt,
    actor,
  }: {
    postId: string;
    platform: PostPlatform;
    language: Language;
    url: string;
    publishedAt?: Date;
    actor: PublicationActor;
  },
): Promise<RecordExternalPublicationResult> {
  if (!isPostPlatform(platform)) {
    throw new AppError("CONTENT_PLATFORM_INVALID", "Esa red no publica posts", {
      details: { platform },
    });
  }
  const now = (deps.now ?? (() => new Date()))();
  if (publishedAt !== undefined && publishedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new AppError("PUBLISHED_AT_INVALID", "La fecha de publicación no puede ser futura", {
      details: { postId },
    });
  }
  // El enlace se revisa antes del candado: uno malo no toca nada.
  const item = parsePublishedUrl(platform, url);

  return runOnSubject(deps, postSubject(postId), async (locked) => {
    if (locked.kind !== "post") throw new AppError("SUBJECT_NOT_LISTING", "No es un post");
    const { repos } = locked;
    const post = await repos.posts.get(postId);
    if (post === null) throw new AppError("POST_NOT_FOUND", "El post no existe");
    const subject = postSubject(postId);
    const content = (await repos.contents.listCurrent(subject)).find(
      (candidate) => candidate.platform === platform && candidate.language === language,
    );
    if (content === undefined) {
      throw new AppError("CONTENT_NOT_FOUND", "El post no tiene un texto de esa red e idioma", {
        details: { postId, platform, language },
      });
    }
    const same = (await repos.publications.listBySubject(subject)).filter(
      (publication) => publication.platform === platform && publication.language === language,
    );
    const real = same.find(
      (publication) =>
        !publication.dryRun &&
        (publication.status === "published" || publication.status === "paused"),
    );
    if (real !== undefined) {
      throw new AppError(
        "PUBLICATION_ALREADY_CONFIRMED",
        "Este texto ya tiene una publicación real: no se registra otra",
        { details: { postId, publicationId: real.id } },
      );
    }
    const busy = same.find((publication) =>
      ["publishing", "awaiting_manual_confirm", "outcome_unknown"].includes(publication.status),
    );
    if (busy !== undefined) {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "Este texto tiene una publicación en curso: termina o resuelve esa primero (por ejemplo, con «Ya lo publiqué»)",
        { details: { postId, publicationId: busy.id, status: busy.status } },
      );
    }

    // Lo simulado que quedó publicado se retira sin borrar nada; lo sin publicar se descarta.
    const superseded: Publication[] = [];
    for (const publication of same) {
      if (publication.status === "published" && publication.dryRun) {
        superseded.push(
          await repos.publications.transition(
            publication.id,
            { from: "published", to: "unpublished" },
            { actor, payload: { mode: "dry-run", reason: "superseded_by_record" } },
          ),
        );
      } else if (canTransition(publication.status, "cancelled")) {
        superseded.push(
          await repos.publications.transition(
            publication.id,
            { from: publication.status, to: "cancelled" },
            { actor, payload: { reason: "superseded_by_record" } },
          ),
        );
      }
    }

    const previous = same[0];
    const accounts = (await repos.platformAccounts.listByBroker(post.brokerId, platform)).filter(
      (account) => account.status === "connected",
    );
    const account =
      accounts.find((candidate) => candidate.id === previous?.platformAccountId) ?? accounts[0];
    if (account === undefined) {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "La marca no tiene una cuenta conectada en esa red: conéctala en Cuentas",
        { details: { postId, platform } },
      );
    }

    const created = await repos.publications.create(
      {
        postId,
        platformAccountId: account.id,
        platform,
        format: previous?.format ?? "post",
        language,
        contentId: content.id,
        mediaIds: previous?.mediaIds ?? [],
      },
      { actor, payload: { contentId: content.id, recorded: true } },
    );
    await repos.publications.transition(
      created.id,
      { from: "approved", to: "publishing", changes: { dryRun: false } },
      { actor, payload: { mode: "live", recorded: true } },
    );
    const published = await repos.publications.transition(
      created.id,
      {
        from: "publishing",
        to: "published",
        changes: {
          externalId: item.externalId,
          externalUrl: item.url,
          publishedAt: publishedAt ?? now,
          lastError: null,
        },
      },
      { actor, payload: { mode: "live", recorded: true, confirmedBy: "operator" } },
    );
    await repos.publications.addEvent(created.id, {
      type: "manual_edit",
      actor,
      payload: {
        mode: "live",
        recorded: true,
        note: "Registrada a mano: ya estaba publicada fuera de AgentSales",
        supersededIds: superseded.map((publication) => publication.id),
      },
    });
    return { publication: published, superseded };
  });
}
