import type {
  ContentRunView,
  PostDetailResponse,
  PostDraftingView,
  PostJson,
  PostResponse,
  PostScheduleResponse,
} from "@agentsales/api/contracts";
import {
  chileInputValue,
  formatChileDayTime,
  isAppError,
  isTerminalContentRun,
  LANGUAGE_TEXT,
  PENDING_PUBLICATION_STATUSES,
  PLATFORM_TEXT,
  type Platform,
  POST_KINDS,
  POST_PLATFORMS,
  type PostKind,
  type PostPlatform,
  PUBLICATION_STATUS_TEXT,
  type PublishMode,
  parseChileTime,
  postKindIssues,
  postNetworkGaps,
  rescheduleSuggestion,
} from "@agentsales/core";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useBrandPlatforms } from "../components/posts/brand-platforms.js";
import { LiveConfirmButton } from "../components/posts/LiveConfirm.js";
import { POST_KIND_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { PostMedia } from "../components/posts/PostMedia.js";
import { PostMusic } from "../components/posts/PostMusic.js";
import { PostPublications, PostPublishBar } from "../components/posts/PostPublishing.js";
import { PostSummary } from "../components/posts/PostSummary.js";
import { PostTexts } from "../components/posts/PostTexts.js";
import { RecordExternal } from "../components/posts/RecordExternal.js";
import { XLinkControl } from "../components/posts/XLinkControl.js";
import { Alert } from "../components/ui/Alert.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Field, Input, Select, Textarea } from "../components/ui/Field.js";
import { PencilIcon } from "../components/ui/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Loading, Spinner } from "../components/ui/Spinner.js";
import { cx } from "../components/ui/styles.js";
import { useBrokerModeOf } from "../queries/brokers.js";
import { SubjectBrokerContext } from "../queries/health.js";
import {
  useArchivePost,
  useEditorialProfile,
  usePost,
  usePostPublicationAction,
  useRequestPostDraft,
  useSchedulePost,
  useUpdatePost,
} from "../queries/posts.js";

/** Las redes, en palabras: «LinkedIn» o «X y LinkedIn». */
const networkNames = (platforms: readonly Platform[]) => {
  const names = platforms.map((platform) => PLATFORM_TEXT[platform]);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
};

/** De qué textos es una corrida acotada: «LinkedIn» o «X · español». */
function scopeText(scope: NonNullable<ContentRunView["scope"]>): string {
  const names = networkNames(scope.platforms);
  return scope.language === null ? names : `${names} · ${LANGUAGE_TEXT[scope.language]}`;
}

/** En qué va la corrida de textos, en palabras. */
function runText(run: ContentRunView): string {
  const scope = run.scope;
  if (scope !== null) {
    const what = scopeText(scope);
    switch (run.status) {
      case "queued":
      case "running":
        return scope.mode === "missing"
          ? `Redactando el texto de ${what}…`
          : `Rehaciendo el texto de ${what}…`;
      case "succeeded":
        return `Texto de ${what} redactado el ${formatChileDayTime(run.finishedAt ?? run.createdAt)}.`;
      default:
        return `La redacción del texto de ${what} falló${run.error === null ? "" : `: ${run.error.message}`}`;
    }
  }
  switch (run.status) {
    case "queued":
      return "Textos pedidos: en cola…";
    case "running":
      return "La IA está redactando los textos…";
    case "succeeded":
      return `Textos redactados el ${formatChileDayTime(run.finishedAt ?? run.createdAt)}.`;
    default:
      return `La redacción falló${run.error === null ? "" : `: ${run.error.message}`}`;
  }
}

/** Las publicaciones que el panel puede cancelar al quitar una red (las demás se resuelven antes). */
const CANCELLABLE = new Set(["approved", "scheduled", "failed"]);

/**
 * Quitar una red del post (F9-T21): si tiene publicaciones pendientes, se avisa antes de guardar
 * cuáles lo impiden y se ofrece cancelarlas ahí mismo, con confirmación. Las que se están
 * publicando, esperan tu clic o tienen resultado dudoso se resuelven primero en «Publicaciones».
 */
function PendingRemoval({
  postId,
  blocking,
}: {
  postId: string;
  blocking: PostDetailResponse["publications"];
}) {
  const action = usePostPublicationAction(postId);
  const [confirming, setConfirming] = useState(false);
  const cancellable = blocking.filter((publication) => CANCELLABLE.has(publication.status));
  const stuck = blocking.filter((publication) => !CANCELLABLE.has(publication.status));
  const cancelAll = async () => {
    try {
      for (const publication of cancellable) {
        await action.mutateAsync({ kind: "cancel", id: publication.id });
      }
      setConfirming(false);
    } catch {
      // El error queda en `action.error`.
    }
  };
  const names = networkNames([...new Set(blocking.map((publication) => publication.platform))]);
  return (
    <div
      role="status"
      className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm md:col-span-2"
    >
      <p className="font-medium text-warning-800">
        Para quitar {names} del post, primero hay que cancelar sus publicaciones pendientes:
      </p>
      <ul className="mt-1 list-disc pl-5 text-fg">
        {blocking.map((publication) => (
          <li key={publication.id}>
            {PLATFORM_TEXT[publication.platform]} · {LANGUAGE_TEXT[publication.language]}:{" "}
            {PUBLICATION_STATUS_TEXT[publication.status]}
            {publication.scheduledAt !== null &&
              ` para el ${formatChileDayTime(publication.scheduledAt)}`}
          </li>
        ))}
      </ul>
      {stuck.length > 0 && (
        <p className="mt-2 text-warning-800">
          {stuck.length === 1
            ? "Una se está publicando, espera tu clic o tiene resultado dudoso"
            : `${stuck.length} se están publicando, esperan tu clic o tienen resultado dudoso`}
          : resuélvela{stuck.length === 1 ? "" : "s"} primero en «Publicaciones».
        </p>
      )}
      {cancellable.length > 0 &&
        (confirming ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-fg">
              ¿Cancelar{" "}
              {cancellable.length === 1
                ? "esa publicación"
                : `esas ${cancellable.length} publicaciones`}
              ? No se publicarán.
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={action.isPending}
              onClick={() => void cancelAll()}
            >
              Sí, cancelarlas
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              No
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => setConfirming(true)}
          >
            {cancellable.length === 1 ? "Cancelarla" : `Cancelar las ${cancellable.length}`}
          </Button>
        ))}
      {action.error && <ErrorAlert error={action.error} />}
    </div>
  );
}

