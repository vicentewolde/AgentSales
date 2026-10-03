import {
  AppError,
  changeListingStatus,
  type FieldDefinitionRepository,
  type Listing,
  type ListingRepository,
  listingFields,
  type MediaRepository,
  type MediaStorage,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  idParamSchema,
  type ListingDetailResponse,
  type ListingListResponse,
  type ListingStatusResponse,
  listingQuerySchema,
  listingStatusBodySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type ListingRoutesDeps = {
  listings: ListingRepository;
  media: MediaRepository;
  /** Las etiquetas de los atributos del detalle (definiciones efectivas del corredor). */
  fieldDefinitions: FieldDefinitionRepository;
  /** Solo para las URLs de lectura temporales de las fotos (R2 es privado, ADR-0007). */
  storage: Pick<MediaStorage, "signedReadUrl">;
};

const notFound = (id: string) =>
  new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`, { details: { listingId: id } });

/** `/listings`: lista con portada, detalle con medios y cambio manual de estado (spec F1 §4.4). */
export function listingRoutes(deps: ListingRoutesDeps) {
  return new Hono()
    .get("/", validated("query", listingQuerySchema), async (c) => {
      const listings = await deps.listings.list(c.req.valid("query"));
      const covers = await deps.media.listCovers(listings.map((listing) => listing.id));
      const coverOf = new Map(covers.map((cover) => [cover.listingId, cover.storagePath]));
      const body: ListingListResponse = {
        listings: await Promise.all(
          listings.map(async (listing) => {
            const path = coverOf.get(listing.id);
            return {
              ...listing,
              coverUrl: path === undefined ? null : await deps.storage.signedReadUrl(path),
            };
          }),
        ),
      };
      return c.json(body, 200);
    })
    .get("/:id", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const listing = await deps.listings.get(id);
      if (listing === null) throw notFound(id);
      const media = await deps.media.listOriginals(id);
      const definitions = await deps.fieldDefinitions.list({
        category: listing.category,
        brokerId: listing.brokerId,
      });
      const body: ListingDetailResponse = {
        listing,
        fields: listingFields(definitions, listing.attributes),
        media: await Promise.all(
          media.map(async (item) => ({
            id: item.id,
            kind: item.kind,
            mime: item.mime,
            bytes: item.bytes,
            sortOrder: item.sortOrder,
            isCover: item.isCover,
            url: await deps.storage.signedReadUrl(item.storagePath),
          })),
        ),
      };
      return c.json(body, 200);
    })
    .patch(
      "/:id/status",
      validated("param", idParamSchema),
      validated("json", listingStatusBodySchema),
      async (c) => {
        // Pasar al mismo estado (un doble clic) también es 409: la tabla no tiene `x → x`.
        const listing: Listing = await changeListingStatus(deps, {
          listingId: c.req.valid("param").id,
          status: c.req.valid("json").status,
        });
        const body: ListingStatusResponse = { listing };
        return c.json(body, 200);
      },
    );
}
