import { inScope } from "../access.js";
import type { EditorialProfile } from "../editorial-profile.js";
import { AppError } from "../errors.js";
import { addLlmCall } from "../llm-usage.js";
import type { PlanRun } from "../plan-run.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import { lockedMedia } from "../ports/media-repository.js";
import type { PlanRunRepository } from "../ports/plan-run-repository.js";
import type { PostLock, PostLockedRepositories } from "../ports/post-lock.js";
import {
  type PostRepository,
  type PostUploadRepository,
  pickPostChanges,
} from "../ports/post-repository.js";
import type { Post, PostUpload } from "../post.js";
import { postSubject } from "../subject.js";
import { structuredCopy } from "./copy.js";

/** Un id con forma de uuid, como en Postgres (los datos de los jobs lo exigen). */
const uuidLike = (prefix: string, sequence: number) =>
  `${prefix}-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

/**
 * El `updatedAt` de un cambio: siempre después del anterior, como `now()` en la base entre
 * transacciones distintas.
 */
const later = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1));

export type InMemoryPostRepository = PostRepository & {
  /** Todos los posts guardados, para afirmar en los tests. */
  all(): Post[];
};

/**
 * `PostRepository` en memoria, con la semántica del de Drizzle. A diferencia de Postgres, no
 * revisa que el corredor, el plan o el usuario existan (allí, la FK da `POST_REFERENCE_INVALID`).
 */
export function createInMemoryPostRepository(): InMemoryPostRepository {
  let sequence = 0;
  const posts = new Map<string, Post>();
  const find = (id: string) => {
    const post = posts.get(id);
    if (post === undefined) throw new AppError("POST_NOT_FOUND", `No existe el post ${id}`);
    return post;
  };
  const save = (post: Post) => {
    posts.set(post.id, post);
    return structuredCopy(post);
  };
  return {
    async create(input) {
      const now = new Date();
      if (input.id !== undefined && posts.has(input.id)) {
        throw new AppError("DB_QUERY_FAILED", `Ya existe el post ${input.id}`);
      }
      return save({
        id: input.id ?? uuidLike("00000000", ++sequence),
        brokerId: input.brokerId,
        topic: input.topic,
        brief: input.brief ?? null,
        briefOrigin: input.briefOrigin ?? "operator",
        kind: input.kind,
        status: input.status ?? "draft",
        source: input.source ?? "manual",
        pillar: input.pillar ?? null,
        plannedAt:
          input.plannedAt === undefined || input.plannedAt === null
            ? null
            : new Date(input.plannedAt),
        planRunId: input.planRunId ?? null,
        createdBy: input.createdBy ?? null,
        rationale: input.rationale ?? null,
        xLinkAllowed: input.xLinkAllowed ?? false,
        platforms:
          input.platforms === undefined || input.platforms === null ? null : [...input.platforms],
        createdAt: now,
        updatedAt: now,
      });
    },
    async get(id) {
      const post = posts.get(id);
      return post === undefined ? null : structuredCopy(post);
    },
    async list(filters, scope) {
      const statuses =
        filters.status === undefined
          ? undefined
          : typeof filters.status === "string"
            ? [filters.status]
            : filters.status;
      const time = (date: Date | null) => date?.getTime() ?? Number.POSITIVE_INFINITY;
      return [...posts.values()]
        .filter(
          (post) =>
            inScope(scope, post.brokerId) &&
            (filters.brokerId === undefined || post.brokerId === filters.brokerId) &&
            (filters.planRunId === undefined || post.planRunId === filters.planRunId) &&
            (statuses === undefined || statuses.includes(post.status)) &&
            (filters.from === undefined ||
              (post.plannedAt !== null && post.plannedAt >= filters.from)) &&
            (filters.to === undefined || (post.plannedAt !== null && post.plannedAt < filters.to)),
        )
        .sort(
          (a, b) =>
            time(a.plannedAt) - time(b.plannedAt) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map(structuredCopy);
    },
    async update(id, changes) {
      const current = find(id);
      return save({ ...current, ...pickPostChanges(changes), updatedAt: later(current.updatedAt) });
    },
    async archive(id) {
      const current = find(id);
      if (current.status === "archived") return structuredCopy(current);
      return save({ ...current, status: "archived", updatedAt: later(current.updatedAt) });
    },
    async listRecent(brokerId, since, limit = 300) {
      return [...posts.values()]
        .filter(
          (post) =>
            post.brokerId === brokerId &&
            (post.createdAt >= since || (post.plannedAt !== null && post.plannedAt >= since)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(structuredCopy);
    },
    all: () => [...posts.values()].map(structuredCopy),
  };
}

/** `PostUploadRepository` en memoria: el único de `object_path` y los cambios condicionales. */
export function createInMemoryPostUploadRepository(): PostUploadRepository {
  let sequence = 0;
  const uploads = new Map<string, PostUpload>();
  const settle = (
    id: string,
    status: PostUpload["status"],
    from: readonly PostUpload["status"][] = ["pending"],
  ) => {
    const current = uploads.get(id);
    if (current === undefined || !from.includes(current.status)) return false;
    uploads.set(id, { ...current, status, updatedAt: later(current.updatedAt) });
    return true;
  };
  return {
    async create(input) {
      if (
        [...uploads.values()].some((upload) => upload.objectPath === input.objectPath) ||
        (input.id !== undefined && uploads.has(input.id))
      ) {
        throw new AppError("POST_UPLOAD_CONFLICT", "Ya hay una subida con esa clave");
      }
      const now = new Date();
      const upload: PostUpload = {
        id: input.id ?? uuidLike("00000000", ++sequence),
        postId: input.postId,
        objectPath: input.objectPath,
        expectedBytes: input.expectedBytes,
        status: "pending",
        expiresAt: new Date(input.expiresAt),
        createdAt: now,
        updatedAt: now,
      };
      uploads.set(upload.id, upload);
      return structuredCopy(upload);
    },
    async get(id) {
      const upload = uploads.get(id);
      return upload === undefined ? null : structuredCopy(upload);
    },
    async listByPost(postId) {
      return [...uploads.values()].filter((upload) => upload.postId === postId).map(structuredCopy);
    },
    async listExpired(now) {
      return [...uploads.values()]
        .filter((upload) => upload.status === "pending" && upload.expiresAt < now)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id))
        .map(structuredCopy);
    },
    async listStaleUploaded(before) {
      return [...uploads.values()]
        .filter((upload) => upload.status === "uploaded" && upload.updatedAt < before)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
        .map(structuredCopy);
    },
    async markCompleted(id) {
      return settle(id, "completed", ["pending", "uploaded"]);
    },
    async markUploaded(id) {
      return settle(id, "uploaded");
    },
    async markAbandoned(id) {
      return settle(id, "abandoned", ["pending", "uploaded"]);
    },
    async reopen(id, expiresAt) {
      const current = uploads.get(id);
      if (current === undefined) return null;
      const upload: PostUpload = {
        ...current,
        status: "pending",
        expiresAt: new Date(expiresAt),
        updatedAt: later(current.updatedAt),
      };
      uploads.set(id, upload);
      return structuredCopy(upload);
    },
  };
}

export type InMemoryPlanRunRepository = PlanRunRepository & {
  /** Todos los planes, para `sumLlmCost` del doble de contenido (`planRuns`). */
  all(): PlanRun[];
};

/**
 * `PlanRunRepository` en memoria, con cambios de estado condicionales como el de Drizzle. Con
 * `posts`, `markSucceeded` guarda allí las ideas (sin `posts`, un plan con ideas es un error del
 * test). No es atómico como la transacción de Postgres: el doble no falla a medias.
 */
export function createInMemoryPlanRunRepository(
  options: { posts?: Pick<PostRepository, "create"> } = {},
): InMemoryPlanRunRepository {
  let sequence = 0;
  const runs = new Map<string, PlanRun>();
  const change = (id: string, from: readonly PlanRun["status"][], patch: Partial<PlanRun>) => {
    const current = runs.get(id);
    if (current === undefined || !from.includes(current.status)) return false;
    runs.set(id, { ...current, ...patch, updatedAt: later(current.updatedAt) });
    return true;
  };
  return {
    async create(input) {
      // Como el índice único parcial de Postgres: un plan activo por marca.
      if (
        [...runs.values()].some(
          (run) =>
            run.brokerId === input.brokerId &&
            (run.status === "queued" || run.status === "running"),
        )
      ) {
        throw new AppError("PLAN_RUN_CONFLICT", "La marca ya tiene un plan en curso");
      }
      const now = new Date();
      const run: PlanRun = {
        id: uuidLike("00000000", ++sequence),
        brokerId: input.brokerId,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        status: "queued",
        request: structuredCopy(input.request),
        report: null,
        error: null,
        llmUsage: null,
        promptVersion: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      runs.set(run.id, run);
      return structuredCopy(run);
    },
    async get(id) {
      const run = runs.get(id);
      return run === undefined ? null : structuredCopy(run);
    },
    async listByBroker(brokerId, limit = 20) {
      return [...runs.values()]
        .filter((run) => run.brokerId === brokerId)
        .reverse()
        .slice(0, limit)
        .map(structuredCopy);
    },
    async markRunning(id) {
      const current = runs.get(id);
      return change(id, ["queued", "running"], {
        status: "running",
        startedAt: current?.startedAt ?? new Date(),
      });
    },
    async markSucceeded(id, { report, promptVersion, ideas = [] }) {
      if (runs.get(id)?.status !== "running") return false;
      if (ideas.length > 0 && options.posts === undefined) {
        throw new Error("createInMemoryPlanRunRepository: las ideas necesitan `posts`");
      }
      for (const idea of ideas) await options.posts?.create(idea);
      return change(id, ["running"], {
        status: "succeeded",
        report: structuredCopy(report ?? null),
        promptVersion,
        finishedAt: new Date(),
      });
    },
    async markFailed(id, error) {
      return change(id, ["queued", "running"], {
        status: "failed",
        error: { ...error },
        finishedAt: new Date(),
      });
    },
    async listQueued() {
      return [...runs.values()].filter((run) => run.status === "queued").map(structuredCopy);
    },
    async failAbandoned(startedBefore, error) {
      const closed: string[] = [];
      for (const run of runs.values()) {
        if (run.status !== "running" || run.startedAt === null || run.startedAt >= startedBefore) {
          continue;
        }
        change(run.id, ["running"], {
          status: "failed",
          error: { ...error },
          finishedAt: new Date(),
        });
        closed.push(run.id);
      }
      return closed;
    },
    async addLlmUsage(id, call) {
      const current = runs.get(id);
      if (current === undefined) {
        throw new AppError("PLAN_RUN_NOT_FOUND", `No existe el plan ${id}`);
      }
      const updated = { ...current, llmUsage: addLlmCall(current.llmUsage, call) };
      runs.set(id, updated);
      return structuredCopy(updated);
    },
    all: () => [...runs.values()].map(structuredCopy),
  };
}

/** `EditorialProfileRepository` en memoria: un perfil por corredor. */
export function createInMemoryEditorialProfileRepository(): EditorialProfileRepository {
  const profiles = new Map<string, EditorialProfile>();
  return {
    async get(brokerId) {
      const profile = profiles.get(brokerId);
      return profile === undefined ? null : structuredCopy(profile);
    },
    async upsert(brokerId, data) {
      const current = profiles.get(brokerId);
      const now = new Date();
      const profile: EditorialProfile = {
        brokerId,
        languages: [...data.languages],
        audience: data.audience,
        pillars: structuredCopy(data.pillars),
        facts: [...data.facts],
        avoid: [...data.avoid],
        cadence: structuredCopy(data.cadence),
        defaultHashtags: [...data.defaultHashtags],
        createdAt: current?.createdAt ?? now,
        updatedAt: current === undefined ? now : later(current.updatedAt),
      };
      profiles.set(brokerId, profile);
      return structuredCopy(profile);
    },
  };
}

/**
 * Candado por post en memoria, como `createInMemoryListingLock`: serializa los `run` del mismo
 * post (uno espera al anterior) y entrega los repositorios que recibe. Tiene sus propias colas: un
 * post nunca espera a un aviso, aunque los ids coincidieran. No deshace nada si `fn` falla.
 */
export function createInMemoryPostLock(repos: PostLockedRepositories): PostLock & {
  /** Posts con un `run` en curso, para afirmar en los tests de concurrencia. */
  busy(): string[];
} {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run(postId, fn) {
      const previous = tails.get(postId) ?? Promise.resolve();
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(postId, tail);
      await previous;
      try {
        if ((await repos.posts.get(postId)) === null) {
          throw new AppError("POST_NOT_FOUND", `No existe el post ${postId}`, {
            details: { postId },
          });
        }
        return await fn({ ...repos, media: lockedMedia(repos.media, postSubject(postId)) });
      } finally {
        release();
        if (tails.get(postId) === tail) tails.delete(postId);
      }
    },
    busy() {
      return [...tails.keys()];
    },
  };
}
