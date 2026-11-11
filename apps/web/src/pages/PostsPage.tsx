import type { PostCover, PostJson } from "@agentsales/api/contracts";
import {
  chileDateOf,
  formatChileDayTime,
  isAppError,
  PLATFORM_TEXT,
  POST_KINDS,
  POST_STATUSES,
  type PostKind,
  type PostStatus,
  parseChileTime,
} from "@agentsales/core";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { POST_KIND_LABEL, POST_STATUS_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { PostThumb } from "../components/posts/PostThumb.js";
import { Button } from "../components/ui/Button.js";
import { Input, Select, Textarea } from "../components/ui/Field.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Tip } from "../components/ui/Tip.js";
import { useBrokers } from "../queries/brokers.js";
import { useArchivePosts, useCreatePost, usePosts } from "../queries/posts.js";
import { useBrokerFilter, useRole } from "../scope/broker-scope.js";

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

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
  onArchive,
  archiving,
}: {
  post: PostJson;
  brand: string | null;
  cover: PostCover | undefined;
  onArchive: (id: string) => void;
  archiving: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
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
          <PostStatusBadge status={post.status} />
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
              text="Lo saca de esta lista sin borrarlo: sigue en el filtro «Archivado». No se puede archivar si tiene publicaciones pendientes."
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
 * Contenido (spec F9 §4.10, F9-T17): los posts de la marca o corredor elegido (el administrador
 * puede ver todos), por estado, y crear uno. Sin filtro se ordenan en dos grupos: lo de hoy en
 * adelante (y lo sin fecha), por fecha; y lo pasado, plegado, con un botón para archivarlo de una
 * vez. Los archivados solo se ven con su filtro.
 */
export function PostsPage() {
  const [params, setParams] = useSearchParams();
  const status = oneOf(POST_STATUSES, params.get("estado"));
  const brokerId = useScopedBrokerId();
  const role = useRole();
  const brokers = useBrokers();
  const posts = usePosts({ brokerId, ...(status === undefined ? {} : { status }) });
  const archive = useArchivePosts();
  const filterId = useId();
  const [confirmPast, setConfirmPast] = useState(false);
  const covers = posts.data?.covers ?? {};
  const shown = (posts.data?.posts ?? []).filter(
    (post) => status !== undefined || post.status !== "archived",
  );
  const today = chileDateOf(new Date());
  // Sin filtro de estado: lo de hoy en adelante y lo sin fecha (por fecha) y lo pasado (lo último primero).
  const isPast = (post: PostJson) => post.plannedAt !== null && chileDateOf(post.plannedAt) < today;
  const byDate = (a: PostJson, b: PostJson) =>
    (a.plannedAt?.getTime() ?? Number.POSITIVE_INFINITY) -
    (b.plannedAt?.getTime() ?? Number.POSITIVE_INFINITY);
  const grouped = status === undefined;
  const upcoming = shown.filter((post) => !isPast(post)).sort(byDate);
  const past = shown
    .filter(isPast)
    .sort((a, b) => (b.plannedAt?.getTime() ?? 0) - (a.plannedAt?.getTime() ?? 0));
  const flat = [...shown].sort(byDate);
  const brandOf = (post: PostJson) =>
    role === "admin" && brokerId === undefined
      ? (brokers.data?.find((broker) => broker.id === post.brokerId)?.brandName ?? null)
      : null;
  const archivingId = archive.isPending ? (archive.variables ?? []) : [];
  const row = (post: PostJson) => (
    <PostRow
      key={post.id}
      post={post}
      brand={brandOf(post)}
      cover={covers[post.id]}
      onArchive={(id) => archive.mutate([id])}
      archiving={archivingId.includes(post.id)}
    />
  );
  return (
    <div>
      <PageHeader
        title="Contenido"
        description={
          <>Los posts de la marca: textos por red e idioma, medios, publicar y programar.</>
        }
      />
      <div className="mt-4 flex flex-col gap-1">
        <label htmlFor={filterId} className="text-xs font-medium text-fg-muted">
          Ver
        </label>
        <Select
          width="auto"
          id={filterId}
          value={status ?? ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value === "") next.delete("estado");
            else next.set("estado", event.target.value);
            setParams(next, { replace: true });
          }}
          className="w-fit"
        >
          <option value="">Lo de ahora y lo pasado (sin archivados)</option>
          {POST_STATUSES.map((value: PostStatus) => (
            <option key={value} value={value}>
              Solo: {POST_STATUS_LABEL[value]}
            </option>
          ))}
        </Select>
      </div>
      {posts.error && <ErrorAlert error={posts.error} onRetry={() => void posts.refetch()} />}
      {posts.data === undefined && !posts.error && <p className="mt-4 text-fg-muted">Cargando…</p>}
      {posts.data !== undefined && shown.length === 0 && (
        <p className="mt-4 text-fg-muted">No hay posts {status ? "en ese estado" : "todavía"}.</p>
      )}
      {posts.data !== undefined && shown.length > 0 && !grouped && (
        <ul aria-label="Posts" className="mt-4 space-y-2">
          {flat.map(row)}
        </ul>
      )}
      {posts.data !== undefined && shown.length > 0 && grouped && (
        <>
          <h2 className="mt-6 text-lg font-semibold">De hoy en adelante ({upcoming.length})</h2>
          {upcoming.length === 0 ? (
            <p className="mt-2 text-fg-muted">Nada por delante: pide un plan para llenar el mes.</p>
          ) : (
            <ul aria-label="Posts de hoy en adelante" className="mt-2 space-y-2">
              {upcoming.map(row)}
            </ul>
          )}
          {past.length > 0 && (
            <details className="mt-6 rounded-xl border border-line bg-canvas p-3">
              <summary className="cursor-pointer text-lg font-semibold">
                Pasados ({past.length})
              </summary>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                {confirmPast ? (
                  <>
                    <span>
                      ¿Archivar los {past.length} posts pasados? No se borra nada; los que tengan
                      publicaciones pendientes se quedan.
                    </span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={archive.isPending}
                      onClick={() =>
                        archive.mutate(
                          past.map((post) => post.id),
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
                  <Tip text="Saca de esta lista todos los posts con fecha anterior a hoy, sin borrarlos: los encuentras en «Solo: Archivado». Los que tengan publicaciones pendientes no se archivan.">
                    {(describedBy) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-describedby={describedBy}
                        onClick={() => setConfirmPast(true)}
                      >
                        Archivar todos los pasados…
                      </Button>
                    )}
                  </Tip>
                )}
              </div>
              {archive.data !== undefined && archive.data.failed.length > 0 && (
                <p role="status" className="mt-2 text-sm text-warning-800">
                  {archive.data.failed.length === 1
                    ? "Uno no se archivó: tiene publicaciones pendientes o falló."
                    : `${archive.data.failed.length} no se archivaron: tienen publicaciones pendientes o fallaron.`}{" "}
                  Ábrelos para cancelar o resolver lo pendiente.
                </p>
              )}
              <ul aria-label="Posts pasados" className="mt-3 space-y-2">
                {past.map(row)}
              </ul>
            </details>
          )}
        </>
      )}
      {archive.error && <ErrorAlert error={archive.error} />}
      <CreatePost scopedBrokerId={brokerId} />
    </div>
  );
}
