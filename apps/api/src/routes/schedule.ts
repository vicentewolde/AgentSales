import {
  AppError,
  type BrokerRepository,
  type ListingRepository,
  type PublishMode,
  type ScheduleDeps,
  scheduleListings,
} from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import { type ScheduleResponse, scheduleBodySchema } from "../contracts/index.js";
import { isDryRun, listingMode } from "../publish-modes.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";
import { actorOf, publicationView } from "./publication-views.js";

export type ScheduleRoutesDeps = Omit<ScheduleDeps, "publications"> & {
  /**
   * El modo **del servidor** (D11): con el de la marca de cada propiedad (ADR-0036) da el de lo que
   * se programa; nunca sale del cuerpo.
   */
  publishMode: PublishMode;
  brokers: Pick<BrokerRepository, "findById">;
  /** Para revisar que cada propiedad del lote sea del corredor (spec F7 §4.4) y su marca. */
  listings: Pick<ListingRepository, "list" | "get">;
};

/**
 * `POST /schedule` (spec F6 §4.3): programa una o varias propiedades a una hora, con espaciado.
 * Una propiedad que no se puede programar no corta el lote: el resultado dice qué pasó con cada una.
 */
export function scheduleRoutes(deps: ScheduleRoutesDeps) {
  return new Hono<AppEnv>().post("/", validated("json", scheduleBodySchema), async (c) => {
    const { listingIds, platforms, at, spacingMinutes } = c.req.valid("json");
    // Todo o nada (spec F7 §4.4): si alguna propiedad no es del corredor, no se programa ninguna y
    // se responde como si no existiera.
    const scope = requestScope(c);
    if (scope.kind === "broker") {
      // Una consulta: las propiedades del corredor (filtradas en SQL).
      const own = new Set((await deps.listings.list({}, scope)).map((listing) => listing.id));
      const foreign = listingIds.find((id) => !own.has(id));
      if (foreign !== undefined) {
        throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${foreign}`);
      }
    }
    const result = await scheduleListings(deps, {
      listingIds,
      at: new Date(at),
      dryRun: async (listingId) => isDryRun(await listingMode(deps, listingId)),
      actor: actorOf(c),
      ...(platforms === undefined ? {} : { platforms }),
      ...(spacingMinutes === undefined ? {} : { spacingMinutes }),
    });
    const body: ScheduleResponse = {
      results: result.results.map((row) =>
        row.outcome === "scheduled"
          ? {
              listingId: row.listingId,
              platform: row.platform,
              outcome: row.outcome,
              at: row.at,
              publications: row.publications.map((publication) => publicationView(publication)),
            }
          : {
              listingId: row.listingId,
              platform: row.platform,
              outcome: row.outcome,
              code: row.code,
              message: row.message,
            },
      ),
      notes: result.notes,
    };
    return c.json(body, 200);
  });
}