/**
 * Editar el tema, el brief, el tipo, la línea editorial, la fecha planeada y las redes. Al guardar,
 * `onSaved` recibe lo guardado (con lo que la IA empezó a redactar, si se agregó una red).
 */
function PostEditForm({
  post,
  contents,
  publications,
  onClose,
  onSaved,
}: {
  post: PostJson;
  contents: readonly { platform: Platform }[];
  publications: PostDetailResponse["publications"];
  onClose: () => void;
  onSaved: (saved: PostResponse) => void;
}) {
  const update = useUpdatePost(post.id);
  const profile = useEditorialProfile(post.brokerId);
  // Solo las redes de la marca (y las que el post ya tenga), como en el plan.
  const brandNetworks = useBrandPlatforms(post.brokerId);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<PostPlatform[]>(post.platforms ?? []);
  // Las redes que tenía (todas las de la marca, con las que tienen texto, si no tenía lista) y las
  // que se le quitan al guardar (ninguna si queda sin marcar: todas las de la marca).
  const before =
    post.platforms ??
    POST_PLATFORMS.filter(
      (platform) =>
        brandNetworks.includes(platform) ||
        contents.some((content) => content.platform === platform),
    );
  const removed =
    checked.length === 0 ? [] : before.filter((platform) => !checked.includes(platform));
  const blocking = publications.filter(
    (publication) =>
      (PENDING_PUBLICATION_STATUSES as readonly string[]).includes(publication.status) &&
      (removed as readonly string[]).includes(publication.platform),
  );
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
    const platforms = POST_PLATFORMS.filter((platform) => checked.includes(platform));
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
      {
        onSuccess: (saved) => {
          onSaved(saved);
          onClose();
        },
      },
    );
  };
  const pillars = profile.data?.pillars ?? [];
  return (
    <form aria-label="Editar el post" onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      <Field
        label="Tema"
        hint="De qué trata este post, en una frase. Es el título que ves en las listas y en lo que la IA redacta."
        className="md:col-span-2"
      >
        <Input name="topic" required defaultValue={post.topic} />
      </Field>
      <Field
        label="Brief (opcional)"
        hint="Lo que tú sabes y quieres que diga: datos, cifras, el ángulo. La IA puede afirmar lo que escribas aquí. Vacío está bien: entonces solo usa el perfil de la marca."
        className="md:col-span-2"
      >
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
      <Field
        label="Línea editorial"
        hint="Una de las líneas de contenido del perfil de la marca (por ejemplo «Producto» o «Educación»). Sirve para repartir los temas en el plan; no cambia el texto."
      >
        <Select name="pillar" defaultValue={post.pillar ?? ""}>
          <option value="">sin línea</option>
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
      <Field
        label="Fecha planeada (Chile)"
        hint="Cuándo planeas que salga. Es una guía para ordenar tus posts: la hora real de cada red se fija al programar (queda como «programado para»)."
      >
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
                checked={checked.includes(platform)}
                onChange={(event) =>
                  setChecked((current) =>
                    event.target.checked
                      ? [...current, platform]
                      : current.filter((item) => item !== platform),
                  )
                }
              />
              {PLATFORM_TEXT[platform]}
            </label>
          ))}
        </div>
      </fieldset>
      {blocking.length > 0 && <PendingRemoval postId={post.id} blocking={blocking} />}
      <div className="flex gap-2 md:col-span-2">
        <Button
          type="submit"
          loading={update.isPending}
          disabled={blocking.length > 0}
          title={
            blocking.length > 0
              ? "Primero cancela o resuelve las publicaciones pendientes de la red que quitas"
              : undefined
          }
        >
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
      {/* Una red agregada que se está redactando lo dice su propio aviso (`PostNetworksNotice`). */}
      {run !== null && !(running && run.scope?.mode === "missing") && (
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
 * Las redes del post y sus textos (F9-T21; F9.6): una red agregada a un post ya redactado se
 * redacta sola al guardar («Redactando el texto de LinkedIn…»); si falta su texto (falló, o no se
 * pudo pedir), «Redactar solo LinkedIn» pide solo ese, sin tocar los demás. Los textos de las redes
 * quitadas van plegados en «Redes quitadas» (en los textos). Nada si el post tiene todas las redes
 * de la marca (`platforms = null`).
 */
function PostNetworksNotice({
  post,
  contents,
  run,
  drafting,
}: {
  post: PostJson;
  contents: readonly { platform: Platform }[];
  run: ContentRunView | null;
  /** Lo que la IA empezó a redactar al guardar la última edición (o por qué no pudo). */
  drafting: PostDraftingView | null;
}) {
  const draft = useRequestPostDraft(post.id);
  if (post.status === "idea" || post.status === "archived") return null;
  const running = run !== null && !isTerminalContentRun(run.status);
  // Una corrida de todo el post en curso: lo dice el cuadro de pedir textos.
  if (running && run.scope === null) return null;
  const { missing } = postNetworkGaps({ post, contents, latestRun: running ? null : run });
  if (running && run.scope !== null && run.scope.mode === "missing") {
    return (
      <Alert role="status" tone="info">
        <p className="flex items-center gap-2">
          <Spinner />
          Redactando el texto de {scopeText(run.scope)}… Los demás textos no cambian.
        </p>
      </Alert>
    );
  }
  if (missing.length === 0 || running) return null;
  const failedHere =
    run?.status === "failed" &&
    run.scope !== null &&
    run.scope.platforms.some((platform) => (missing as readonly string[]).includes(platform));
  const notAsked =
    drafting?.error !== null &&
    drafting?.error !== undefined &&
    drafting.platforms.some((platform) => missing.includes(platform));
  return (
    <Alert role="status" tone="warning">
      <p>
        {failedHere
          ? `No se pudo redactar el texto de ${networkNames(missing)}${run?.error ? `: ${run.error.message}` : "."}`
          : notAsked
            ? `No se pidió el texto de ${networkNames(missing)}: ${drafting?.error?.message ?? ""}`
            : `Falta el texto de ${networkNames(missing)}: la agregaste al post después de redactar.`}
      </p>
      <Button
        size="sm"
        className="mt-2"
        loading={draft.isPending}
        onClick={() => draft.mutate({ platforms: missing, onlyMissing: true })}
      >
        Redactar solo {networkNames(missing)}
      </Button>
      <p className="mt-1 text-xs">La IA redacta solo lo que falta: los demás textos no cambian.</p>
      {draft.error && <ErrorAlert error={draft.error} />}
    </Alert>
  );
}

/**
 * El tipo del post (texto, imagen, carrusel o video) contra sus medios y sus redes, arriba: lo que
 * falta («Falta la imagen») y las redes que no sirven para ese tipo (`kindProblem`).
 */
function PostKindNotice({
  post,
  contents,
  media,
}: {
  post: PostJson;
  contents: readonly { platform: Platform }[];
  media: PostDetailResponse["media"];
}) {
  if (post.status === "archived") return null;
  const { media: missing, unfit } = postKindIssues({
    post,
    contents,
    images: media.filter((item) => item.kind === "image").length,
    videos: media.filter((item) => item.kind === "video").length,
  });
  if (missing === null && unfit.length === 0) return null;
  return (
    <Alert
      role="status"
      tone="warning"
      className="mb-6"
      title={`Post de tipo «${POST_KIND_LABEL[post.kind].toLowerCase()}»`}
    >
      <ul className="list-disc space-y-1 pl-5">
        {missing !== null && <li>{missing} Súbelo o consíguelo en «Medios».</li>}
        {unfit.map(({ platform, message }) => (
          <li key={platform}>
            {message}: {PLATFORM_TEXT[platform]} no sirve para este tipo. Cambia el tipo o quita la
            red con «Editar el post».
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * El tema o el brief cambiaron después de redactar: ofrece pedir textos nuevos (con la opción de
 * reemplazar los editados o aprobados). Nada se rehace solo.
 */
function SourceChangedNotice({
  post,
  changed,
  run,
  hasTexts,
}: {
  post: PostJson;
  changed: PostDetailResponse["sourceChanged"];
  run: ContentRunView | null;
  hasTexts: boolean;
}) {
  const draft = useRequestPostDraft(post.id);
  const [replace, setReplace] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const running = run !== null && !isTerminalContentRun(run.status);
  if (!hasTexts || dismissed || running || (!changed.topic && !changed.brief)) return null;
  if (post.status === "idea" || post.status === "archived") return null;
  const what =
    changed.topic && changed.brief ? "el tema y el brief" : changed.topic ? "el tema" : "el brief";
  return (
    <Alert role="status" tone="warning">
      <p className="font-medium">
        Cambiaste {what} después de redactar: ¿pedir textos nuevos a la IA?
      </p>
      <p className="mt-1 text-xs">Los textos de ahora siguen igual hasta que pidas otros.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button size="sm" loading={draft.isPending} onClick={() => draft.mutate(replace)}>
          Pedir textos nuevos a la IA
        </Button>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={replace}
            onChange={(event) => setReplace(event.target.checked)}
          />
          Reemplazar también los textos editados o aprobados
        </label>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          Dejarlos así
        </Button>
      </div>
      {draft.error && <ErrorAlert error={draft.error} />}
    </Alert>
  );
}

/**
 * Cambió la fecha planificada y el post tiene publicaciones programadas: «¿moverlas a la hora
 * nueva?» (`rescheduleSuggestion`). Nunca se mueven solas; moverlas programa de nuevo cada red
 * (`POST /posts/:id/schedule`), conservando el espacio entre idiomas, y en vivo pide confirmar.
 */
function RescheduleNotice({
  postId,
  publications,
  at,
  publishMode,
  onDone,
}: {
  postId: string;
  publications: PostDetailResponse["publications"];
  at: Date;
  publishMode: PublishMode | undefined;
  onDone: () => void;
}) {
  const schedule = useSchedulePost(postId);
  const [skipped, setSkipped] = useState<string[]>([]);
  const suggestion = rescheduleSuggestion(publications, at);
  if (suggestion === null) return null;
  const when = suggestion.times.map((time) => formatChileDayTime(time)).join(" y ");
  const target = formatChileDayTime(at);
  const move = async () => {
    const problems: string[] = [];
    try {
      for (const item of suggestion.moves) {
        const done: PostScheduleResponse = await schedule.mutateAsync({
          platforms: [item.platform],
          languages: item.languages,
          at: at.toISOString(),
          ...(item.languages.length > 1 ? { spacingMinutes: item.spacingMinutes } : {}),
        });
        for (const row of done.results) {
          if (row.outcome === "skipped") {
            problems.push(
              `${row.platform === null ? "El post" : PLATFORM_TEXT[row.platform]}: ${row.message}`,
            );
          }
        }
      }
    } catch {
      // El error queda en `schedule.error`.
      return;
    }
    setSkipped(problems);
    if (problems.length === 0) onDone();
  };
  return (
    <Alert role="status" tone="warning" className="mb-6">
      <p className="font-medium">
        Este post tiene{" "}
        {suggestion.count === 1
          ? "1 publicación programada"
          : `${suggestion.count} publicaciones programadas`}{" "}
        para el {when}: ¿moverla{suggestion.count === 1 ? "" : "s"} al {target}?
      </p>
      <p className="mt-1 text-xs">
        No se mueven solas. Cada red sale a la hora nueva y su otro idioma conserva el espacio que
        tenía.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <LiveConfirmButton
          label={`Moverla${suggestion.count === 1 ? "" : "s"} al ${target}`}
          publishMode={publishMode}
          pending={schedule.isPending}
          liveMessage="La marca está en vivo: a la hora nueva se publican de verdad."
          confirmLabel="Sí, moverlas"
          onConfirm={() => void move()}
        />
        <Button variant="ghost" size="sm" onClick={onDone}>
          Dejarlas como están
        </Button>
      </div>
      {skipped.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-danger-700">
          {skipped.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {schedule.error && <ErrorAlert error={schedule.error} />}
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
  // El modo de la marca del post (F9.5-T22, ADR-0036), no el del servidor.
  const modeOf = useBrokerModeOf();
  const archive = useArchivePost(id);
  const profile = useEditorialProfile(post.data?.post.brokerId);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Tras guardar: la fecha nueva (para sugerir mover lo programado) y lo que la IA empezó a redactar.
  const [moveTo, setMoveTo] = useState<Date | null>(null);
  const [drafting, setDrafting] = useState<PostDraftingView | null>(null);

  if (post.error) return <ErrorAlert error={post.error} onRetry={() => void post.refetch()} />;
  if (post.data === undefined) return <Loading />;
  const {
    post: item,
    media,
    contents,
    latestRun,
    publications,
    uploadsInReview,
    sourceChanged,
  } = post.data;
  const archived = item.status === "archived";
  const publishMode = modeOf(item.brokerId);
  const pillarName =
    profile.data?.pillars.find((pillar) => pillar.key === item.pillar)?.name ?? item.pillar;
  const runActive = latestRun !== null && !isTerminalContentRun(latestRun.status);
  // Una fecha pasada sin nada publicado ni a punto de salir: no es una fecha que se pueda usar.
  const stalePlannedAt =
    !archived &&
    item.plannedAt !== null &&
    item.plannedAt.getTime() < Date.now() &&
    !publications.some((pub) =>
      ["published", "scheduled", "publishing", "awaiting_manual_confirm"].includes(pub.status),
    );
  // La hora real que ya quedó fijada en las redes (la próxima), aparte de la fecha planeada.
  const nextScheduled =
    publications
      .filter((pub) => pub.status === "scheduled" && pub.scheduledAt !== null)
      .map((pub) => pub.scheduledAt as Date)
      .sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
  const lockReason = archived
    ? "El post está archivado."
    : runActive
      ? "La IA está redactando los textos: espera a que termine."
      : null;
  return (
    <SubjectBrokerContext.Provider value={item.brokerId}>
      <div>
        <PageHeader
          back={{ to: "/contenido", label: "Contenido" }}
          title={item.topic}
          meta={<PostStatusBadge status={item.status} />}
          description={
            <>
              <p>
                {POST_KIND_LABEL[item.kind]}
                {item.pillar !== null && ` · línea ${pillarName}`}
                {" · "}
                {item.plannedAt === null
                  ? "sin fecha planeada"
                  : `fecha planeada: ${formatChileDayTime(item.plannedAt)} (hora de Chile)`}
                {!archived && !editing && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => setEditing(true)}
                      className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
                    >
                      {item.plannedAt === null ? "Ponerle fecha" : "Cambiar la fecha"}
                    </button>
                  </>
                )}
                {nextScheduled !== null &&
                  ` · programado para el ${formatChileDayTime(nextScheduled)} (hora de Chile)`}
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
        {stalePlannedAt && (
          <Alert role="status" tone="warning" className="mb-6">
            <p className="font-semibold">
              La fecha planeada ya pasó ({formatChileDayTime(item.plannedAt as Date)}) y este post
              no salió.
            </p>
            <p className="mt-1">
              No se publica solo.{" "}
              {item.status === "idea"
                ? "Cámbiale la fecha con «Editar el post» antes de aceptarlo en el plan, o archívalo."
                : "Para usarlo, cámbiale la fecha con «Editar el post» y vuelve a programarlo; si ya no sirve, archívalo."}
            </p>
          </Alert>
        )}
        {item.brief !== null && (
          <div className="mb-6 rounded-xl border border-line bg-surface shadow-xs px-4 py-3">
            <p className="text-xs font-medium text-fg-subtle">
              Brief: lo que tú sabes y la IA puede afirmar
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{item.brief}</p>
          </div>
        )}
        {!archived && item.status !== "idea" && (
          <div className="mb-6">
            <PostSummary
              post={item}
              contents={contents}
              publications={publications}
              media={media}
            />
          </div>
        )}
        {moveTo !== null && !archived && (
          <RescheduleNotice
            postId={item.id}
            publications={publications}
            at={moveTo}
            publishMode={publishMode}
            onDone={() => setMoveTo(null)}
          />
        )}
        {!editing && item.status !== "idea" && (
          <PostKindNotice post={item} contents={contents} media={media} />
        )}
        {editing && (
          <Card title="Editar el post" className="mb-6">
            <PostEditForm
              post={item}
              contents={contents}
              publications={publications}
              onClose={() => setEditing(false)}
              onSaved={(saved) => {
                setDrafting(saved.drafting);
                const at = saved.post.plannedAt;
                setMoveTo(at !== null && at.getTime() !== item.plannedAt?.getTime() ? at : null);
              }}
            />
          </Card>
        )}
        {archive.error && <ErrorAlert error={archive.error} />}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-6">
            <Card as="section" aria-label="Textos" title="Textos por red">
              <div className="space-y-4">
                <DraftBox post={item} run={latestRun} hasTexts={contents.length > 0} />
                <SourceChangedNotice
                  post={item}
                  changed={sourceChanged}
                  run={latestRun}
                  hasTexts={contents.length > 0}
                />
                <PostNetworksNotice
                  post={item}
                  contents={contents}
                  run={latestRun}
                  drafting={drafting}
                />
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
              kind={item.kind}
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

            <XLinkControl
              post={item}
              contents={contents}
              lockReason={archived ? "El post está archivado." : null}
            />

            {!archived && item.status !== "idea" && (
              <Card as="section" aria-label="Ya publicado" title="¿Ya lo publicaste afuera?">
                <RecordExternal postId={item.id} contents={contents} lockReason={lockReason} />
              </Card>
            )}

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
    </SubjectBrokerContext.Provider>
  );
}
