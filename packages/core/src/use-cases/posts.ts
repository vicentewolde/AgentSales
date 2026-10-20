import { inScope } from "../access.js";
import type { PostKind, PostStatus } from "../enums.js";
import { AppError } from "../errors.js";
import { assertCan, scopeOf } from "../permissions.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostChanges, PostFilters, PostRepository } from "../ports/post-repository.js";
import type { Post } from "../post.js";
import { PENDING_PUBLICATION_STATUSES } from "../publication-state.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";

// Los posts manuales (spec F9 §4.2 y §4.10, F9-T10): crear, listar, ver, editar y archivar. Un post
// cuelga de cualquier corredor o marca (ADR-0029, punto 1). El alcance va siempre por `scopeOf`,
// `inScope` y `can` (punto 13): lo de otro corredor no existe (`POST_NOT_FOUND`, ADR-0022) y lo
// suyo sin `posts.manage` es `FORBIDDEN`. Los cambios corren dentro de `PostLock`.

type Actor = Pick<User, "id" | "role" | "brokerId">;

/** Topes de los campos de un post (los textos por red tienen los suyos, F9-T11). */
export const POST_LIMITS = {
  topic: 200,
  brief: 5000,
} as const;

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new AppError("POST_INVALID", message, { details });

export const postNotFound = (postId: string) =>
  new AppError("POST_NOT_FOUND", `No existe el post ${postId}`, { details: { postId } });

const brokerNotFound = (brokerId: string) =>
  new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
    details: { id: brokerId },
  });

/** El tema: sin espacios de sobra, no vacío y hasta `POST_LIMITS.topic` caracteres. */
function normalizeTopic(topic: string): string {
  const trimmed = topic.trim();
  if (trimmed === "") throw invalid("El post necesita un tema");
  if ([...trimmed].length > POST_LIMITS.topic) {
    throw invalid(`El tema pasa de ${POST_LIMITS.topic} caracteres`);
  }
  return trimmed;
}

/** El brief: `null` si viene vacío; hasta `POST_LIMITS.brief` caracteres. */
function normalizeBrief(brief: string | null | undefined): string | null {
  if (brief === null || brief === undefined) return null;
  const trimmed = brief.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > POST_LIMITS.brief) {
    throw invalid(`El brief pasa de ${POST_LIMITS.brief} caracteres`);
  }
  return trimmed;
}

/** Una fecha válida (un `Date` inválido rompería el orden y la base). */
function checkDate(date: Date | null | undefined): Date | null | undefined {
  if (date === null || date === undefined) return date;
  if (Number.isNaN(date.getTime())) throw invalid("La fecha planificada no es válida");
  return date;
}

/**
 * La línea de contenido tiene que existir en el perfil editorial del corredor (`pillars[].key`).
 * `null` la quita.
 */
async function checkPillar(
  profiles: Pick<EditorialProfileRepository, "get">,
  brokerId: string,
  pillar: string | null | undefined,
): Promise<string | null | undefined> {
  if (pillar === null || pillar === undefined) return pillar;
  const key = pillar.trim();
  if (key === "") return null;
  const profile = await profiles.get(brokerId);
  if (!profile?.pillars.some((item) => item.key === key)) {
    throw invalid(`La línea "${key.slice(0, 40)}" no está en el perfil editorial`, {
      pillar: key.slice(0, 40),
    });
  }
  return key;
}

/**
 * El post, si el usuario lo ve (ADR-0022: lo ajeno no existe) y puede `posts.manage` sobre él. La
 * API ya respondió 404 a lo ajeno (`ownedBy`); esto es la misma regla en core, para la CLI y los
 * tests.
 */
export function assertPostAccess(actor: Actor, post: Post | null, postId: string): Post {
  if (post === null || !inScope(scopeOf(actor), post.brokerId)) throw postNotFound(postId);
  assertCan(actor, "posts.manage", post.brokerId);
  return post;
}

export type CreatePostDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  posts: Pick<PostRepository, "create">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
};

export type CreatePostInput = {
  /** El corredor o la marca del post; el de un usuario corredor es siempre el suyo. */
  brokerId?: string | undefined;
  topic: string;
  brief?: string | null | undefined;
  kind?: PostKind | undefined;
  pillar?: string | null | undefined;
  plannedAt?: Date | null | undefined;
};

/**
 * Crea un post manual (spec F9 §4.2): `source = manual`, `briefOrigin = operator` y `draft`. El
 * administrador elige el corredor o marca (obligatorio); un usuario corredor crea en el suyo (otro
 * `brokerId` es `BROKER_NOT_FOUND`, como uno que no existe). `kind` por defecto `text`.
 */
export async function createPost(
  deps: CreatePostDeps,
  actor: Actor,
  input: CreatePostInput,
): Promise<Post> {
  const brokerId = input.brokerId ?? actor.brokerId ?? undefined;
  if (brokerId === undefined) throw invalid("Falta el corredor o la marca del post");
  if (!inScope(scopeOf(actor), brokerId)) throw brokerNotFound(brokerId);
  assertCan(actor, "posts.manage", brokerId);
  if ((await deps.brokers.findById(brokerId)) === null) throw brokerNotFound(brokerId);
  const topic = normalizeTopic(input.topic);
  const brief = normalizeBrief(input.brief);
  const plannedAt = checkDate(input.plannedAt) ?? null;
  const pillar = (await checkPillar(deps.editorialProfiles, brokerId, input.pillar)) ?? null;
  return deps.posts.create({
    brokerId,
    topic,
    brief,
    briefOrigin: "operator",
    kind: input.kind ?? "text",
    status: "draft",
    source: "manual",
    pillar,
    plannedAt,
    createdBy: actor.id,
  });
}

