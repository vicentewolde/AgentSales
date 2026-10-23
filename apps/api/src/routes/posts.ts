import {
  AppError,
  acceptIdea,
  approveContent,
  archivePost,
  assertPostAccess,
  type BrokerRepository,
  type ContentRepository,
  type ContentRunRepository,
  completePostUploads,
  createPost,
  discardIdea,
  type EditContentDeps,
  type EditorialProfileRepository,
  editContent,
  getPostContent,
  getPostImageOptions,
  type JobQueue,
  listPosts,
  type MediaRepository,
  type MediaStorage,
  type PostImageRun,
  type PostImageRunRepository,
  type PostImageSourcesConfig,
  type PostLock,
  type PostRepository,
  type PostUploadRepository,
  PROCESSED_MEDIA_VARIANTS,
  type ProcessedMediaVariant,
  type PublicationRepository,
  type PublishListingDeps,
  type PublishMode,
  postContentId,
  postSubject,
  publishPost,
  requestContentRun,
  requestPostImage,
  requestPostUploads,
  schedulePost,
  searchStockPhotos,
  unapproveContent,
  updatePost,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type ContentApproveResponse,
  type ContentEditResponse,
  type ContentRunRequestResponse,
  type ContentUnapproveResponse,
  contentEditBodySchema,
  createPostBodySchema,
  type IdeaAcceptResponse,
  idParamSchema,
  type PostContentParam,
  type PostDetailResponse,
  type PostImageOptionsResponse,
  type PostImageRunResponse,
  type PostImageRunView,
  type PostImageStockResponse,
  type PostListResponse,
  type PostMediaItem,
  type PostPublishResponse,
  type PostResponse,
  type PostScheduleResponse,
  type PostUploadCompleteResponse,
  type PostUploadResponse,
  postContentParamSchema,
  postDraftBodySchema,
  postImageBodySchema,
  postImageRunParamSchema,
  postImageStockQuerySchema,
  postPublishBodySchema,
  postQuerySchema,
  postScheduleBodySchema,
  postUploadRequestSchema,
  updatePostBodySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";
import { contentRunView, contentView } from "./content.js";
import { actorOf, publicationView, skippedView } from "./publication-views.js";

export type PostRoutesDeps = EditContentDeps &
  Omit<PublishListingDeps, "postLock"> & {
    brokers: Pick<BrokerRepository, "findById">;
    posts: PostRepository;
    /** Las escrituras de un post van dentro de su candado (ADR-0029, punto 3). */
    postLock: PostLock;
    /** Las subidas del post, solo para contar las que el worker revisa (F9-T17). */
    postUploads: Pick<PostUploadRepository, "listByPost">;
    /** La línea de contenido de un post tiene que estar en el perfil editorial de su marca. */
    editorialProfiles: Pick<EditorialProfileRepository, "get">;
    media: Pick<MediaRepository, "listBySubject">;
    /** Los textos vigentes (con su revisión) y editar, aprobar o quitar la aprobación (F9-T12). */
    contents: Pick<ContentRepository, "get" | "listCurrent">;
    /**
     * La última corrida de textos y marcar `failed` una que no se pudo encolar (F9-T12); el tope de
     * IA del mes antes de aceptar una idea (`sumLlmCost`, F9-T21).
     */
    contentRuns: Pick<ContentRunRepository, "latest" | "markFailed" | "sumLlmCost">;
    /** Las publicaciones del post, solo para leer (los cambios van en el candado). */
    publications: Pick<PublicationRepository, "listBySubject">;
    /** Firmar las subidas, revisar que llegaron y las URLs de lectura (ADR-0025). */
    storage: Pick<MediaStorage, "signedUploadUrl" | "list" | "signedReadUrl">;
    /** `post.media`, al terminar una subida; `post.draft` y `publication.publish` (F9-T12). */
    queue: JobQueue;
    /** El modo de lo que se publica o programa (D11): el de la API ahora, nunca del cuerpo. */
    publishMode: PublishMode;
    /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo (el de la carga). */
    maxUploadBytes: number;
    /** `MAX_VIDEO_MB` en bytes: el tope de un video (el de la carga). */
    maxVideoBytes: number;
    /** El id de una subida grande sin sha256 (va en su clave de R2, F9-T17). */
    newId: () => string;
    /** Los pedidos de imágenes de los posts (F9.5-T25): `post.image` los atiende. */
    postImageRuns: PostImageRunRepository;
    /** La biblioteca y el precio de la IA, si el servidor tiene sus claves (F9.5-T25). */
    imageSources: PostImageSourcesConfig;
  };

/** Un pedido de imágenes para el panel y la CLI (sin el corredor ni quién lo pidió). */
const imageRunView = (run: PostImageRun): PostImageRunView => ({
  id: run.id,
  postId: run.postId,
  source: run.source,
  status: run.status,
  request: run.request,
  mediaIds: run.mediaIds,
  costUsd: run.costUsd,
  model: run.model,
  error: run.error,
  createdAt: run.createdAt,
  finishedAt: run.finishedAt,
});

/** Un filtro de fecha de la consulta (texto ISO ya validado) como `Date`. */
const dateOf = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);

