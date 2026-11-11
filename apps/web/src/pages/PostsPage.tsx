import type { PostCover, PostJson } from "@agentsales/api/contracts";
import {
  formatChileDayTime,
  isAppError,
  PLATFORM_TEXT,
  POST_KINDS,
  type PostKind,
  parseChileTime,
} from "@agentsales/core";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { POST_KIND_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { PostThumb } from "../components/posts/PostThumb.js";
import {
  isStale,
  type PostProgress,
  PostProgressBadge,
  postProgress,
  StaleDateNote,
  type TrackingPostRow,
} from "../components/posts/progress.js";
import { Button } from "../components/ui/Button.js";
import { Input, Select, Textarea } from "../components/ui/Field.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Tip } from "../components/ui/Tip.js";
import { useBrokers } from "../queries/brokers.js";
import { useArchivePosts, useCreatePost, usePosts } from "../queries/posts.js";
import { useTracking } from "../queries/tracking.js";
import { useBrokerFilter, useRole } from "../scope/broker-scope.js";

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

/**
 * Las listas de Contenido, con palabras de todos los días. Cada post cae en una sola:
 * - `por-publicar`: ya tiene texto y todavía puede salir (hoy o más adelante, o sin fecha).
 * - `fecha-pasada`: su fecha ya pasó y no salió; no se publica solo.
 * - `publicados`: ya salieron.
 * - `ideas`: propuestas del plan que todavía no aceptaste (no son posts hasta aceptarlas).
 * - `archivados`: los que sacaste de las listas, sin borrarlos.
 */
const VIEWS = ["por-publicar", "fecha-pasada", "publicados", "ideas", "archivados"] as const;
type View = (typeof VIEWS)[number];

const VIEW_TITLE: Readonly<Record<View, string>> = {
  "por-publicar": "Por publicar",
  "fecha-pasada": "Fecha pasada",
  publicados: "Publicados",
  ideas: "Ideas sin aceptar",
  archivados: "Archivados",
};

const VIEW_HELP: Readonly<Record<View, string>> = {
  "por-publicar":
    "Lo definitivo: posts con su texto, que todavía no salieron. Ábrelos para revisar el texto, aprobarlo y programarlo.",
  "fecha-pasada":
    "Su fecha ya pasó y no salieron. Nada se publica solo: ábrelos y cámbiales la fecha para usarlos, o archívalos si ya no sirven.",
  publicados: "Ya salieron en las redes.",
  ideas:
    "Propuestas de la IA que aún no aceptaste: todavía no son posts. Se aceptan o se descartan en Plan; al aceptar una, pasa a «Por publicar».",
  archivados: "Los sacaste de las listas; no se borraron.",
};

function viewOf(post: PostJson, progress: PostProgress, now: Date): View {
  if (post.status === "archived") return "archivados";
  if (post.status === "idea") return "ideas";
  if (progress.state === "published") return "publicados";
  if (isStale(post.plannedAt, progress, now)) return "fecha-pasada";
  return "por-publicar";
}

/**
 * El corredor o marca que se está mirando, por su id (la API de posts filtra por id): el elegido
 * en el selector del administrador; `undefined` con "Todos" o para un corredor (la API le da lo
 * suyo).
 */
export function useScopedBrokerId(): string | undefined {
  const slug = useBrokerFilter();
  const brokers = useBrokers();
  return slug === undefined ? undefined : brokers.data?.find((broker) => broker.slug === slug)?.id;
}

/** Crear un post a mano: tema, brief, tipo, fecha planeada y, si el administrador mira "Todos", la marca. */
function CreatePost({ scopedBrokerId }: { scopedBrokerId: string | undefined }) {
  const ids = useId();
  const role = useRole();
  const brokers = useBrokers();
  const create = useCreatePost();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const pickBroker = role === "admin" && scopedBrokerId === undefined;
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
    const brokerId = pickBroker ? text("brokerId") : scopedBrokerId;
    if (pickBroker && brokerId === "") {
      setProblem("Elige la marca del post.");
      return;
    }
    setProblem(null);
    create.mutate(
      {
        topic: text("topic"),
        ...(text("brief") === "" ? {} : { brief: text("brief") }),
        kind: (oneOf(POST_KINDS, text("kind")) ?? "text") satisfies PostKind,
        ...(plannedAt === null ? {} : { plannedAt }),
        ...(brokerId === undefined || brokerId === "" ? {} : { brokerId }),
      },
      { onSuccess: (post) => navigate(`/contenido/${post.id}`) },
    );
  };
  return (
    <section
      aria-label="Nuevo post"
      className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <h2 className="text-lg font-semibold">Nuevo post</h2>
      <form onSubmit={submit} className="mt-2 grid gap-3 md:grid-cols-2">
        {pickBroker && (
          <label className="block text-sm font-medium text-fg md:col-span-2">
            Marca
            <Select name="brokerId" defaultValue="" className="mt-1">
              <option value="" disabled>
                Elige una marca o corredor
              </option>
              {(brokers.data ?? []).map((broker) => (
                <option key={broker.id} value={broker.id}>
                  {broker.brandName}
                </option>
              ))}
            </Select>
          </label>
        )}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-fg">
            Tema
            <Input name="topic" required maxLength={200} className="mt-1" />
          </label>
          <p className="mt-1 text-xs text-fg-subtle">De qué trata el post, en una frase.</p>
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-fg">
            Brief (opcional)
            <Textarea name="brief" rows={3} className="mt-1" />
          </label>
          <p className="mt-1 text-xs text-fg-subtle">
            Lo que tú sabes y quieres que diga: datos, cifras, el ángulo. La IA puede afirmar lo que
            escribas aquí; vacío está bien.
          </p>
        </div>
        <label className="block text-sm font-medium text-fg">
          Tipo
          <Select name="kind" defaultValue="text" className="mt-1">
            {POST_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {POST_KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor={`${ids}-planned`} className="block text-sm font-medium text-fg">
          Fecha planeada (Chile, opcional)
          <Input id={`${ids}-planned`} name="plannedAt" type="datetime-local" className="mt-1" />
        </label>
        <div className="md:col-span-2">
          <Button
            type="submit"
            // Mientras no se sabe quién es, no se sabe si hay que elegir la marca.
            disabled={create.isPending || role === null}
          >
            {create.isPending ? "Creando…" : "Crear post"}
          </Button>
        </div>
      </form>
      {problem !== null && (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {problem}
        </p>
      )}
      {create.error && <ErrorAlert error={create.error} />}
    </section>
  );
}

/** Las redes del post en palabras: las suyas o «todas las de la marca». */
const networksOf = (post: PostJson) =>
  post.platforms === null
    ? "todas las redes"
    : post.platforms.map((platform) => PLATFORM_TEXT[platform]).join(" + ");

function PostRow({
  post,
  brand,
  cover,
  progress,
  stale,
  onArchive,
  archiving,
}: {
  post: PostJson;
  brand: string | null;
  cover: PostCover | undefined;
  progress: PostProgress;
  stale: boolean;
  onArchive: (id: string) => void;
  archiving: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isPost = post.status === "draft" || post.status === "ready";
  return (
    <li
      className={`flex items-start gap-3 rounded-xl border p-3 shadow-xs ${
        stale ? "border-warning-200 bg-warning-50" : "border-line bg-surface"
      }`}
    >
      <Link to={`/contenido/${post.id}`} tabIndex={-1} aria-hidden="true">
        <PostThumb cover={cover} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          to={`/contenido/${post.id}`}
          className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
        >
          {post.topic}
        </Link>
        <p className="mt-1 text-sm font-medium text-fg tabular-nums">
          {post.plannedAt === null ? "sin fecha" : formatChileDayTime(post.plannedAt)}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          {isPost ? (
            <PostProgressBadge progress={progress} />
          ) : (
            <PostStatusBadge status={post.status} />
          )}
          <span>{POST_KIND_LABEL[post.kind]}</span>
          <span aria-hidden="true">·</span>
          <span>{networksOf(post)}</span>
          {brand !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-fg-subtle">{brand}</span>
            </>
          )}
        </p>
        {stale && <StaleDateNote className="mt-1 text-sm" idea={post.status === "idea"} />}
      </div>
      {post.status !== "archived" && (
        <div className="shrink-0 text-sm">
          {confirming ? (
            <span className="flex flex-wrap items-center justify-end gap-2">
              ¿Archivar?
              <Button
                variant="danger"
                size="sm"
                loading={archiving}
                onClick={() => {
                  onArchive(post.id);
                  setConfirming(false);
                }}
              >
                Sí
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                No
              </Button>
            </span>
          ) : (
            <Tip
              align="end"
              text="Lo saca de las listas sin borrarlo: lo encuentras en «Archivados». No se puede archivar si tiene publicaciones pendientes."
            >
              {(describedBy) => (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-describedby={describedBy}
                  onClick={() => setConfirming(true)}
                >
                  Archivar
                </Button>
              )}
            </Tip>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Contenido (spec F9 §4.10, F9-T17): los posts definitivos de la marca o corredor elegido (el
 * administrador puede ver todos) en cinco listas con nombres claros (`VIEWS`), y crear uno. Cada
 * post está en una sola: lo que falta publicar, lo que tiene la fecha pasada (con alerta), lo ya
 * publicado, las ideas del plan sin aceptar y los archivados. En qué va cada uno sale de Seguimiento.
 */
export function PostsPage() {
  const [params, setParams] = useSearchParams();
  const view = oneOf(VIEWS, params.get("ver")) ?? "por-publicar";
  const brokerId = useScopedBrokerId();
  const brokerSlug = useBrokerFilter();
  const role = useRole();
  const brokers = useBrokers();
  const posts = usePosts({ brokerId });
  const tracking = useTracking(false, brokerSlug);
  const archive = useArchivePosts();
  const [confirmPast, setConfirmPast] = useState(false);
  const covers = posts.data?.covers ?? {};
  const trackingRows = new Map<string, TrackingPostRow>(
    (tracking.data?.posts ?? []).map((row) => [row.post.id, row]),
  );
  const now = new Date();
  const byDate = (a: PostJson, b: PostJson) =>
    (a.plannedAt?.getTime() ?? Number.POSITIVE_INFINITY) -
    (b.plannedAt?.getTime() ?? Number.POSITIVE_INFINITY);
  const latestFirst = (a: PostJson, b: PostJson) => byDate(b, a);
  const entries = (posts.data?.posts ?? []).map((post) => {
    const progress = postProgress(trackingRows.get(post.id));
    return { post, progress, view: viewOf(post, progress, now) };
  });
  const inView = (which: View) => entries.filter((entry) => entry.view === which);
  const shown = inView(view).sort((a, b) =>
    view === "por-publicar" || view === "ideas"
      ? byDate(a.post, b.post)
      : latestFirst(a.post, b.post),
  );
  const brandOf = (post: PostJson) =>
    role === "admin" && brokerId === undefined
      ? (brokers.data?.find((broker) => broker.id === post.brokerId)?.brandName ?? null)
      : null;
  const archivingId = archive.isPending ? (archive.variables ?? []) : [];
  const loading = (posts.data === undefined && !posts.error) || tracking.isPending;
  return (
    <div>
      <PageHeader
        title="Contenido"
        description={
          <>
            Los posts definitivos de la marca: lo que se va a publicar, con sus textos por red e
            idioma, sus imágenes y su hora. Las ideas que aún no aceptaste viven en{" "}
            <Link to="/plan" className="underline underline-offset-2">
              Plan
            </Link>
            .
          </>
        }
      />
      <fieldset className="mt-4 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Ver</legend>
        {VIEWS.map((value) => {
          const count = inView(value).length;
          const active = value === view;
          return (
            <Button
              key={value}
              aria-pressed={active}
              variant={active ? "primary" : "secondary"}
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(params);
                if (value === "por-publicar") next.delete("ver");
                else next.set("ver", value);
                setParams(next, { replace: true });
                setConfirmPast(false);
              }}
            >
              {VIEW_TITLE[value]}
              {!loading && <span className="ml-1.5 tabular-nums opacity-80">{count}</span>}
            </Button>
          );
        })}
      </fieldset>
      <p className="mt-2 text-sm text-fg-muted">{VIEW_HELP[view]}</p>
      {posts.error && <ErrorAlert error={posts.error} onRetry={() => void posts.refetch()} />}
      {tracking.error && (
        <p role="status" className="mt-2 text-sm text-warning-800">
          No pude leer en qué va cada post (publicado o programado); las listas pueden estar
          incompletas.
        </p>
      )}
      {loading && <p className="mt-4 text-fg-muted">Cargando…</p>}
      {!loading && shown.length === 0 && (
        <p className="mt-4 text-fg-muted">
          {view === "por-publicar"
            ? "No hay posts por publicar. Pide un plan para llenar el mes o crea uno abajo."
            : "No hay posts en esta lista."}
        </p>
      )}
      {view === "fecha-pasada" && shown.length > 0 && !loading && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {confirmPast ? (
            <>
              <span>
                ¿Archivar estos {shown.length} posts? No se borra nada; los que tengan publicaciones
                pendientes se quedan.
              </span>
              <Button
                variant="danger"
                size="sm"
                loading={archive.isPending}
                onClick={() =>
                  archive.mutate(
                    shown.map((entry) => entry.post.id),
                    { onSettled: () => setConfirmPast(false) },
                  )
                }
              >
                Sí, archivarlos
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmPast(false)}>
                Cancelar
              </Button>
            </>
          ) : (
            <Tip text="Saca de las listas todos los de esta lista, sin borrarlos: los encuentras en «Archivados». Los que tengan publicaciones pendientes no se archivan.">
              {(describedBy) => (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-describedby={describedBy}
                  onClick={() => setConfirmPast(true)}
                >
                  Archivar todos…
                </Button>
              )}
            </Tip>
          )}
        </div>
      )}
      {archive.data !== undefined && archive.data.failed.length > 0 && (
        <p role="status" className="mt-2 text-sm text-warning-800">
          {archive.data.failed.length === 1
            ? "Uno no se archivó: tiene publicaciones pendientes o falló."
            : `${archive.data.failed.length} no se archivaron: tienen publicaciones pendientes o fallaron.`}{" "}
          Ábrelos para cancelar o resolver lo pendiente.
        </p>
      )}
      {!loading && shown.length > 0 && (
        <ul aria-label={`Posts: ${VIEW_TITLE[view]}`} className="mt-3 space-y-2">
          {shown.map(({ post, progress, view: own }) => (
            <PostRow
              key={post.id}
              post={post}
              brand={brandOf(post)}
              cover={covers[post.id]}
              progress={progress}
              stale={
                own === "fecha-pasada" ||
                (own === "ideas" && isStale(post.plannedAt, progress, now))
              }
              onArchive={(id) => archive.mutate([id])}
              archiving={archivingId.includes(post.id)}
            />
          ))}
        </ul>
      )}
      {archive.error && <ErrorAlert error={archive.error} />}
      <CreatePost scopedBrokerId={brokerId} />
    </div>
  );
}
