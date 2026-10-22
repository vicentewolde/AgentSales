import type {
  ContentView,
  PostJson,
  PostMediaItem,
  PublicationView,
} from "@agentsales/api/contracts";
import {
  CONTENT_STATUS_TEXT,
  hasContentErrors,
  LANGUAGE_TEXT,
  linksIn,
  PLATFORM_TEXT,
  type PostPlatform,
  postPublishesOn,
  postTextLength,
} from "@agentsales/core";
import { useEffect, useId, useRef, useState } from "react";
import { useEditPostContent, usePostApproval } from "../../queries/posts.js";
import { Checks } from "../content/Checks.js";
import { parseHashtags } from "../content/editor.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { useAccountName } from "../preview/account-name.js";
import { PostPreview } from "../preview/PostPreview.js";
import { draftDiffers, type PreviewText } from "../preview/preview.js";
import { editBlockedReason, unapproveBlockedReason } from "../publications/publications.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Textarea } from "../ui/Field.js";
import { type PostContentView, postContents } from "./labels.js";
import { needsXLinkMark, X_LINK_COST_TEXT } from "./XLinkControl.js";

/** Lo que los textos necesitan del post: sus redes, la marca del enlace en X, su tipo y su marca. */
type PostTextsPost = Pick<PostJson, "platforms" | "xLinkAllowed" | "kind" | "brokerId">;

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
    <p
      id={id}
      className={`text-xs tabular-nums ${over ? "font-semibold text-danger-700" : "text-fg-subtle"}`}
    >
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
    <p className="text-xs text-warning-800">
      Lleva un enlace: en X ese post cuesta {X_LINK_COST_TEXT}.
    </p>
  );
}

/**
 * El formulario de edición de un texto: cuerpo, hashtags y el conteo de la red mientras se escribe.
 * Cada cambio se avisa a la vista previa (`onDraft`, F9.5-T07), y al cerrar, `null`.
 */
