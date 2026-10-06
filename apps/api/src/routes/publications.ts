import {
  AppError,
  type CancelPublicationDeps,
  cancelPublication,
  type ListingRepository,
  type MediaRepository,
  type MediaStorage,
  PENDING_PUBLICATION_STATUSES,
  type Platform,
  type PublicationRepository,
  type PublishListingDeps,
  type PublishMode,
  publishListing,
  type RetirePublicationDeps,
  retirePublication,
  type StartPublicationDeps,
  startPublication,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  idParamSchema,
  type ListingPublicationsResponse,
  type ListingPublishResponse,
  listingPublishBodySchema,
  type PublicationEventsResponse,
  type PublicationPublishResponse,
  type PublicationResponse,
  type PublicationRetireResponse,
  publicationRetireBodySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";
import { contentMedia } from "./content.js";
import { actorOf, eventView, publicationView, skippedView } from "./publication-views.js";

export type PublicationRoutesDeps = PublishListingDeps &
  StartPublicationDeps &
  CancelPublicationDeps &
  RetirePublicationDeps & {
    /**
     * Fuera del candado solo se lee: los cambios de estado van dentro, con sus repositorios
     * (ADR-0014). El tipo lo hace cumplir.
     */
    publications: Pick<PublicationRepository, "get" | "listByListing" | "listEvents">;
    listings: Pick<ListingRepository, "get">;
    media: Pick<MediaRepository, "listByListing">;
    /** Solo para las miniaturas de `GET /listings/:id/publications` (R2 es privado, ADR-0007). */
    storage: Pick<MediaStorage, "signedReadUrl">;
    /** El modo de los intentos que se piden por la API (D11): nunca sale del cuerpo. */
    publishMode: PublishMode;
  };

const pending = new Set<string>(PENDING_PUBLICATION_STATUSES);

const publicationNotFound = (id: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${id}`, {
    details: { publicationId: id },
  });

const dryRunOf = (deps: Pick<PublicationRoutesDeps, "publishMode">) => deps.publishMode !== "live";

/**
 * Publicar y mirar las publicaciones de un aviso (spec F3 §4.3 y §4.8): `GET` y `POST` bajo
 * `/listings/:id`. Se montan en `/listings`, junto a `listingRoutes`.
 */
export function listingPublicationRoutes(deps: PublicationRoutesDeps) {
  const signed = contentMedia(deps.storage);
  return new Hono()
    .get("/:id/publications", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      if ((await deps.listings.get(id)) === null) {
        throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`, {
          details: { listingId: id },
        });
      }
      const [publications, media] = await Promise.all([
        deps.publications.listByListing(id),
        deps.media.listByListing(id),
      ]);
      // Cada medio se firma una vez, aunque lo compartan varias publicaciones. Solo los que siguen
      // en R2 y no son originales (una publicación fija derivados y renders), y solo para las
      // pendientes: en las demás, una corrida posterior pudo reemplazar la imagen en el mismo medio.
      const thumbnails = new Map(
        media.filter((item) => item.variant !== null).map((item) => [item.id, signed(item)]),
      );
      const body: ListingPublicationsResponse = {
        publications: await Promise.all(
          publications.map(async (publication) => ({
            ...publicationView(publication),
            media: pending.has(publication.status)
              ? await Promise.all(
                  publication.mediaIds.flatMap((mediaId) => thumbnails.get(mediaId) ?? []),
                )
              : [],
          })),
        ),
      };
      return c.json(body, 200);
    })
    .post(
      "/:id/publish",
      validated("param", idParamSchema),
      validated("json", listingPublishBodySchema),
      async (c) => {
        const platform: Platform = c.req.valid("json").platform;
        const result = await publishListing(deps, {
          listingId: c.req.valid("param").id,
          platform,
          dryRun: dryRunOf(deps),
          actor: actorOf(c),
        });
        const body: ListingPublishResponse = {
          started: result.started.map(publicationView),
          requeued: result.requeued.map(publicationView),
          created: result.created.map(publicationView),
          skipped: result.skipped.map(skippedView),
          stranded: result.stranded.map(publicationView),
          publications: result.publications.map(publicationView),
        };
        return c.json(body, 202);
      },
    );
}

/**
 * `/publications/:id`: publicar o reintentar una, descartarla, marcarla como retirada y su
 * bitácora (spec F3 §4.3 y §4.8). Cambian el estado dentro del candado del aviso (core); publicar
 * encola después.
 */
export function publicationRoutes(deps: PublicationRoutesDeps) {
  return new Hono()
    .get("/:id", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const publication = await deps.publications.get(id);
      if (publication === null) throw publicationNotFound(id);
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post("/:id/publish", validated("param", idParamSchema), async (c) => {
      const { publication, requeued } = await startPublication(deps, {
        publicationId: c.req.valid("param").id,
        dryRun: dryRunOf(deps),
        actor: actorOf(c),
      });
      const body: PublicationPublishResponse = {
        publication: publicationView(publication),
        requeued,
      };
      return c.json(body, 202);
    })
    .post("/:id/cancel", validated("param", idParamSchema), async (c) => {
      const publication = await cancelPublication(deps, {
        publicationId: c.req.valid("param").id,
        actor: actorOf(c),
      });
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post(
      "/:id/retire",
      validated("param", idParamSchema),
      validated("json", publicationRetireBodySchema),
      async (c) => {
        const { removedByHand } = c.req.valid("json");
        const result = await retirePublication(deps, {
          publicationId: c.req.valid("param").id,
          actor: actorOf(c),
          ...(removedByHand === undefined ? {} : { removedByHand }),
        });
        const body: PublicationRetireResponse = {
          publication: publicationView(result.publication),
          listingBackToReady: result.listingBackToReady,
        };
        return c.json(body, 200);
      },
    )
    .get("/:id/events", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      if ((await deps.publications.get(id)) === null) throw publicationNotFound(id);
      const events = await deps.publications.listEvents(id);
      const body: PublicationEventsResponse = { events: events.map(eventView) };
      return c.json(body, 200);
    });
}
