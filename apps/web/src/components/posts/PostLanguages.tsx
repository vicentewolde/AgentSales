import type { ContentView, PostJson } from "@agentsales/api/contracts";
import { LANGUAGE_TEXT, LANGUAGES, type Language, PLATFORM_TEXT } from "@agentsales/core";

// «Idiomas de este post» (2026-11-15): los idiomas en que escribe un post, por defecto los de la
// marca. Un idioma quitado no se redacta y sus textos sin aprobar se ocultan (no se borran).

const LANGUAGE_NAME: Readonly<Record<Language, string>> = { es: "Español", en: "Inglés" };

/**
 * Las casillas del formulario de editar el post (`name="languages"`): marcadas, las que el post usa
 * hoy (las suyas o las de la marca).
 */
export function PostLanguagesField({
  post,
  brandLanguages,
}: {
  post: Pick<PostJson, "languages">;
  brandLanguages: readonly Language[] | undefined;
}) {
  const current = post.languages ?? brandLanguages ?? ["es"];
  return (
    <fieldset className="text-sm text-fg md:col-span-2">
      <legend className="font-medium">Idiomas de este post</legend>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        {LANGUAGES.map((language) => (
          <label key={language} className="flex items-center gap-2">
            <input
              type="checkbox"
              name="languages"
              value={language}
              defaultChecked={current.includes(language)}
            />
            {LANGUAGE_NAME[language]}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        Por defecto, los de la marca
        {brandLanguages === undefined
          ? ""
          : ` (${brandLanguages.map((language) => LANGUAGE_TEXT[language]).join(" y ")})`}
        . Un idioma sin marcar no se redacta y sus textos sin aprobar se ocultan; vuelven si lo
        marcas de nuevo.
      </p>
    </fieldset>
  );
}

/**
 * Lo que se manda al guardar: `null` (los de la marca) si lo marcado es igual a los de la marca o
 * no se marcó nada; si no, lo marcado.
 */
export function postLanguagesValue(
  form: FormData,
  brandLanguages: readonly Language[] | undefined,
): Language[] | null {
  const checked = form
    .getAll("languages")
    .map(String)
    .flatMap((value) => LANGUAGES.filter((language) => language === value));
  if (checked.length === 0) return null;
  const brand = brandLanguages ?? ["es"];
  const same = checked.length === brand.length && checked.every((item) => brand.includes(item));
  return same ? null : checked;
}

/**
 * El aviso de los textos de un idioma que el post ya no usa: los ocultos (sin aprobar) y los
 * aprobados que se mantienen. Nada si no hay ninguno.
 */
export function PostLanguagesNotice({
  languages,
  hiddenTexts,
  contents,
}: {
  languages: readonly Language[] | null;
  hiddenTexts: number;
  contents: readonly Pick<ContentView, "platform" | "language">[];
}) {
  const kept =
    languages === null ? [] : contents.filter((content) => !languages.includes(content.language));
  if (hiddenTexts === 0 && kept.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-line bg-sand px-3 py-2 text-sm">
      {hiddenTexts > 0 && (
        <p className="text-fg-muted">
          {hiddenTexts === 1 ? "1 texto oculto" : `${hiddenTexts} textos ocultos`} de un idioma que
          este post ya no usa: no se borra{hiddenTexts === 1 ? "" : "n"} y vuelve
          {hiddenTexts === 1 ? "" : "n"} si marcas el idioma en «Idiomas de este post».
        </p>
      )}
      {kept.length > 0 && (
        <p className="text-fg-muted">
          Aprobado antes de quitar su idioma, se mantiene:{" "}
          {kept
            .map(
              (content) =>
                `${PLATFORM_TEXT[content.platform]} en ${LANGUAGE_TEXT[content.language]}`,
            )
            .join(", ")}
          .
        </p>
      )}
    </div>
  );
}