/**
 * `/posts` (spec F9 §4.10, F9-T10): crear, listar, ver, editar y archivar posts, y subir sus medios
 * directo a R2 (ADR-0025). Todo con `posts.manage` (revisado en core); lo de otro corredor es 404
 * (`ownedBy` en `app.ts` para `/posts/:id/*`, y la misma regla en core).
 */
export function postRoutes(deps: PostRoutesDeps) {
  // Los textos de un post se revisan con el perfil editorial de su marca (`postReview`, F9-T11),
  // en el candado del post: las mismas reglas que la corrida.
  const contentDeps = {
    ...deps,
    postReview: { posts: deps.posts, editorialProfiles: deps.editorialProfiles },
  };
  const dryRun = deps.publishMode !== "live";
  /** El post, si el usuario lo ve y puede `posts.manage` (lo ajeno ya es 404 en `ownedBy`). */
  const ownPost = async (c: Context<AppEnv>, postId: string) =>
    assertPostAccess(requireAuth(c).user, await deps.posts.get(postId), postId);
  /** El id del texto vigente de la red e idioma de la ruta (con el mismo alcance). */
  const contentIdOf = (c: Context<AppEnv>, param: PostContentParam) =>
    postContentId(deps, requireAuth(c).user, {
      postId: param.id,
      platform: param.platform,
      language: param.language,
    });

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

  // F9.5-T25: conseguir imágenes (las fuentes, la biblioteca y los pedidos).
  const imageDeps = {
    posts: deps.posts,
    brokers: deps.brokers,
    runs: deps.postImageRuns,
    queue: deps.queue,
    sources: deps.imageSources,
  };

  return (
    new Hono<AppEnv>()
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
        const { post, contents, latestRun, publications } = await getPostContent(
          deps,
          requireAuth(c).user,
          id,
        );
        const body: PostDetailResponse = {
          post,
          media: await mediaOf(id),
          contents: contents.map(contentView),
          latestRun: latestRun === null ? null : contentRunView(latestRun),
          publications: publications.map(publicationView),
          uploadsInReview: (await deps.postUploads.listByPost(id)).filter(
            (upload) => upload.status === "uploaded",
          ).length,
        };
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
      // F9-T21 (ADR-0030 punto 3): aceptar una idea la pasa a `draft` y pide sus textos
      // (`post.draft`, solo para sus redes); descartarla la archiva. Lo demás es `POST_NOT_IDEA`.
      .post("/:id/accept", validated("param", idParamSchema), async (c) => {
        const { post, run, reused } = await acceptIdea(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
        );
        const body: IdeaAcceptResponse = { post, contentRun: contentRunView(run), reused };
        return c.json(body, 202);
      })
      .post("/:id/discard", validated("param", idParamSchema), async (c) => {
        const post = await discardIdea(deps, requireAuth(c).user, c.req.valid("param").id);
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
              newId: deps.newId,
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
          uploaded: result.uploaded,
          media: await mediaOf(id),
        };
        return c.json(body, 200);
      })
      // F9.5-T25 (ADR-0038): conseguir imágenes. Las fuentes, lo propuesto y los últimos pedidos;
      // buscar en la biblioteca (una lectura); pedir (el worker las consigue con `post.image`) y
      // seguir un pedido.
      .get("/:id/images", validated("param", idParamSchema), async (c) => {
        const options = await getPostImageOptions(
          imageDeps,
          requireAuth(c).user,
          c.req.valid("param").id,
        );
        const body: PostImageOptionsResponse = { ...options, runs: options.runs.map(imageRunView) };
        return c.json(body, 200);
      })
      .get(
        "/:id/images/stock",
        validated("param", idParamSchema),
        validated("query", postImageStockQuerySchema),
        async (c) => {
          const { q, people } = c.req.valid("query");
          const photos = await searchStockPhotos(
            imageDeps,
            requireAuth(c).user,
            c.req.valid("param").id,
            { text: q, withoutPeople: people !== "1" },
          );
          const body: PostImageStockResponse = { photos };
          return c.json(body, 200);
        },
      )
      .get("/:id/images/:runId", validated("param", postImageRunParamSchema), async (c) => {
        const { id, runId } = c.req.valid("param");
        await ownPost(c, id);
        const run = await deps.postImageRuns.get(runId);
        if (run === null || run.postId !== id) {
          throw new AppError("POST_IMAGE_RUN_NOT_FOUND", "No existe ese pedido de imágenes", {
            details: { runId },
          });
        }
        const body: PostImageRunResponse = { run: imageRunView(run) };
        return c.json(body, 200);
      })
      .post(
        "/:id/images",
        validated("param", idParamSchema),
        validated("json", postImageBodySchema),
        async (c) => {
          const run = await requestPostImage(
            imageDeps,
            requireAuth(c).user,
            c.req.valid("param").id,
            c.req.valid("json"),
          );
          const body: PostImageRunResponse = { run: imageRunView(run) };
          return c.json(body, 202);
        },
      )
      // F9-T12: pedir los textos (el worker los redacta con `post.draft`; la corrida se sigue en
      // `GET /content-runs/:id`).
      .post(
        "/:id/draft",
        validated("param", idParamSchema),
        validated("json", postDraftBodySchema),
        async (c) => {
          const post = await ownPost(c, c.req.valid("param").id);
          const { replaceEdits } = c.req.valid("json");
          const { run, reused } = await requestContentRun(deps, {
            postId: post.id,
            ...(replaceEdits === undefined ? {} : { replaceEdits }),
          });
          const body: ContentRunRequestResponse = { contentRun: contentRunView(run), reused };
          return c.json(body, 202);
        },
      )
      .patch(
        "/:id/contents/:platform/:language",
        validated("param", postContentParamSchema),
        validated("json", contentEditBodySchema),
        async (c) => {
          const contentId = await contentIdOf(c, c.req.valid("param"));
          const result = await editContent(contentDeps, { contentId, edit: c.req.valid("json") });
          const body: ContentEditResponse = { content: contentView(result) };
          return c.json(body, 200);
        },
      )
      .post(
        "/:id/contents/:platform/:language/approve",
        validated("param", postContentParamSchema),
        async (c) => {
          const contentId = await contentIdOf(c, c.req.valid("param"));
          const result = await approveContent(contentDeps, { contentId, actor: actorOf(c) });
          const body: ContentApproveResponse = {
            content: contentView(result),
            created: result.created.map(publicationView),
            skipped: result.skipped.map(skippedView),
            publications: result.publications.map(publicationView),
            // Lo que le falta a un aviso para Portal o Marketplace: un post no lo tiene.
            portalReadiness: null,
            marketplaceReadiness: null,
            // F9.5-T21: sin los medios (o procesándose) el texto se aprueba sin publicaciones.
            mediaPending: result.mediaPending ?? false,
          };
          return c.json(body, 200);
        },
      )
      .post(
        "/:id/contents/:platform/:language/unapprove",
        validated("param", postContentParamSchema),
        async (c) => {
          const contentId = await contentIdOf(c, c.req.valid("param"));
          const result = await unapproveContent(contentDeps, { contentId, actor: actorOf(c) });
          const body: ContentUnapproveResponse = {
            content: contentView(result),
            cancelled: result.cancelled.map(publicationView),
            publications: result.publications.map(publicationView),
          };
          return c.json(body, 200);
        },
      )
      // Publicar una red del post (todos sus idiomas) y encolar; el modo es el de la API (D11).
      .post(
        "/:id/publish",
        validated("param", idParamSchema),
        validated("json", postPublishBodySchema),
        async (c) => {
          const post = await ownPost(c, c.req.valid("param").id);
          const result = await publishPost(deps, {
            postId: post.id,
            platform: c.req.valid("json").platform,
            dryRun,
            actor: actorOf(c),
          });
          const body: PostPublishResponse = {
            started: result.started.map(publicationView),
            requeued: result.requeued.map(publicationView),
            created: result.created.map(publicationView),
            skipped: result.skipped.map(skippedView),
            stranded: result.stranded.map(publicationView),
            publications: result.publications.map(publicationView),
          };
          return c.json(body, 202);
        },
      )
      // Programar las redes pedidas (o cada una con texto aprobado y cuenta) a una hora.
      .post(
        "/:id/schedule",
        validated("param", idParamSchema),
        validated("json", postScheduleBodySchema),
        async (c) => {
          const post = await ownPost(c, c.req.valid("param").id);
          const { platforms, at } = c.req.valid("json");
          const { results } = await schedulePost(deps, {
            postId: post.id,
            at: new Date(at),
            dryRun,
            actor: actorOf(c),
            ...(platforms === undefined ? {} : { platforms }),
          });
          const body: PostScheduleResponse = {
            results: results.map((row) =>
              row.outcome === "scheduled"
                ? {
                    platform: row.platform,
                    outcome: row.outcome,
                    at: row.at,
                    publications: row.publications.map(publicationView),
                  }
                : {
                    platform: row.platform,
                    outcome: row.outcome,
                    code: row.code,
                    message: row.message,
                  },
            ),
          };
          return c.json(body, 200);
        },
      )
  );
}
