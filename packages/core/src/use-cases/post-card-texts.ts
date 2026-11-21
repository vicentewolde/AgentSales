import type { ContentCheck } from "../content/check.js";
import { editorialProfileView } from "../editorial-profile.js";
import type { Language } from "../enums.js";
import { AppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { PostCardTextRepository } from "../ports/post-card-text-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import {
  CARD_TEXT_LIMITS,
  type CardTextsInput,
  checkCardText,
  normalizeCardTexts,
  type PostCardText,
} from "../post-card-texts.js";
import { buildPostCheckContext } from "../social/check.js";
import { postLanguages } from "../social/post-languages.js";
import type { User } from "../user.js";
import { assertPostAccess, postNotFound } from "./posts.js";

// Ver y editar los textos de las láminas de un post (spec F9.7 B5, ADR-0043): `GET/PUT
// /posts/:id/card-texts` y `post cards-text`. La revisión (hechos, evitar y largo) se calcula al
// leer, como la de los textos.

type Actor = Pick<User, "id" | "role" | "brokerId">;

export type CardTextView = PostCardText & { checks: ContentCheck[] };

export type PostCardTextsView = {
  postId: string;
  /** Los idiomas del post (`postLanguages`): las láminas de otro idioma no se muestran. */
  languages: Language[];
  texts: CardTextView[];
};

export type PostCardTextsDeps = {
  posts: Pick<PostRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  cardTexts: PostCardTextRepository;
};

async function viewOf(deps: PostCardTextsDeps, postId: string): Promise<PostCardTextsView> {
  const post = await deps.posts.get(postId);
  if (post === null) throw postNotFound(postId);
  const broker = await deps.brokers.findById(post.brokerId);
  if (broker === null) throw postNotFound(postId);
  const profile = editorialProfileView(broker.id, await deps.editorialProfiles.get(broker.id));
  const ctx = buildPostCheckContext({ post, profile, broker, media: [] });
  const languages = postLanguages(post, profile.languages);
  const texts = (await deps.cardTexts.list(postId))
    .filter((text) => languages.includes(text.language))
    .map((text) => ({ ...text, checks: checkCardText(text, ctx) }));
  return { postId, languages, texts };
}

/** Las láminas del post con su revisión (`posts.manage`; lo de otra marca no existe). */
export async function getPostCardTexts(
  deps: PostCardTextsDeps,
  actor: Actor,
  postId: string,
): Promise<PostCardTextsView> {
  assertPostAccess(actor, await deps.posts.get(postId), postId);
  return viewOf(deps, postId);
}

/**
 * Reemplaza las láminas de un idioma con las del operador (`approved`: redactar de nuevo ya no las
 * pisa). Un idioma que no es del post es `POST_LANGUAGE_EXCLUDED` (409); un post de texto o video
 * no tiene láminas (`POST_IMAGE_NOT_NEEDED`, 409).
 */
export async function savePostCardTexts(
  deps: PostCardTextsDeps,
  actor: Actor,
  postId: string,
  language: Language,
  input: CardTextsInput,
): Promise<PostCardTextsView> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (post.kind !== "image" && post.kind !== "carousel") {
    throw new AppError(
      "POST_IMAGE_NOT_NEEDED",
      "Solo un post de imagen o carrusel tiene textos de láminas",
      { details: { postId } },
    );
  }
  const profile = editorialProfileView(
    post.brokerId,
    await deps.editorialProfiles.get(post.brokerId),
  );
  if (!postLanguages(post, profile.languages).includes(language)) {
    throw new AppError("POST_LANGUAGE_EXCLUDED", "Ese idioma no es de este post", {
      details: { postId, language },
    });
  }
  const texts = normalizeCardTexts(input);
  // Un post de imagen guarda su portada y hasta `imagePoints` puntos clave (van en la misma imagen).
  await deps.cardTexts.replace(
    postId,
    language,
    post.kind === "image" ? texts.slice(0, 1 + CARD_TEXT_LIMITS.imagePoints) : texts,
    { fromAi: false },
  );
  return viewOf(deps, postId);
}
