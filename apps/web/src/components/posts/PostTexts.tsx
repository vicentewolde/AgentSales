import type { ContentView, PostMediaItem, PublicationView } from "@agentsales/api/contracts";
import {
  CONTENT_STATUS_TEXT,
  hasContentErrors,
  joinedPostText,
  LANGUAGE_TEXT,
  linksIn,
  PLATFORM_TEXT,
  type PostPlatform,
  postTextLength,
  X_LINK_POST_COST_USD,
} from "@agentsales/core";
import { useId, useState } from "react";
import { useEditPostContent, usePostApproval } from "../../queries/posts.js";
import { Checks } from "../content/Checks.js";
import { parseHashtags } from "../content/editor.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { editBlockedReason, unapproveBlockedReason } from "../publications/publications.js";
import { type PostContentView, postContents } from "./labels.js";

const FIELD =
  "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none";
const SECONDARY =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

/** El nombre de una pestaña: la red y el idioma. */
export const tabName = (content: Pick<ContentView, "platform" | "language">) =>
  `${PLATFORM_TEXT[content.platform]} · ${LANGUAGE_TEXT[content.language]}`;

/**
 * El largo como lo cuenta la red (`postTextLength`, la misma función de la revisión): X ponderado
 * (enlace 23, emoji 2), LinkedIn con sus escapes, Discord con las menciones neutralizadas.
 */
export function PostCounter({
  platform,
  body,
  hashtags,
  id,
}: {
  platform: PostPlatform;
  body: string;
  hashtags: readonly string[];
  id?: string;
}) {
  const { length, max } = postTextLength(platform, { body: body.trim(), hashtags });
  const over = length > max;
  return (
    <p id={id} className={`text-xs ${over ? "font-semibold text-red-700" : "text-slate-500"}`}>
      {length} / {max} caracteres
      {platform === "x" && " (conteo de X: un enlace cuenta 23 y un emoji 2)"}
      {over ? ` · se pasa por ${length - max}` : ""}
    </p>
  );
}

/** El aviso del costo de un enlace en X (`x.md` §2): ese post cuesta más. */
function XLinkNote({ platform, text }: { platform: PostPlatform; text: string }) {
  if (platform !== "x" || linksIn(text).length === 0) return null;
  return (
    <p className="text-xs text-amber-800">
      Lleva un enlace: en X ese post cuesta US${X_LINK_POST_COST_USD.toFixed(2).replace(".", ",")}{" "}
      en vez del precio normal.
    </p>
  );
}

