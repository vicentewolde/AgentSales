import {
  type BrokerRepository,
  type ContentRepository,
  type ContentRunRepository,
  type EditorialProfileRepository,
  getPlanRun,
  type JobQueue,
  listPlanRuns,
  type PlanRun,
  type PlanRunRepository,
  type PlatformAccountRepository,
  type PostRepository,
  planRunErrorAdvice,
  planRunPeriod,
  planRunRequestSchema,
  postSubject,
  requestPlanRun,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  idParamSchema,
  type PlanDetailResponse,
  type PlanIdeaView,
  type PlanListResponse,
  type PlanRequestResponse,
  type PlanRunView,
  planQuerySchema,
  planRequestBodySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";
import { contentRunView } from "./content.js";

export type PlanRoutesDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  planRuns: Pick<PlanRunRepository, "create" | "get" | "listByBroker" | "markFailed">;
  posts: Pick<PostRepository, "list">;
  /** El tope de IA del mes (`sumLlmCost`) y el estado de los textos de cada idea (`latest`). */
  contentRuns: Pick<ContentRunRepository, "sumLlmCost" | "latest">;
  contents: Pick<ContentRepository, "listCurrent">;
  /** `content.plan`, después de crear el plan. */
  queue: JobQueue;
};

/** Un plan como lo ven la CLI y el panel (sin el gasto ni el proveedor de IA). */
export function planRunView(run: PlanRun): PlanRunView {
  const request = planRunRequestSchema.safeParse(run.request);
  const { firstDay, lastDay } = planRunPeriod(run);
  return {
    id: run.id,
    brokerId: run.brokerId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    firstDay,
    lastDay,
    status: run.status,
    platforms: request.success ? request.data.platforms : [],
    count: request.success ? request.data.count : null,
    error: run.error === null ? null : { code: run.error.code, message: run.error.message },
    errorAdvice: run.error === null ? null : planRunErrorAdvice(run.error.code),
    promptVersion: run.promptVersion,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

/**
 * `/plans` (spec F9 §4.9 y §4.10, F9-T21): pedir un plan de ideas (encola `content.plan` después de
 * crearlo), listar los de una marca y ver uno con sus ideas. Todo con `posts.manage`, revisado en
 * core; un plan de otra marca no existe (404, también por `ownedBy` en `app.ts`). Aceptar y
 * descartar una idea son rutas del post (`/posts/:id/accept|discard`).
 */
export function planRoutes(deps: PlanRoutesDeps) {
  return (
    new Hono<AppEnv>()
      .post("/", validated("json", planRequestBodySchema), async (c) => {
        const input = c.req.valid("json");
        const { run, reused } = await requestPlanRun(deps, requireAuth(c).user, input);
        const body: PlanRequestResponse = { plan: planRunView(run), reused };
        return c.json(body, 202);
      })
      // Los más recientes, `PLAN_RUNS_LIST_LIMIT.default` (20); el contrato no expone `limit`.
      .get("/", validated("query", planQuerySchema), async (c) => {
        const { brokerId } = c.req.valid("query");
        const runs = await listPlanRuns(deps, requireAuth(c).user, { brokerId });
        const body: PlanListResponse = { plans: runs.map(planRunView) };
        return c.json(body, 200);
      })
      .get("/:id", validated("param", idParamSchema), async (c) => {
        const { run, report, ideas } = await getPlanRun(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
        );
        const notes = new Map((report?.ideas ?? []).map((idea) => [idea.postId, idea.notes]));
        // Los textos y la corrida solo de las aceptadas (borrador o listo): una idea sin decidir no
        // tiene, y una descartada ya no importa. Así el sondeo del panel (cada 2 s mientras algo
        // corre) lee lo mínimo sin sumar una lectura en lote a los repositorios.
        const views: PlanIdeaView[] = await Promise.all(
          ideas.map(async (post) => {
            if (post.status !== "draft" && post.status !== "ready") {
              return { ...post, notes: notes.get(post.id) ?? [], texts: 0, latestRun: null };
            }
            const subject = postSubject(post.id);
            const [contents, latest] = await Promise.all([
              deps.contents.listCurrent(subject),
              deps.contentRuns.latest(subject),
            ]);
            return {
              ...post,
              notes: notes.get(post.id) ?? [],
              texts: contents.length,
              latestRun: latest === null ? null : contentRunView(latest),
            };
          }),
        );
        const body: PlanDetailResponse = {
          plan: planRunView(run),
          report:
            report === null
              ? null
              : {
                  discarded: report.discarded.map(({ topic, code, message }) => ({
                    topic,
                    code,
                    message,
                  })),
                  warnings: report.warnings,
                },
          ideas: views,
        };
        return c.json(body, 200);
      })
  );
}
