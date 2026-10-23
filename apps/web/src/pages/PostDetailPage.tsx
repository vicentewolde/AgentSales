import type { ContentRunView, PostJson } from "@agentsales/api/contracts";
import {
  chileInputValue,
  formatChileTime,
  isAppError,
  isTerminalContentRun,
  PLATFORM_TEXT,
  type Platform,
  POST_KINDS,
  POST_PLATFORMS,
  type PostKind,
  type PostPlatform,
  parseChileTime,
  postNetworkGaps,
} from "@agentsales/core";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useBrandPlatforms } from "../components/posts/brand-platforms.js";
import { POST_KIND_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { PostMedia } from "../components/posts/PostMedia.js";
import { PostMusic } from "../components/posts/PostMusic.js";
import { PostPublications, PostPublishBar } from "../components/posts/PostPublishing.js";
import { PostTexts } from "../components/posts/PostTexts.js";
import { XLinkControl } from "../components/posts/XLinkControl.js";
import { Alert } from "../components/ui/Alert.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Field, Input, Select, Textarea } from "../components/ui/Field.js";
import { PencilIcon } from "../components/ui/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Loading, Spinner } from "../components/ui/Spinner.js";
import { cx } from "../components/ui/styles.js";
import { useHealth } from "../queries/health.js";
import {
  useArchivePost,
  useEditorialProfile,
  usePost,
  useRequestPostDraft,
  useUpdatePost,
} from "../queries/posts.js";

/** En qué va la corrida de textos, en palabras. */
function runText(run: ContentRunView): string {
  switch (run.status) {
    case "queued":
      return "Textos pedidos: en cola…";
    case "running":
      return "La IA está redactando los textos…";
    case "succeeded":
      return `Textos redactados el ${formatChileTime(run.finishedAt ?? run.createdAt)}.`;
    default:
      return `La redacción falló${run.error === null ? "" : `: ${run.error.message}`}`;
  }
}

/** Editar el tema, el brief, el tipo, el tema de la marca y la fecha planeada. */
function PostEditForm({ post, onClose }: { post: PostJson; onClose: () => void }) {
  const update = useUpdatePost(post.id);
  const profile = useEditorialProfile(post.brokerId);
  // Solo las redes de la marca (y las que el post ya tenga), como en el plan.
  const brandNetworks = useBrandPlatforms(post.brokerId);
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
    const platforms = form
      .getAll("platforms")
      .map(String)
      .flatMap((value) => POST_PLATFORMS.filter((platform) => platform === value));
    setProblem(null);
    update.mutate(
      {
        topic: text("topic"),
        // El brief solo se manda si cambió: editarlo lo deja como del operador (fuente de hechos).
        ...(text("brief") === (post.brief ?? "")
          ? {}
          : { brief: text("brief") === "" ? null : text("brief") }),
        kind: (POST_KINDS.find((kind) => kind === text("kind")) ?? post.kind) satisfies PostKind,
        pillar: text("pillar") === "" ? null : text("pillar"),
        plannedAt,
        // F9-T21: sin marcar ninguna, todas las redes de la marca.
        platforms: platforms.length === 0 ? null : platforms,
      },
      { onSuccess: onClose },
    );
  };
  const pillars = profile.data?.pillars ?? [];
  return (
    <form aria-label="Editar el post" onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      <Field label="Tema" className="md:col-span-2">
        <Input name="topic" required defaultValue={post.topic} />
      </Field>
      <Field label="Brief" className="md:col-span-2">
        <Textarea name="brief" rows={3} defaultValue={post.brief ?? ""} />
      </Field>
      <Field label="Tipo">
        <Select name="kind" defaultValue={post.kind}>
          {POST_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {POST_KIND_LABEL[kind]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Tema de la marca">
        <Select name="pillar" defaultValue={post.pillar ?? ""}>
          <option value="">sin tema</option>
          {pillars.map((pillar) => (
            <option key={pillar.key} value={pillar.key}>
              {pillar.name}
            </option>
          ))}
          {post.pillar !== null && !pillars.some((pillar) => pillar.key === post.pillar) && (
            <option value={post.pillar}>{post.pillar}</option>
          )}
        </Select>
      </Field>
      <Field label="Fecha planeada (Chile)">
        <Input
          name="plannedAt"
          type="datetime-local"
          defaultValue={post.plannedAt === null ? "" : chileInputValue(post.plannedAt)}
        />
      </Field>
      <fieldset className="text-sm text-fg md:col-span-2">
        <legend className="font-medium">Redes (sin marcar ninguna: todas las de la marca)</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {POST_PLATFORMS.filter(
            (platform) => brandNetworks.includes(platform) || post.platforms?.includes(platform),
          ).map((platform) => (
            <label key={platform} className="flex items-center gap-2">
              <input
                type="checkbox"
                name="platforms"
                value={platform}
                defaultChecked={post.platforms?.includes(platform) ?? false}
              />
              {PLATFORM_TEXT[platform]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2 md:col-span-2">
        <Button type="submit" loading={update.isPending}>
          {update.isPending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm font-medium text-danger-700 md:col-span-2">
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
        ? "Es una idea: acéptala primero en Plan."
        : running
          ? "Ya se están redactando."
          : null;
  return (
    <div className="rounded-lg border border-line bg-canvas p-4 text-sm">
      {run !== null && (
        <p
          role="status"
          className={cx(
            "mb-3 flex items-center gap-2",
            run.status === "failed" ? "font-medium text-danger-700" : "text-fg-muted",
          )}
        >
          {running && <Spinner />}
          {runText(run)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant={hasTexts ? "secondary" : "primary"}
          loading={draft.isPending}
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={() => draft.mutate(replace)}
        >
          {hasTexts ? "Pedir textos nuevos a la IA" : "Pedir los textos a la IA"}
        </Button>
        {hasTexts && (
          <label className="flex items-center gap-2 text-fg-muted">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            Reemplazar también los textos editados o aprobados
          </label>
        )}
      </div>
      {blocked !== null && <p className="mt-2 text-xs text-warning-800">{blocked}</p>}
      {draft.error && <ErrorAlert error={draft.error} />}
    </div>
  );
}

/**
 * Las redes del post y sus textos (F9-T21): las agregadas al post que todavía no tienen texto
 * (ofrece redactar) y los textos de redes que le quitaron (no se publican ni se programan; no se
 * borran). Nada si el post tiene todas las redes de la marca (`platforms = null`).
 */
function PostNetworksNotice({
  post,
  contents,
  run,
}: {
  post: PostJson;
  contents: readonly { platform: Platform }[];
  run: ContentRunView | null;
}) {
  const draft = useRequestPostDraft(post.id);
  if (post.status === "idea" || post.status === "archived") return null;
  const { missing, excluded } = postNetworkGaps({ post, contents, latestRun: run });
  if (missing.length === 0 && excluded.length === 0) return null;
  const names = (platforms: readonly PostPlatform[]) =>
    platforms.map((platform) => PLATFORM_TEXT[platform]).join(", ");
  return (
    <Alert role="status" tone="warning">
      {missing.length > 0 && (
        <div>
          <p>Falta el texto de {names(missing)}: la agregaste al post después de redactar.</p>
          <Button
            size="sm"
            className="mt-2"
            loading={draft.isPending}
            onClick={() => draft.mutate(false)}
          >
            Redactar los textos de nuevo
          </Button>
          <p className="mt-1 text-xs">
            La IA vuelve a redactar las redes del post; si editaste o aprobaste alguno, usa «Pedir
            textos nuevos a la IA» con «Reemplazar también».
          </p>
          {draft.error && <ErrorAlert error={draft.error} />}
        </div>
      )}
      {excluded.length > 0 && (
        <p className={missing.length > 0 ? "mt-2" : ""}>
          Los textos de {names(excluded)} no se publican ni se programan: esa red ya no está entre
          las del post.
        </p>
      )}
    </Alert>
  );
}

/**
 * El detalle de un post (F9-T17): sus datos, los textos por red e idioma, los medios, publicar y
 * programar, y sus publicaciones (con resolver una dudosa y confirmar una a mano).
 */
export function PostDetailPage() {
  const { id = "" } = useParams();
  const post = usePost(id);
  const health = useHealth();
  const archive = useArchivePost(id);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (post.error) return <ErrorAlert error={post.error} onRetry={() => void post.refetch()} />;
  if (post.data === undefined) return <Loading />;
  const { post: item, media, contents, latestRun, publications, uploadsInReview } = post.data;
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
      <PageHeader
        back={{ to: "/contenido", label: "Contenido" }}
        title={item.topic}
        meta={<PostStatusBadge status={item.status} />}
        description={
          <>
            <p>
              {POST_KIND_LABEL[item.kind]}
              {item.pillar !== null && ` · tema ${item.pillar}`}
              {" · "}
              {item.plannedAt === null
                ? "sin fecha planeada"
                : `planeado para el ${formatChileTime(item.plannedAt)} (hora de Chile)`}
              {item.source === "ai" && " · propuesto por la IA"}
              {" · "}
              {item.platforms === null
                ? "todas las redes de la marca"
                : `redes: ${item.platforms.map((platform) => PLATFORM_TEXT[platform]).join(", ")}`}
            </p>
            {item.planRunId !== null && (
              <p className="mt-1">
                <Link
                  to={`/plan?plan=${item.planRunId}`}
                  className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
                >
                  {item.status === "idea" ? "Acéptala o descártala en el plan" : "Ver el plan"}
                </Link>
              </p>
            )}
          </>
        }
        {...(!archived && !editing
          ? {
              actions: confirmArchive ? (
                <span role="alert" className="flex flex-wrap items-center gap-2 text-sm text-fg">
                  ¿Archivar? Ya no se edita ni se programa.
                  <Button
                    variant="danger"
                    size="sm"
                    loading={archive.isPending}
                    onClick={() =>
                      archive.mutate(undefined, { onSettled: () => setConfirmArchive(false) })
                    }
                  >
                    Sí, archivar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(false)}>
                    Cancelar
                  </Button>
                </span>
              ) : (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    <PencilIcon className="size-4" />
                    Editar el post
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                    Archivar
                  </Button>
                </>
              ),
            }
          : {})}
      />
      {item.brief !== null && (
        <div className="mb-6 rounded-xl border border-line bg-surface shadow-xs px-4 py-3">
          <p className="text-xs font-medium text-fg-subtle">Brief</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{item.brief}</p>
        </div>
      )}
      {editing && (
        <Card title="Editar el post" className="mb-6">
          <PostEditForm post={item} onClose={() => setEditing(false)} />
        </Card>
      )}
      {archive.error && <ErrorAlert error={archive.error} />}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card as="section" aria-label="Textos" title="Textos por red">
            <div className="space-y-4">
              <DraftBox post={item} run={latestRun} hasTexts={contents.length > 0} />
              <PostNetworksNotice post={item} contents={contents} run={latestRun} />
              <PostTexts
                postId={item.id}
                post={item}
                contents={contents}
                media={media}
                publications={publications}
                lockReason={lockReason}
              />
            </div>
          </Card>

          <PostMedia
            postId={item.id}
            media={media}
            lockReason={archived ? "El post está archivado." : null}
            waiting={uploadsInReview}
          />
          <PostMusic
            post={item}
            media={media}
            lockReason={archived ? "El post está archivado." : null}
          />
        </div>

        <div className="min-w-0 space-y-6">
          <XLinkControl
            post={item}
            contents={contents}
            lockReason={archived ? "El post está archivado." : null}
          />

          <Card as="section" aria-label="Publicar" title="Publicar y programar">
            <PostPublishBar
              post={item}
              postId={item.id}
              contents={contents}
              publications={publications}
              publishMode={publishMode}
              lockReason={lockReason}
            />
          </Card>

          <Card as="section" aria-label="Publicaciones" title="Publicaciones">
            <PostPublications
              postId={item.id}
              publications={publications}
              publishMode={publishMode}
              contents={contents}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
