import {
  archivePost,
  type BrokerRepository,
  completePostUploads,
  createPost,
  type EditorialProfileRepository,
  getPost,
  type JobQueue,
  listPosts,
  type MediaRepository,
  type MediaStorage,
  type PostLock,
  type PostRepository,
  PROCESSED_MEDIA_VARIANTS,
  type ProcessedMediaVariant,
  postSubject,
  requestPostUploads,
  updatePost,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  createPostBodySchema,
  idParamSchema,
  type PostDetailResponse,
  type PostListResponse,
  type PostMediaItem,
  type PostResponse,
  type PostUploadCompleteResponse,
  type PostUploadResponse,
  postQuerySchema,
  postUploadRequestSchema,
  updatePostBodySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type PostRoutesDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  posts: PostRepository;
  /** Las escrituras de un post van dentro de su candado (ADR-0029, punto 3). */
  postLock: PostLock;
  /** La línea de contenido de un post tiene que estar en el perfil editorial de su marca. */
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  media: Pick<MediaRepository, "listBySubject">;
  /** Firmar las subidas, revisar que llegaron y las URLs de lectura (ADR-0025). */
  storage: Pick<MediaStorage, "signedUploadUrl" | "list" | "signedReadUrl">;
  /** `post.media`, al terminar una subida. */
  queue: JobQueue;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo (el de la carga). */
  maxUploadBytes: number;
  /** `MAX_VIDEO_MB` en bytes: el tope de un video (el de la carga). */
  maxVideoBytes: number;
};

/** Un filtro de fecha de la consulta (texto ISO ya validado) como `Date`. */
const dateOf = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);

/**
 * `/posts` (spec F9 §4.10, F9-T10): crear, listar, ver, editar y archivar posts, y subir sus medios
 * directo a R2 (ADR-0025). Todo con `posts.manage` (revisado en core); lo de otro corredor es 404
 * (`ownedBy` en `app.ts` para `/posts/:id/*`, y la misma regla en core).
 */
export function postRoutes(deps: PostRoutesDeps) {
  /** Los originales del post con sus URLs, su miniatura y las variantes que ya tiene. */
  const mediaOf = async (postId: string): Promise<PostMediaItem[]> => {
    const all = await deps.media.listBySubject(postSubject(postId));
    const variants = new Map<string, ProcessedMediaVariant[]>();
    const thumbs = new Map<string, string>();
    for (const item of all) {
      // Solo las variantes de un original (un render no tiene padre ni es de un post).
      const variant = PROCESSED_MEDIA_VARIANTS.find((known) => known === item.variant);
      if (item.role !== "processed" || item.parentMediaId === null || variant === undefined)
        continue;
      const list = variants.get(item.parentMediaId) ?? [];
      list.push(variant);
      variants.set(item.parentMediaId, list);
      if (item.variant === "thumb") thumbs.set(item.parentMediaId, item.storagePath);
    }
    return Promise.all(
      all
        .filter((item) => item.role === "original")
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map(async (item) => {
          const thumb = thumbs.get(item.id);
          return {
            id: item.id,
            kind: item.kind,
            mime: item.mime,
            bytes: item.bytes,
            sortOrder: item.sortOrder,
            isCover: item.isCover,
            url: await deps.storage.signedReadUrl(item.storagePath),
            thumbUrl: thumb === undefined ? null : await deps.storage.signedReadUrl(thumb),
            width: item.width,
            height: item.height,
            durationS: item.durationS,
            variants: (variants.get(item.id) ?? []).sort(),
          };
        }),
    );
  };

  return new Hono<AppEnv>()
    .get("/", validated("query", postQuerySchema), async (c) => {
      const { brokerId, status, from, to } = c.req.valid("query");
      const posts = await listPosts(deps, requireAuth(c).user, {
        brokerId,
        status,
        from: dateOf(from),
        to: dateOf(to),
      });
      const body: PostListResponse = { posts };
      return c.json(body, 200);
    })
    .post("/", validated("json", createPostBodySchema), async (c) => {
      const input = c.req.valid("json");
      const post = await createPost(deps, requireAuth(c).user, input);
      const body: PostResponse = { post };
      return c.json(body, 201);
    })
    .get("/:id", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const post = await getPost(deps, requireAuth(c).user, id);
      const body: PostDetailResponse = { post, media: await mediaOf(id) };
      return c.json(body, 200);
    })
    .patch(
      "/:id",
      validated("param", idParamSchema),
      validated("json", updatePostBodySchema),
      async (c) => {
        const input = c.req.valid("json");
        const post = await updatePost(deps, requireAuth(c).user, c.req.valid("param").id, input);
        const body: PostResponse = { post };
        return c.json(body, 200);
      },
    )
    .post("/:id/archive", validated("param", idParamSchema), async (c) => {
      const post = await archivePost(deps, requireAuth(c).user, c.req.valid("param").id);
      const body: PostResponse = { post };
      return c.json(body, 200);
    })
    .post(
      "/:id/uploads",
      validated("param", idParamSchema),
      validated("json", postUploadRequestSchema),
      async (c) => {
        const { post, uploads } = await requestPostUploads(
          {
            posts: deps.posts,
            postLock: deps.postLock,
            storage: deps.storage,
            maxFileBytes: deps.maxUploadBytes,
            maxVideoBytes: deps.maxVideoBytes,
          },
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json").files,
        );
        const body: PostUploadResponse = { post, uploads };
        return c.json(body, 201);
      },
    )
    .post("/:id/uploads/complete", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const result = await completePostUploads(deps, requireAuth(c).user, id);
      const body: PostUploadCompleteResponse = {
        post: result.post,
        completed: result.completed,
        missing: result.missing,
        media: await mediaOf(id),
      };
      return c.json(body, 200);
    });
}
