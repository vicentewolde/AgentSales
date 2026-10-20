import type { ContentRunView, PostJson } from "@agentsales/api/contracts";
import {
  chileInputValue,
  formatChileTime,
  isAppError,
  isTerminalContentRun,
  POST_KINDS,
  type PostKind,
  parseChileTime,
} from "@agentsales/core";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { POST_KIND_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { PostMedia } from "../components/posts/PostMedia.js";
import { PostPublications, PostPublishBar } from "../components/posts/PostPublishing.js";
import { PostTexts } from "../components/posts/PostTexts.js";
import { useHealth } from "../queries/health.js";
import {
  useArchivePost,
  useEditorialProfile,
  usePost,
  useRequestPostDraft,
  useUpdatePost,
} from "../queries/posts.js";

const FIELD = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";
const SECONDARY =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

/** En qué va la corrida de textos, en palabras. */
function runText(run: ContentRunView): string {
  switch (run.status) {
    case "queued":
      return "Textos pedidos: esperando al worker…";
    case "running":
      return "La IA está redactando los textos…";
    case "succeeded":
      return `Textos redactados el ${formatChileTime(run.finishedAt ?? run.createdAt)}.`;
    default:
      return `La redacción falló${run.error === null ? "" : `: ${run.error.message}`}`;
  }
}

/** Editar el tema, el brief, el tipo, la línea y la fecha planeada. */
function PostEditForm({ post, onClose }: { post: PostJson; onClose: () => void }) {
  const update = useUpdatePost(post.id);
  const profile = useEditorialProfile(post.brokerId);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    let plannedAt: Date | null = null;
    if (text("plannedAt") !== "") {
      try {
        plannedAt = parseChileTime(text("plannedAt"));
      } catch (error) {
        setProblem(isAppError(error) ? error.message : String(error));
        return;
      }
    }
    setProblem(null);
    update.mutate(
      {
        topic: text("topic"),
        brief: text("brief") === "" ? null : text("brief"),
        kind: (POST_KINDS.find((kind) => kind === text("kind")) ?? post.kind) satisfies PostKind,
        pillar: text("pillar") === "" ? null : text("pillar"),
        plannedAt,
      },
      { onSuccess: onClose },
    );
  };
  const pillars = profile.data?.pillars ?? [];
  return (
    <form aria-label="Editar el post" onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-2">
      <label className="block text-sm font-medium text-slate-700 md:col-span-2">
        Tema
        <input name="topic" required defaultValue={post.topic} className={FIELD} />
      </label>
      <label className="block text-sm font-medium text-slate-700 md:col-span-2">
        Brief
        <textarea name="brief" rows={3} defaultValue={post.brief ?? ""} className={FIELD} />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Tipo
        <select name="kind" defaultValue={post.kind} className={FIELD}>
          {POST_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {POST_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Línea de contenido
        <select name="pillar" defaultValue={post.pillar ?? ""} className={FIELD}>
          <option value="">sin línea</option>
          {pillars.map((pillar) => (
            <option key={pillar.key} value={pillar.key}>
              {pillar.name}
            </option>
          ))}
          {post.pillar !== null && !pillars.some((pillar) => pillar.key === post.pillar) && (
            <option value={post.pillar}>{post.pillar}</option>
          )}
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Fecha planeada (Chile)
        <input
          name="plannedAt"
          type="datetime-local"
          defaultValue={post.plannedAt === null ? "" : chileInputValue(post.plannedAt)}
          className={FIELD}
        />
      </label>
      <div className="flex gap-2 md:col-span-2">
        <button type="submit" className={PRIMARY} disabled={update.isPending}>
          {update.isPending ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" className={SECONDARY} onClick={onClose}>
          Cancelar
        </button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-red-700 md:col-span-2">
          {problem}
        </p>
      )}
      {update.error && (
        <div className="md:col-span-2">
          <ErrorAlert error={update.error} />
        </div>
      )}
    </form>
  );
}

/** Pedir los textos a la IA, con la opción de reemplazar también los editados o aprobados. */
function DraftBox({
  post,
  run,
  hasTexts,
}: {
  post: PostJson;
  run: ContentRunView | null;
  hasTexts: boolean;
}) {
  const draft = useRequestPostDraft(post.id);
  const [replace, setReplace] = useState(false);
  const running = run !== null && !isTerminalContentRun(run.status);
  const blocked =
    post.status === "archived"
      ? "El post está archivado."
      : post.status === "idea"
        ? "Es una idea: acéptala primero (Plan)."
        : running
          ? "Ya se están redactando."
          : null;
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
      {run !== null && (
        <p role="status" className={run.status === "failed" ? "text-red-700" : "text-slate-700"}>
          {runText(run)}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={draft.isPending || blocked !== null}
          title={blocked ?? undefined}
          onClick={() => draft.mutate(replace)}
        >
          {hasTexts ? "Pedir textos nuevos a la IA" : "Pedir los textos a la IA"}
        </button>
        {hasTexts && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            Reemplazar también los textos editados o aprobados
          </label>
        )}
      </div>
      {blocked !== null && <p className="mt-1 text-xs text-amber-800">{blocked}</p>}
      {draft.error && <ErrorAlert error={draft.error} />}
    </div>
  );
}

/**
 * El detalle de un post (F9-T17): sus datos, los textos por red e idioma, los medios, publicar y
 * programar, y sus publicaciones (con resolver una dudosa y confirmar una a mano).
 */
export function PostDetailPage() {
  const { id = "" } = useParams();
  // Los archivos grandes que el worker todavía revisa (F9-T17): cuántos y sobre cuántos medios.
  const [big, setBig] = useState<{ count: number; baseline: number } | null>(null);
  const waitingOf = (mediaCount: number) =>
    big === null ? 0 : Math.max(0, big.baseline + big.count - mediaCount);
  const post = usePost(id, (detail) => waitingOf(detail.media.length));
  const health = useHealth();
  const archive = useArchivePost(id);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (post.error) return <ErrorAlert error={post.error} onRetry={() => void post.refetch()} />;
  if (post.data === undefined) return <p className="text-slate-600">Cargando…</p>;
  const { post: item, media, contents, latestRun, publications } = post.data;
  const waiting = waitingOf(media.length);
  const publishMode = health.data?.publishMode;
  const archived = item.status === "archived";
  const runActive = latestRun !== null && !isTerminalContentRun(latestRun.status);
  const lockReason = archived
    ? "El post está archivado."
    : runActive
      ? "La IA está redactando los textos: espera a que termine."
      : null;
  return (
    <div>
      <p className="text-sm">
        <Link to="/contenido" className="underline">
          ← Contenido
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{item.topic}</h1>
        <PostStatusBadge status={item.status} />
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {POST_KIND_LABEL[item.kind]}
        {item.pillar !== null && ` · línea ${item.pillar}`}
        {" · "}
        {item.plannedAt === null
          ? "sin fecha planeada"
          : `planeado para el ${formatChileTime(item.plannedAt)} (hora de Chile)`}
        {item.source === "ai" && " · propuesto por la IA"}
      </p>
      {item.brief !== null && (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm text-slate-800">
          {item.brief}
        </p>
      )}
      {!archived && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={SECONDARY} onClick={() => setEditing(true)}>
            Editar el post
          </button>
          {confirmArchive ? (
            <span role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              ¿Archivar? Ya no se edita ni se programa.
              <button
                type="button"
                className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                disabled={archive.isPending}
                onClick={() =>
                  archive.mutate(undefined, { onSettled: () => setConfirmArchive(false) })
                }
              >
                Sí, archivar
              </button>
              <button type="button" className="underline" onClick={() => setConfirmArchive(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button type="button" className={SECONDARY} onClick={() => setConfirmArchive(true)}>
              Archivar
            </button>
          )}
        </div>
      )}
      {editing && <PostEditForm post={item} onClose={() => setEditing(false)} />}
      {archive.error && <ErrorAlert error={archive.error} />}

      <section aria-label="Textos" className="mt-6 space-y-3">
        <h2 className="text-lg font-semibold">Textos por red</h2>
        <DraftBox post={item} run={latestRun} hasTexts={contents.length > 0} />
        <PostTexts
          postId={item.id}
          contents={contents}
          media={media}
          publications={publications}
          lockReason={lockReason}
        />
      </section>

      <PostMedia
        postId={item.id}
        media={media}
        lockReason={archived ? "El post está archivado." : null}
        waiting={waiting}
        onBigUploaded={(count) => setBig({ count: waiting + count, baseline: media.length })}
      />

      <section aria-label="Publicar" className="mt-6 space-y-3">
        <h2 className="text-lg font-semibold">Publicar y programar</h2>
        <PostPublishBar
          postId={item.id}
          contents={contents}
          publishMode={publishMode}
          lockReason={lockReason}
        />
      </section>

      <section aria-label="Publicaciones" className="mt-6 space-y-3">
        <h2 className="text-lg font-semibold">Publicaciones</h2>
        <PostPublications postId={item.id} publications={publications} publishMode={publishMode} />
      </section>
    </div>
  );
}
