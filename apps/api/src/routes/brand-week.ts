import {
  type ApprovePostWeekDeps,
  approvePostWeek,
  type DailyReadinessDeps,
  getDailyReadiness,
  getPostWeek,
  type PostWeekDeps,
  type PublishMode,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type DailyReadinessResponse,
  idParamSchema,
  type PostWeekApproveResponse,
  type PostWeekResponse,
  postWeekApproveBodySchema,
  postWeekQuerySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";
import { contentView } from "./content.js";
import { actorOf, publicationView } from "./publication-views.js";

export type BrandWeekRoutesDeps = PostWeekDeps &
  Omit<ApprovePostWeekDeps, "postReview"> &
  DailyReadinessDeps & {
    /**
     * El modo **del servidor** (D11). Con el de la marca (ADR-0036) da el modo con que se programa;
     * nunca sale del cuerpo.
     */
    publishMode: PublishMode;
    /** Si el worker se enciende solo (`WORKER_IDLE_EXIT_MINUTES` > 0, ADR-0037); `null` si no se sabe. */
    workerScheduled: boolean | null;
  };

/**
 * Publicar a diario desde una marca (F9.5-T27), bajo `/brokers/:id` (el corredor de la ruta, que
 * `ownedBy` ya verificó en `app.ts`: lo de otro corredor es 404):
 * - `GET /week?day=`: los posts aceptados de la semana con sus textos y publicaciones;
 * - `POST /week/approve`: «Aprobar la semana», aprueba y programa cada post a su fecha, en el modo
 *   de la marca; nunca publica en el momento;
 * - `GET /daily-readiness`: la lista «Lista para publicar a diario».
 */
export function brandWeekRoutes(deps: BrandWeekRoutesDeps) {
  // Los textos de un post se revisan con el perfil editorial de su marca, como al aprobar uno.
  const approveDeps = {
    ...deps,
    postReview: { posts: deps.posts, editorialProfiles: deps.editorialProfiles },
  };
  /** El modo con que saldría lo de la marca: hoy, el del servidor para todas. */
  const brandMode = async (_brokerId: string): Promise<PublishMode> => deps.publishMode;
  return new Hono<AppEnv>()
    .get(
      "/:id/week",
      validated("param", idParamSchema),
      validated("query", postWeekQuerySchema),
      async (c) => {
        const { day } = c.req.valid("query");
        const week = await getPostWeek(deps, requireAuth(c).user, {
          brokerId: c.req.valid("param").id,
          day,
        });
        const body: PostWeekResponse = {
          week: week.week,
          lastDay: week.lastDay,
          ideas: week.ideas,
          posts: week.posts.map((item) => ({
            post: item.post,
            contents: item.contents.map(contentView),
            publications: item.publications.map(publicationView),
          })),
        };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/week/approve",
      validated("param", idParamSchema),
      validated("json", postWeekApproveBodySchema),
      async (c) => {
        const brokerId = c.req.valid("param").id;
        const dryRun = (await brandMode(brokerId)) === "dry-run";
        const result = await approvePostWeek(approveDeps, requireAuth(c).user, {
          brokerId,
          day: c.req.valid("json").day,
          dryRun,
          by: actorOf(c),
        });
        const body: PostWeekApproveResponse = {
          week: result.week,
          lastDay: result.lastDay,
          ideas: result.ideas,
          dryRun,
          posts: result.posts,
        };
        return c.json(body, 200);
      },
    )
    .get("/:id/daily-readiness", validated("param", idParamSchema), async (c) => {
      const brokerId = c.req.valid("param").id;
      const readiness = await getDailyReadiness(deps, requireAuth(c).user, {
        brokerId,
        effectiveMode: await brandMode(brokerId),
        server: deps.publishMode,
        workerSchedule: deps.workerScheduled,
      });
      const body: DailyReadinessResponse = { readiness };
      return c.json(body, 200);
    });
}
