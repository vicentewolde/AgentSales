import {
  AppError,
  type CheckedContent,
  type ContentRepository,
  type ContentRunRepository,
  type EditContentDeps,
  editContent,
  type GetListingContentDeps,
  getListingContent,
  type JobQueue,
  type Media,
  type MediaStorage,
  type RequestContentRunDeps,
  requestContentRun,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  type ContentEditResponse,
  type ContentMedia,
  type ContentRunRequestResponse,
  type ContentRunResponse,
  type ContentView,
  contentEditBodySchema,
  contentRunRequestBodySchema,
  idParamSchema,
  type ListingContentResponse,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type ContentRoutesDeps = RequestContentRunDeps &
  GetListingContentDeps &
  EditContentDeps & {
    contentRuns: ContentRunRepository;
    contents: ContentRepository;
    queue: JobQueue;
    /** Solo para las URLs de lectura temporales de los medios (R2 es privado, ADR-0007). */
    storage: Pick<MediaStorage, "signedReadUrl">;
  };

/** La vista HTTP de un texto: sin `rawOutput` ni datos del modelo, y solo los `checks`. */
const contentView = ({ content, checks }: CheckedContent): ContentView => ({
  id: content.id,
  platform: content.platform,
  title: content.title,
  body: content.body,
  hashtags: content.hashtags,
  status: content.status,
  checks,
  promptVersion: content.promptVersion,
  updatedAt: content.updatedAt,
});

/** Un medio de un canal con su URL firmada. Solo derivados y renders: nunca un original. */
const contentMedia =
  (storage: Pick<MediaStorage, "signedReadUrl">) =>
  async (media: Media): Promise<ContentMedia> => {
    if (media.variant === null) throw new AppError("INTERNAL_ERROR", "Un original en un canal");
    return {
      id: media.id,
      variant: media.variant,
      mime: media.mime,
      width: media.width,
      height: media.height,
      durationS: media.durationS,
      url: await storage.signedReadUrl(media.storagePath),
    };
  };

/**
 * Pedir y mirar la preparación de contenido de un aviso (spec F2 §4.7): `POST` y `GET` bajo
 * `/listings/:id`. Se montan en `/listings`, junto a `listingRoutes`.
 */
export function listingContentRoutes(deps: ContentRoutesDeps) {
  const signed = contentMedia(deps.storage);
  return new Hono()
    .post(
      "/:id/content-runs",
      validated("param", idParamSchema),
      validated("json", contentRunRequestBodySchema),
      async (c) => {
        const { texts, replaceEdits } = c.req.valid("json");
        const { run, reused } = await requestContentRun(deps, {
          listingId: c.req.valid("param").id,
          ...(texts === undefined ? {} : { texts }),
          ...(replaceEdits === undefined ? {} : { replaceEdits }),
        });
        const body: ContentRunRequestResponse = { contentRun: run, reused };
        return c.json(body, 202);
      },
    )
    .get("/:id/content", validated("param", idParamSchema), async (c) => {
      const content = await getListingContent(deps, { listingId: c.req.valid("param").id });
      const body: ListingContentResponse = {
        contents: content.contents.map(contentView),
        carousel: await Promise.all(content.carousel.map(signed)),
        photos: await Promise.all(content.photos.map(signed)),
        reel: content.reel === null ? null : await signed(content.reel),
        latestRun: content.latestRun,
      };
      return c.json(body, 200);
    });
}

/** `GET /content-runs/:id`: estado, etapa, reporte y error de una corrida. */
export function contentRunRoutes(deps: Pick<ContentRoutesDeps, "contentRuns">) {
  return new Hono().get("/:id", validated("param", idParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const run = await deps.contentRuns.get(id);
    if (run === null) {
      throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida ${id}`, {
        details: { contentRunId: id },
      });
    }
    const body: ContentRunResponse = { contentRun: run };
    return c.json(body, 200);
  });
}

/** `PATCH /contents/:id`: editar el texto vigente de un canal (`editContent`). */
export function contentRoutes(deps: EditContentDeps) {
  return new Hono().patch(
    "/:id",
    validated("param", idParamSchema),
    validated("json", contentEditBodySchema),
    async (c) => {
      const result = await editContent(deps, {
        contentId: c.req.valid("param").id,
        edit: c.req.valid("json"),
      });
      const body: ContentEditResponse = { content: contentView(result) };
      return c.json(body, 200);
    },
  );
}
