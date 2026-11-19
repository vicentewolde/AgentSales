import { LANGUAGES, type Language } from "../enums.js";
import { AppError } from "../errors.js";
import { LANGUAGE_TEXT } from "../labels.js";
import type { Post } from "../post.js";

// Los idiomas de un post (2026-11-15): una sola regla en core para todos los caminos, como
// `postPublishesOn` para las redes. Los idiomas de la marca (`editorial_profiles.languages`) son
// los de todos sus posts, salvo que el post tenga los suyos («Idiomas de este post»,
// `posts.languages`). Un idioma quitado no se redacta, no da tarjetas y su texto no se aprueba;
// los textos que ya tenía y no están aprobados se ocultan (no se borran: vuelven si el idioma
// vuelve). Los ya aprobados se siguen mostrando y publicando, con una nota.

/**
 * Los idiomas en que escribe el post: los suyos (`posts.languages`) o, con `null`, los de la marca.
 * Siempre al menos uno, el principal primero: el orden de la marca y después el de `LANGUAGES`.
 */
export function postLanguages(
  post: Pick<Post, "languages">,
  brandLanguages: readonly Language[],
): Language[] {
  const brand = brandLanguages.length > 0 ? brandLanguages : [LANGUAGES[0]];
  if (post.languages === null || post.languages.length === 0) return [...brand];
  const own = post.languages;
  return [
    ...brand.filter((language) => own.includes(language)),
    ...LANGUAGES.filter((language) => own.includes(language) && !brand.includes(language)),
  ];
}

/** Si el post escribe en ese idioma (`postLanguages`). */
export function postWritesIn(
  post: Pick<Post, "languages">,
  brandLanguages: readonly Language[],
  language: Language,
): boolean {
  return postLanguages(post, brandLanguages).includes(language);
}

/**
 * Si un texto del post se muestra y cuenta (alertas, «Aprobar la semana», aprobar todo): el de un
 * idioma del post, o uno ya aprobado de un idioma quitado (se muestra con una nota y sale si ya
 * estaba programado). Un texto sin aprobar de un idioma quitado se oculta.
 */
export function postTextVisible(
  content: { language: Language; status: string },
  languages: readonly Language[],
): boolean {
  return languages.includes(content.language) || content.status === "approved";
}

/**
 * Los idiomas pedidos para un post (`post edit --languages`, el panel): de `LANGUAGES`, sin
 * repetir y al menos uno; `null` = los de la marca. Otro valor es `POST_INVALID` (400).
 */
export function normalizePostLanguages(languages: readonly string[] | null): Language[] | null {
  if (languages === null) return null;
  const asked = languages.map((language) => language.trim().toLowerCase());
  const unknown = asked.filter((language) => !(LANGUAGES as readonly string[]).includes(language));
  if (unknown.length > 0) {
    throw new AppError(
      "POST_INVALID",
      `${unknown.map((item) => `«${item.slice(0, 10)}»`).join(", ")} no es un idioma (usa ${LANGUAGES.join(" o ")})`,
      { details: { languages: unknown.map((item) => item.slice(0, 10)) } },
    );
  }
  if (asked.length === 0) {
    throw new AppError(
      "POST_INVALID",
      "Un post necesita al menos un idioma (o ninguna lista: los de la marca)",
    );
  }
  return LANGUAGES.filter((language) => asked.includes(language));
}

/**
 * `POST_LANGUAGE_EXCLUDED` (409): el idioma no está entre los del post (ni los de la marca). Su
 * texto no se borra, pero no se aprueba hasta que el idioma vuelva.
 */
export const postLanguageExcluded = (postId: string, language: Language) =>
  new AppError(
    "POST_LANGUAGE_EXCLUDED",
    `El ${LANGUAGE_TEXT[language]} no está entre los idiomas del post: agrégalo al post (o a la marca) para aprobar su texto`,
    { details: { postId, language } },
  );
