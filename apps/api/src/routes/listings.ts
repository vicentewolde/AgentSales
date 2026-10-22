import {
  AppError,
  type BrokerRepository,
  type ChangeListingStatusDeps,
  changeListingStatus,
  type FieldDefinitionRepository,
  type ListingRepository,
  listingFields,
  listingSubject,
  type MediaRepository,
  type MediaStorage,
  type PublishMode,
  setListingMusic,
} from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import {
  idParamSchema,
  type ListingDetailResponse,
  type ListingListResponse,
  type ListingResponse,
  type ListingStatusResponse,
  listingQuerySchema,
  listingStatusBodySchema,
  listingUpdateBodySchema,
} from "../contracts/index.js";
import { listingMode } from "../publish-modes.js";
import { listScope } from "../scope.js";
import { validated } from "../validation.js";
import { actorOf, publicationView } from "./publication-views.js";
import { OPERATION_TIMEOUT_MS, operationError } from "./publications.js";

export type ListingRoutesDeps = {
  listings: ListingRepository;
  /** El filtro `?broker=<slug>` (spec F7 §4.4) y el modo de la marca al cambiar el estado (ADR-0036). */
  brokers: Pick<BrokerRepository, "findBySlug" | "findById">;
  /** El modo del servidor (`PUBLISH_MODE`): con el de la marca da el de cada cambio (ADR-0036). */
  publishMode: PublishMode;
  media: MediaRepository;
  /** Las etiquetas de los atributos del detalle (definiciones efectivas del corredor). */
  fieldDefinitions: FieldDefinitionRepository;
  /** Solo para las URLs de lectura temporales de las fotos (R2 es privado, ADR-0007). */
  storage: Pick<MediaStorage, "signedReadUrl">;
  /** Cambiar el estado orquesta las publicaciones (F6-T08): las mismas piezas que pausar o cerrar. */
  statusChange: Omit<ChangeListingStatusDeps, "apiMode">;
  /** Por defecto `OPERATION_TIMEOUT_MS`; los tests lo bajan para ver el corte. */
  operationTimeoutMs?: number;
};

/**
 * La ruta de la portada de cada aviso: la miniatura si existe (una portada HEIC no se ve en el
 * navegador), y si no el original. Dos consultas para toda la lista, no una por aviso (spec F2
 * §4.7). La usan `GET /listings` y, desde F6-T10, `GET /tracking`.
 */
export async function coverPaths(
  media: Pick<MediaRepository, "listCovers" | "listVariants">,
  listingIds: readonly string[],
): Promise<Map<string, string>> {
  const covers = await media.listCovers(listingIds);
  const thumbs = await media.listVariants(
    covers.map((cover) => cover.id),
    "thumb",
  );
  const thumbOf = new Map(thumbs.map((thumb) => [thumb.parentMediaId, thumb.storagePath]));
  const paths = new Map<string, string>();
  for (const cover of covers) {
    if (cover.listingId !== null) {
      paths.set(cover.listingId, thumbOf.get(cover.id) ?? cover.storagePath);
    }
  }
  return paths;
}

const notFound = (id: string) =>
  new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`, { details: { listingId: id } });

/** `/listings`: lista con portada, detalle con medios y cambio manual de estado (spec F1 §4.4). */
export function listingRoutes(deps: ListingRoutesDeps) {
  const signedOrNull = async (path: string | undefined) =>
    path === undefined ? null : deps.storage.signedReadUrl(path);
  return (
    new Hono<AppEnv>()
      .get("/", validated("query", listingQuerySchema), async (c) => {
        const { broker, ...filters } = c.req.valid("query");
        const listings = await deps.listings.list(
          filters,
          await listScope(c, deps.brokers, broker),
        );
        const coverOf = await coverPaths(
          deps.media,
          listings.map((listing) => listing.id),
        );
        const body: ListingListResponse = {
          listings: await Promise.all(
            listings.map(async (listing) => {
              const path = coverOf.get(listing.id);
              // La proyección de la lista (spec F7 §4.4): sin notas internas, dirección ni atributos.
              const {
                internalNotes: _notes,
                address: _address,
                unitNumber: _unit,
                attributes: _attributes,
                ...summary
              } = listing;
              return {
                ...summary,
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
        // Una consulta: los originales (en orden y con sus medidas) y sus miniaturas.
        const all = await deps.media.listBySubject(listingSubject(id));
        const media = all.filter((item) => item.role === "original");
        const thumbOf = new Map(
          all
            .filter((item) => item.role === "processed" && item.variant === "thumb")
            .map((thumb) => [thumb.parentMediaId, thumb.storagePath]),
        );
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
              thumbUrl: await signedOrNull(thumbOf.get(item.id)),
              width: item.width,
              height: item.height,
              durationS: item.durationS,
            })),
          ),
        };
        return c.json(body, 200);
      })
      // F9.5-T19: la música del reel. La siguiente preparación rehace el reel con ella.
      .patch(
        "/:id",
        validated("param", idParamSchema),
        validated("json", listingUpdateBodySchema),
        async (c) => {
          const listing = await setListingMusic(deps, {
            listingId: c.req.valid("param").id,
            musicTrackId: c.req.valid("json").musicTrackId,
          });
          const body: ListingResponse = { listing };
          return c.json(body, 200);
        },
      )
      .post(
        "/:id/status",
        validated("param", idParamSchema),
        validated("json", listingStatusBodySchema),
        async (c) => {
          // La propiedad manda (spec F6 §4.8, ADR-0019): las llamadas a Portal comparten un solo tope
          // de `OPERATION_TIMEOUT_MS` para toda la acción; al vencer, la acción se detiene con su
          // error y repetirla salta lo ya hecho.
          const { action, reason, confirmed } = c.req.valid("json");
          let result: Awaited<ReturnType<typeof changeListingStatus>>;
          try {
            result = await changeListingStatus(
              {
                ...deps.statusChange,
                apiMode: await listingMode(deps, c.req.valid("param").id),
              },
              {
                listingId: c.req.valid("param").id,
                action,
                actor: actorOf(c),
                ...(reason === undefined ? {} : { reason }),
                ...(confirmed === undefined ? {} : { confirmed }),
                signal: AbortSignal.timeout(deps.operationTimeoutMs ?? OPERATION_TIMEOUT_MS),
              },
            );
          } catch (error) {
            throw operationError(error);
          }
          const body: ListingStatusResponse = {
            listing: result.listing,
            changed: result.changed.map((publication) => publicationView(publication)),
            manualTasks: result.manualTasks.map((publication) => publicationView(publication)),
          };
          return c.json(body, 200);
        },
      )
  );
}