function Editor({
  postId,
  content,
  onClose,
  onDraft,
}: {
  postId: string;
  content: PostContentView;
  onClose: () => void;
  onDraft: (draft: PreviewText | null) => void;
}) {
  const ids = useId();
  const { platform } = content;
  const [body, setBody] = useState(content.body);
  const [hashtags, setHashtags] = useState(content.hashtags.join(" "));
  const save = useEditPostContent(postId);
  const draftOf = (next: { body: string; hashtags: string }): PreviewText => ({
    title: content.title,
    body: next.body.trim(),
    hashtags: parseHashtags(next.hashtags),
  });
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const firstDraft = useRef(draftOf({ body, hashtags }));
  useEffect(() => {
    onDraftRef.current(firstDraft.current);
    return () => onDraftRef.current(null);
  }, []);
  const changeBody = (value: string) => {
    setBody(value);
    onDraft(draftOf({ body: value, hashtags }));
  };
  const changeHashtags = (value: string) => {
    setHashtags(value);
    onDraft(draftOf({ body, hashtags: value }));
  };
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
      <Field label="Texto">
        <Textarea
          value={body}
          onChange={(event) => changeBody(event.target.value)}
          rows={8}
          aria-describedby={`${ids}-counter`}
          aria-invalid={blank}
        />
      </Field>
      <Field label="Hashtags">
        <Input
          value={hashtags}
          onChange={(event) => changeHashtags(event.target.value)}
          placeholder="#bastidores #producto"
        />
      </Field>
      <PostCounter platform={platform} body={body} hashtags={tags} id={`${ids}-counter`} />
      <XLinkNote platform={platform} text={body} />
      {blank && (
        <p className="text-xs font-medium text-danger-700">El texto no puede quedar vacío.</p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={save.isPending} disabled={!changed || blank}>
          {save.isPending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="secondary" size="sm" disabled={save.isPending} onClick={onClose}>
          Cancelar
        </Button>
      </div>
      {save.error && <ErrorAlert error={save.error} />}
    </form>
  );
}

/** Una pestaña: el texto de una red e idioma con su conteo, vista previa, revisión y aprobación. */
function TextTab({
  postId,
  post,
  content,
  media,
  publications,
  lockReason,
}: {
  postId: string;
  /**
   * Sus redes (`platforms`): el texto de una red quitada no se aprueba (F9-T21); la marca del
   * enlace en X (`xLinkAllowed`, F9-T16); y, para la vista previa, su tipo y su marca (F9.5-T07).
   */
  post: PostTextsPost;
  content: PostContentView;
  media: readonly PostMediaItem[];
  publications: readonly PublicationView[];
  lockReason: string | null;
}) {
  const [editing, setEditing] = useState(false);
  // La vista previa sigue al borrador mientras se edita (F9.5-T07).
  const [draft, setDraft] = useState<PreviewText | null>(null);
  const accountName = useAccountName(post.brokerId, content.platform);
  const approval = usePostApproval(postId);
  const { platform } = content;
  const editBlocked = lockReason ?? editBlockedReason(content, publications);
  const approved = content.status === "approved";
  const approveBlocked =
    lockReason ??
    // F9-T21: el texto de una red que se le quitó al post no se aprueba.
    (!postPublishesOn(post, platform)
      ? `${PLATFORM_TEXT[platform]} ya no está entre las redes del post: agrégala con «Editar el post» para aprobar este texto.`
      : needsXLinkMark(post, content)
        ? "Lleva un enlace y el post no lo permite en X: marca «Permitir un enlace en X» o quita el enlace."
        : hasContentErrors(content.checks)
          ? "La revisión tiene errores: corrígelos para poder aprobar."
          : null);
  const unapproveBlocked = lockReason ?? unapproveBlockedReason(content, publications);
  const blocked = approved ? unapproveBlocked : approveBlocked;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-subtle">
          Texto: {CONTENT_STATUS_TEXT[content.status]}
          {content.status === "edited" ? "" : ` · ${content.promptVersion}`}
        </p>
        <div className="flex flex-wrap gap-2">
          {!editing && (
            <Button
              variant="secondary"
              size="sm"
              disabled={editBlocked !== null}
              title={editBlocked ?? undefined}
              onClick={() => setEditing(true)}
            >
              Editar
            </Button>
          )}
          <Button
            variant={approved ? "secondary" : "primary"}
            size="sm"
            disabled={approval.isPending || blocked !== null || editing}
            title={blocked ?? undefined}
            onClick={() =>
              approval.mutate({ platform, language: content.language, approve: !approved })
            }
          >
            {approved ? "Quitar la aprobación" : "Aprobar"}
          </Button>
        </div>
      </div>
      {blocked !== null && !editing && <p className="text-xs text-warning-800">{blocked}</p>}
      {editing ? (
        <Editor
          postId={postId}
          content={content}
          onClose={() => setEditing(false)}
          onDraft={setDraft}
        />
      ) : (
        <>
          <PostCounter platform={platform} body={content.body} hashtags={content.hashtags} />
          <XLinkNote platform={platform} text={content.body} />
        </>
      )}
      <PostPreview
        label={`Vista previa de ${tabName(content)}`}
        platform={platform}
        kind={post.kind}
        media={media}
        text={draft ?? content}
        accountName={accountName}
        draft={draftDiffers(draft, content)}
      />
      <Checks content={content} />
      {approval.error && <ErrorAlert error={approval.error} />}
    </div>
  );
}

/**
 * Los textos del post: una pestaña por red e idioma (en el orden de la API), con el texto editable,
 * el conteo de la red, la vista previa con la forma de la red, la revisión con su consejo y aprobar o quitar la
 * aprobación. `lockReason` bloquea todo mientras la IA redacta o si el post está archivado.
 */
export function PostTexts({
  postId,
  post,
  contents,
  media,
  publications,
  lockReason,
}: {
  postId: string;
  post: PostTextsPost;
  contents: readonly ContentView[];
  media: readonly PostMediaItem[];
  publications: readonly PublicationView[];
  lockReason: string | null;
}) {
  const ids = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const texts = postContents(contents);
  if (texts.length === 0) {
    return <p className="text-sm text-fg-muted">Todavía no hay textos: pídelos a la IA.</p>;
  }
  const current =
    texts.find((content) => `${content.platform}:${content.language}` === selected) ?? texts[0];
  if (current === undefined) return null;
  const keyOf = (content: ContentView) => `${content.platform}:${content.language}`;
  return (
    <div>
      <div
        role="tablist"
        aria-label="Textos por red e idioma"
        className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1"
      >
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
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-surface font-semibold text-fg shadow-xs ring-1 ring-line"
                  : "font-medium text-fg-muted hover:text-fg"
              }`}
            >
              {tabName(content)}
              {content.status === "approved" && (
                <span aria-hidden="true" className="text-success-600">
                  {" "}
                  ✓
                </span>
              )}
              {hasContentErrors(content.checks) && (
                <span aria-hidden="true" className="font-bold text-danger-600">
                  {" "}
                  !
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-${keyOf(current)}`}
        className="mt-3 rounded-lg border border-line bg-slate-50/60 p-4"
      >
        <TextTab
          key={current.id}
          postId={postId}
          post={post}
          content={current}
          media={media}
          publications={publications}
          lockReason={lockReason}
        />
      </div>
    </div>
  );
}
