import { type ScheduleDeps, scheduleListings } from "@agentsales/core";
import { Hono } from "hono";
import { type ScheduleResponse, scheduleBodySchema } from "../contracts/index.js";
import { validated } from "../validation.js";
import { actorOf, publicationView } from "./publication-views.js";

export type ScheduleRoutesDeps = Omit<ScheduleDeps, "publications"> & {
  /** El modo de lo que se programa (D11): el de la API ahora, nunca del cuerpo. */
  publishMode: "dry-run" | "live";
};

/**
 * `POST /schedule` (spec F6 §4.3): programa una o varias propiedades a una hora, con espaciado.
 * Una propiedad que no se puede programar no corta el lote: el resultado dice qué pasó con cada una.
 */
export function scheduleRoutes(deps: ScheduleRoutesDeps) {
  return new Hono().post("/", validated("json", scheduleBodySchema), async (c) => {
    const { listingIds, platforms, at, spacingMinutes } = c.req.valid("json");
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
