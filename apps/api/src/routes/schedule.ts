import {
  AppError,
  inScope,
  type ListingRepository,
  type ScheduleDeps,
  scheduleListings,
} from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import { type ScheduleResponse, scheduleBodySchema } from "../contracts/index.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";
import { actorOf, publicationView } from "./publication-views.js";

export type ScheduleRoutesDeps = Omit<ScheduleDeps, "publications"> & {
  /** El modo de lo que se programa (D11): el de la API ahora, nunca del cuerpo. */
  publishMode: "dry-run" | "live";
  /** Para revisar que cada propiedad del lote sea del corredor (spec F7 §4.4). */
  listings: Pick<ListingRepository, "get">;
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
      for (const id of new Set(listingIds)) {
        const listing = await deps.listings.get(id);
        if (listing === null || !inScope(scope, listing.brokerId)) {
          throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`);
        }
      }
    }
    const result = await scheduleListings(deps, {
      listingIds,
      at: new Date(at),
      dryRun: deps.publishMode !== "live",
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
