import {
  type ApprovePostWeekDeps,
  approvePostWeek,
  type DailyReadinessDeps,
  getDailyReadiness,
  getPostWeek,
  type ImageAiPricing,
  type PostWeekDeps,
  type PublishMode,
  type WorkerHeartbeat,
  workerStatusOf,
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
import { brokerMode, isDryRun } from "../publish-modes.js";
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
    /** Si el worker se enciende solo (`WORKER_IDLE_EXIT_MINUTES` > 0, ADR-0037). */
    workerScheduled: boolean;
    /** Los latidos del worker (F8-T12): si está encendido. Sin ellos, no se sabe. */
    workerHeartbeats?: () => Promise<WorkerHeartbeat[]>;
    /** La IA de imágenes (F9.5-T25): su precio y tope, o `null` sin la clave. */
    imageSources: { ai: ImageAiPricing | null };
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
        // El modo de la marca (ADR-0036): en vivo solo con el servidor y la marca encendidos.
        const dryRun = isDryRun(await brokerMode(deps, brokerId));
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
      const { user } = requireAuth(c);
      // El estado del worker solo lo ve el administrador (como el detalle de `/health`).
      const admin = user.role === "admin";
      const readiness = await getDailyReadiness(deps, user, {
        brokerId,
        effectiveMode: await brokerMode(deps, brokerId),
        server: deps.publishMode,
        workerSchedule: admin ? deps.workerScheduled : null,
        workerRunning:
          admin && deps.workerHeartbeats !== undefined
            ? await deps.workerHeartbeats().then(
                (beats) => workerStatusOf(beats, new Date()).running,
                () => null,
              )
            : null,
        imageAi: deps.imageSources.ai,
      });
      const body: DailyReadinessResponse = { readiness };
      return c.json(body, 200);
    });
}