/** Lo que se publicaría: el texto con los hashtags y los medios del post, como lo verá la red. */
function Preview({ content, media }: { content: ContentView; media: readonly PostMediaItem[] }) {
  const text = joinedPostText(content);
  const shown = media.slice(0, content.platform === "x" ? 4 : 10);
  return (
    <figure
      aria-label={`Vista previa de ${tabName(content)}`}
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <figcaption className="text-xs font-semibold text-slate-500">
        Vista previa · {PLATFORM_TEXT[content.platform]}
      </figcaption>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{text}</p>
      {shown.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {shown.map((item) => (
            <li key={item.id}>
              {item.thumbUrl !== null ? (
                <img
                  src={item.thumbUrl}
                  alt=""
                  className="h-16 w-16 rounded border border-slate-200 object-cover"
                />
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded border border-slate-200 bg-slate-100 text-xs text-slate-500">
                  {item.kind === "video" ? "video" : "foto"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** El formulario de edición de un texto: cuerpo, hashtags y el conteo de la red mientras se escribe. */
function Editor({
  postId,
  content,
  onClose,
}: {
  postId: string;
  content: PostContentView;
  onClose: () => void;
}) {
  const ids = useId();
  const { platform } = content;
  const [body, setBody] = useState(content.body);
  const [hashtags, setHashtags] = useState(content.hashtags.join(" "));
  const save = useEditPostContent(postId);
  const tags = parseHashtags(hashtags);
  const changed = body.trim() !== content.body || tags.join(" ") !== content.hashtags.join(" ");
  const blank = body.trim() === "";
  return (
    <form
      aria-label={`Editar el texto de ${tabName(content)}`}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(
          {
            platform,
            language: content.language,
            edit: { body: body.trim(), hashtags: tags },
          },
          { onSuccess: onClose },
        );
      }}
    >
      <label className="block text-sm font-medium text-slate-700">
        Texto
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={8}
          aria-describedby={`${ids}-counter`}
          aria-invalid={blank}
          className={FIELD}
        />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Hashtags
        <input
          value={hashtags}
          onChange={(event) => setHashtags(event.target.value)}
          placeholder="#bastidores #producto"
          className={FIELD}
        />
      </label>
      <PostCounter platform={platform} body={body} hashtags={tags} id={`${ids}-counter`} />
      <XLinkNote platform={platform} text={body} />
      {blank && <p className="text-xs text-red-700">El texto no puede quedar vacío.</p>}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY} disabled={save.isPending || !changed || blank}>
          {save.isPending ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" className={SECONDARY} disabled={save.isPending} onClick={onClose}>
          Cancelar
        </button>
      </div>
      {save.error && <ErrorAlert error={save.error} />}
    </form>
  );
}

/** Una pestaña: el texto de una red e idioma con su conteo, vista previa, revisión y aprobación. */
function TextTab({
  postId,
  content,
  media,
  publications,
  lockReason,
}: {
  postId: string;
  content: PostContentView;
  media: readonly PostMediaItem[];
  publications: readonly PublicationView[];
  lockReason: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const approval = usePostApproval(postId);
  const { platform } = content;
  const editBlocked = lockReason ?? editBlockedReason(content, publications);
  const approved = content.status === "approved";
  const approveBlocked =
    lockReason ??
    (hasContentErrors(content.checks)
      ? "La revisión tiene errores: corrígelos para poder aprobar."
      : null);
  const unapproveBlocked = lockReason ?? unapproveBlockedReason(content, publications);
  const blocked = approved ? unapproveBlocked : approveBlocked;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Texto: {CONTENT_STATUS_TEXT[content.status]}
          {content.status === "edited" ? "" : ` · ${content.promptVersion}`}
        </p>
        <div className="flex flex-wrap gap-2">
          {!editing && (
            <button
              type="button"
              className={SECONDARY}
              disabled={editBlocked !== null}
              title={editBlocked ?? undefined}
              onClick={() => setEditing(true)}
            >
              Editar
            </button>
          )}
          <button
            type="button"
            className={approved ? SECONDARY : PRIMARY}
            disabled={approval.isPending || blocked !== null || editing}
            title={blocked ?? undefined}
            onClick={() =>
              approval.mutate({ platform, language: content.language, approve: !approved })
            }
          >
            {approved ? "Quitar la aprobación" : "Aprobar"}
          </button>
        </div>
      </div>
      {blocked !== null && !editing && <p className="text-xs text-amber-800">{blocked}</p>}
      {editing ? (
        <Editor postId={postId} content={content} onClose={() => setEditing(false)} />
      ) : (
        <>
          <PostCounter platform={platform} body={content.body} hashtags={content.hashtags} />
          <XLinkNote platform={platform} text={content.body} />
          <Preview content={content} media={media} />
        </>
      )}
      <Checks content={content} />
      {approval.error && <ErrorAlert error={approval.error} />}
    </div>
  );
}

/**
 * Los textos del post: una pestaña por red e idioma (en el orden de la API), con el texto editable,
 * el conteo de la red, una vista previa simple, la revisión con su consejo y aprobar o quitar la
 * aprobación. `lockReason` bloquea todo mientras la IA redacta o si el post está archivado.
 */
export function PostTexts({
  postId,
  contents,
  media,
  publications,
  lockReason,
}: {
  postId: string;
  contents: readonly ContentView[];
  media: readonly PostMediaItem[];
  publications: readonly PublicationView[];
  lockReason: string | null;
}) {
  const ids = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const texts = postContents(contents);
  if (texts.length === 0) {
    return <p className="text-sm text-slate-600">Todavía no hay textos: pídelos a la IA.</p>;
  }
  const current =
    texts.find((content) => `${content.platform}:${content.language}` === selected) ?? texts[0];
  if (current === undefined) return null;
  const keyOf = (content: ContentView) => `${content.platform}:${content.language}`;
  return (
    <div>
      <div role="tablist" aria-label="Textos por red e idioma" className="flex flex-wrap gap-1">
        {texts.map((content) => {
          const active = keyOf(content) === keyOf(current);
          return (
            <button
              key={keyOf(content)}
              type="button"
              role="tab"
              id={`${ids}-${keyOf(content)}`}
              aria-selected={active}
              aria-controls={`${ids}-panel`}
              onClick={() => setSelected(keyOf(content))}
              className={`rounded-t-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-slate-300 border-b-white bg-white font-semibold"
                  : "border-transparent text-slate-600 hover:bg-slate-100"
              }`}
            >
              {tabName(content)}
              {content.status === "approved" && <span aria-hidden="true"> ✓</span>}
              {hasContentErrors(content.checks) && <span aria-hidden="true"> !</span>}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-${keyOf(current)}`}
        className="rounded-b-lg rounded-tr-lg border border-slate-300 bg-slate-50 p-4"
      >
        <TextTab
          key={current.id}
          postId={postId}
          content={current}
          media={media}
          publications={publications}
          lockReason={lockReason}
        />
      </div>
    </div>
  );
}
