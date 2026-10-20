import type { PostJson } from "@agentsales/api/contracts";
import {
  formatChileTime,
  isAppError,
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
import { useBrokers } from "../queries/brokers.js";
import { useCreatePost, usePosts } from "../queries/posts.js";
import { useBrokerFilter, useRole } from "../scope/broker-scope.js";

const FIELD = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";

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
      className="mt-6 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">Nuevo post</h2>
      <form onSubmit={submit} className="mt-2 grid gap-3 md:grid-cols-2">
        {pickBroker && (
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Marca
            <select name="brokerId" defaultValue="" className={FIELD}>
              <option value="" disabled>
                Elige una marca o corredor
              </option>
              {(brokers.data ?? []).map((broker) => (
                <option key={broker.id} value={broker.id}>
                  {broker.brandName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm font-medium text-slate-700 md:col-span-2">
          Tema
          <input name="topic" required maxLength={200} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-slate-700 md:col-span-2">
          Brief (lo que tú sabes; la IA puede afirmar lo que escribas aquí)
          <textarea name="brief" rows={3} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Tipo
          <select name="kind" defaultValue="text" className={FIELD}>
            {POST_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {POST_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${ids}-planned`} className="block text-sm font-medium text-slate-700">
          Fecha planeada (Chile, opcional)
          <input id={`${ids}-planned`} name="plannedAt" type="datetime-local" className={FIELD} />
        </label>
        <div className="md:col-span-2">
          <button
            type="submit"
            // Mientras no se sabe quién es, no se sabe si hay que elegir la marca.
            disabled={create.isPending || role === null}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? "Creando…" : "Crear post"}
          </button>
        </div>
      </form>
      {problem !== null && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {problem}
        </p>
      )}
      {create.error && <ErrorAlert error={create.error} />}
    </section>
  );
}

function PostRow({ post, brand }: { post: PostJson; brand: string | null }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white p-3">
      <Link to={`/contenido/${post.id}`} className="font-semibold underline">
        {post.topic}
      </Link>
      <PostStatusBadge status={post.status} />
      <span className="text-sm text-slate-600">{POST_KIND_LABEL[post.kind]}</span>
      {brand !== null && <span className="text-sm text-slate-500">{brand}</span>}
      <span className="text-sm text-slate-500">
        {post.plannedAt === null ? "sin fecha" : `para el ${formatChileTime(post.plannedAt)}`}
      </span>
    </li>
  );
}

/**
 * Contenido (spec F9 §4.10, F9-T17): los posts de la marca o corredor elegido (el administrador
 * puede ver todos), por estado, y crear uno. Los archivados solo se ven con su filtro.
 */
export function PostsPage() {
  const [params, setParams] = useSearchParams();
  const status = oneOf(POST_STATUSES, params.get("estado"));
  const brokerId = useScopedBrokerId();
  const role = useRole();
  const brokers = useBrokers();
  const posts = usePosts({ brokerId, ...(status === undefined ? {} : { status }) });
  const filterId = useId();
  const shown = (posts.data ?? []).filter(
    (post) => status !== undefined || post.status !== "archived",
  );
  const brandOf = (post: PostJson) =>
    role === "admin" && brokerId === undefined
      ? (brokers.data?.find((broker) => broker.id === post.brokerId)?.brandName ?? null)
      : null;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Contenido</h1>
      <p className="mt-1 text-sm text-slate-600">
        Los posts de la marca: textos por red e idioma, medios, publicar y programar.
      </p>
      <div className="mt-4 flex flex-col gap-1">
        <label htmlFor={filterId} className="text-xs font-medium text-slate-600">
          Estado
        </label>
        <select
          id={filterId}
          value={status ?? ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value === "") next.delete("estado");
            else next.set("estado", event.target.value);
            setParams(next, { replace: true });
          }}
          className="w-fit rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">Todos (sin archivados)</option>
          {POST_STATUSES.map((value: PostStatus) => (
            <option key={value} value={value}>
              {POST_STATUS_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      {posts.error && <ErrorAlert error={posts.error} onRetry={() => void posts.refetch()} />}
      {posts.data === undefined && !posts.error && <p className="mt-4 text-slate-600">Cargando…</p>}
      {posts.data !== undefined &&
        (shown.length === 0 ? (
          <p className="mt-4 text-slate-600">
            No hay posts {status ? "en ese estado" : "todavía"}.
          </p>
        ) : (
          <ul aria-label="Posts" className="mt-4 space-y-2">
            {shown.map((post) => (
              <PostRow key={post.id} post={post} brand={brandOf(post)} />
            ))}
          </ul>
        ))}
      <CreatePost scopedBrokerId={brokerId} />
    </div>
  );
}