export type ListPostsFilters = {
  brokerId?: string | undefined;
  status?: PostStatus | readonly PostStatus[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
};

/**
 * Los posts del alcance (`GET /api/posts`): el administrador ve todos y un corredor, los suyos. Un
 * corredor que filtra por otro corredor recibe `BROKER_NOT_FOUND` (es un filtro, no un permiso,
 * como `?broker=` de las propiedades).
 */
export async function listPosts(
  deps: { posts: Pick<PostRepository, "list"> },
  actor: Actor,
  filters: ListPostsFilters,
): Promise<Post[]> {
  const scope = scopeOf(actor);
  if (filters.brokerId !== undefined && !inScope(scope, filters.brokerId)) {
    throw brokerNotFound(filters.brokerId);
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) {
    throw invalid("El rango de fechas está al revés");
  }
  const query: PostFilters = {};
  if (filters.brokerId !== undefined) query.brokerId = filters.brokerId;
  if (filters.status !== undefined) query.status = filters.status;
  if (checkDate(filters.from) !== undefined) query.from = filters.from as Date;
  if (checkDate(filters.to) !== undefined) query.to = filters.to as Date;
  return deps.posts.list(query, scope);
}

/** Un post del alcance (`GET /api/posts/:id`); `POST_NOT_FOUND` si no existe o es de otro. */
export async function getPost(
  deps: { posts: Pick<PostRepository, "get"> },
  actor: Actor,
  postId: string,
): Promise<Post> {
  return assertPostAccess(actor, await deps.posts.get(postId), postId);
}

export type UpdatePostDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
};

/** Lo que se edita de un post (`PATCH /api/posts/:id`); `undefined` = no tocar, `null` borra. */
export type UpdatePostInput = {
  topic?: string | undefined;
  brief?: string | null | undefined;
  kind?: PostKind | undefined;
  pillar?: string | null | undefined;
  plannedAt?: Date | null | undefined;
};

const postArchived = (postId: string) =>
  new AppError("POST_ARCHIVED", "El post está archivado: ya no se edita", {
    details: { postId },
  });

/**
 * Edita el tema, el brief, el tipo, la línea o la fecha planificada (spec F9 §4.10). Editar el
 * brief lo deja como del operador (`briefOrigin = operator`, ADR-0030 punto 1: desde ahí es fuente
 * de hechos). Un post archivado no se edita (`POST_ARCHIVED`, 409). Sin cambios, devuelve el post
 * tal cual.
 */
export async function updatePost(
  deps: UpdatePostDeps,
  actor: Actor,
  postId: string,
  input: UpdatePostInput,
): Promise<Post> {
  const current = assertPostAccess(actor, await deps.posts.get(postId), postId);
  const changes: PostChanges = {};
  if (input.topic !== undefined) changes.topic = normalizeTopic(input.topic);
  if (input.brief !== undefined) {
    changes.brief = normalizeBrief(input.brief);
    changes.briefOrigin = "operator";
  }
  if (input.kind !== undefined) changes.kind = input.kind;
  if (input.plannedAt !== undefined) changes.plannedAt = checkDate(input.plannedAt) ?? null;
  if (input.pillar !== undefined) {
    changes.pillar =
      (await checkPillar(deps.editorialProfiles, current.brokerId, input.pillar)) ?? null;
  }
  return deps.postLock.run(postId, async ({ posts }) => {
    const post = await posts.get(postId);
    if (post === null) throw postNotFound(postId);
    if (post.status === "archived") throw postArchived(postId);
    if (Object.keys(changes).length === 0) return post;
    return posts.update(postId, changes);
  });
}

/**
 * Archiva un post (descartado o terminado, spec F9 §4.2): ya no se programa. Si tiene
 * publicaciones pendientes (aprobadas, programadas, publicando, fallidas, esperando confirmación o
 * con resultado dudoso), `POST_HAS_PENDING_PUBLICATIONS` (409): primero se cancelan o resuelven.
 * Archivar uno ya archivado lo devuelve igual.
 */
export async function archivePost(
  deps: { posts: Pick<PostRepository, "get">; postLock: PostLock },
  actor: Actor,
  postId: string,
): Promise<Post> {
  assertPostAccess(actor, await deps.posts.get(postId), postId);
  return deps.postLock.run(postId, async ({ posts, publications }) => {
    const post = await posts.get(postId);
    if (post === null) throw postNotFound(postId);
    if (post.status === "archived") return post;
    const pending = (await publications.listBySubject(postSubject(postId))).filter((publication) =>
      (PENDING_PUBLICATION_STATUSES as readonly string[]).includes(publication.status),
    );
    if (pending.length > 0) {
      throw new AppError(
        "POST_HAS_PENDING_PUBLICATIONS",
        "El post tiene publicaciones pendientes: cancélalas o resuélvelas antes de archivarlo",
        { details: { postId, publicationIds: pending.map((publication) => publication.id) } },
      );
    }
    return posts.archive(postId);
  });
}
