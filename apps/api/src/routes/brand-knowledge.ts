import {
  acceptKnowledgeProposal,
  addKnowledgeUpdate,
  archiveKnowledgeUpdate,
  type BrandKnowledgeRepository,
  type BrokerRepository,
  type ContentRunRepository,
  discardKnowledgeProposal,
  type EditorialProfileRepository,
  editKnowledgeUpdate,
  getBrandKnowledge,
  getKnowledgeRun,
  type JobQueue,
  type KnowledgeProposalRepository,
  listKnowledgeProposals,
  listKnowledgeUpdates,
  requestKnowledgeProposals,
  saveBrandKnowledge,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type AcceptProposalResponse,
  acceptProposalBodySchema,
  type BrandKnowledgeResponse,
  brandKnowledgeBodySchema,
  idParamSchema,
  type KnowledgeProposalsResponse,
  type KnowledgeRunDetailResponse,
  type KnowledgeRunResponse,
  type KnowledgeUpdateResponse,
  type KnowledgeUpdatesResponse,
  knowledgeProposalParamSchema,
  knowledgeProposalsBodySchema,
  knowledgeRunParamSchema,
  knowledgeUpdateBodySchema,
  knowledgeUpdateParamSchema,
  knowledgeUpdatesQuerySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type BrandKnowledgeRoutesDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  brandKnowledge: BrandKnowledgeRepository;
  knowledgeProposals: KnowledgeProposalRepository;
  editorialProfiles: EditorialProfileRepository;
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  queue: JobQueue;
};

/**
 * El conocimiento de la marca (spec F9.7 B1 y B2, ADR-0043), bajo `/brokers/:id` (el corredor de
 * la ruta, que `ownedBy` ya verificó en `app.ts`: lo de otro corredor es 404). Leer es `broker.view`
 * y cambiar es `brand.edit`, revisados en core:
 * - `GET/PUT /knowledge`: la postura, el tono y los ejemplos (con las novedades activas al leer);
 * - `GET/POST /knowledge/updates`, `PATCH/DELETE /knowledge/updates/:updateId` (borrar es archivar);
 * - `POST /knowledge/proposals` (una lectura de IA), `GET /knowledge/proposals`,
 *   `GET /knowledge/runs/:runId` y `POST /knowledge/proposals/:proposalId/accept|discard`.
 */
export function brandKnowledgeRoutes(deps: BrandKnowledgeRoutesDeps) {
  return new Hono<AppEnv>()
    .get("/:id/knowledge", validated("param", idParamSchema), async (c) => {
      const knowledge = await getBrandKnowledge(deps, requireAuth(c).user, c.req.valid("param").id);
      const body: BrandKnowledgeResponse = { knowledge };
      return c.json(body, 200);
    })
    .put(
      "/:id/knowledge",
      validated("param", idParamSchema),
      validated("json", brandKnowledgeBodySchema),
      async (c) => {
        const knowledge = await saveBrandKnowledge(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        const body: BrandKnowledgeResponse = { knowledge };
        return c.json(body, 200);
      },
    )
    .get(
      "/:id/knowledge/updates",
      validated("param", idParamSchema),
      validated("query", knowledgeUpdatesQuerySchema),
      async (c) => {
        const updates = await listKnowledgeUpdates(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          { includeArchived: c.req.valid("query").archived === "true" },
        );
        const body: KnowledgeUpdatesResponse = { updates };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/knowledge/updates",
      validated("param", idParamSchema),
      validated("json", knowledgeUpdateBodySchema),
      async (c) => {
        const update = await addKnowledgeUpdate(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        const body: KnowledgeUpdateResponse = { update };
        return c.json(body, 201);
      },
    )
    .patch(
      "/:id/knowledge/updates/:updateId",
      validated("param", knowledgeUpdateParamSchema),
      validated("json", knowledgeUpdateBodySchema),
      async (c) => {
        const { id, updateId } = c.req.valid("param");
        const update = await editKnowledgeUpdate(
          deps,
          requireAuth(c).user,
          id,
          updateId,
          c.req.valid("json"),
        );
        const body: KnowledgeUpdateResponse = { update };
        return c.json(body, 200);
      },
    )
    .delete(
      "/:id/knowledge/updates/:updateId",
      validated("param", knowledgeUpdateParamSchema),
      async (c) => {
        const { id, updateId } = c.req.valid("param");
        const update = await archiveKnowledgeUpdate(deps, requireAuth(c).user, id, updateId);
        const body: KnowledgeUpdateResponse = { update };
        return c.json(body, 200);
      },
    )
    .get("/:id/knowledge/proposals", validated("param", idParamSchema), async (c) => {
      const view = await listKnowledgeProposals(deps, requireAuth(c).user, c.req.valid("param").id);
      const body: KnowledgeProposalsResponse = view;
      return c.json(body, 200);
    })
    .post(
      "/:id/knowledge/proposals",
      validated("param", idParamSchema),
      validated("json", knowledgeProposalsBodySchema),
      async (c) => {
        const { sourceText: _text, ...run } = await requestKnowledgeProposals(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json").text,
        );
        const body: KnowledgeRunResponse = { run };
        return c.json(body, 202);
      },
    )
    .get("/:id/knowledge/runs/:runId", validated("param", knowledgeRunParamSchema), async (c) => {
      const { id, runId } = c.req.valid("param");
      const body: KnowledgeRunDetailResponse = await getKnowledgeRun(
        deps,
        requireAuth(c).user,
        id,
        runId,
      );
      return c.json(body, 200);
    })
    .post(
      "/:id/knowledge/proposals/:proposalId/accept",
      validated("param", knowledgeProposalParamSchema),
      validated("json", acceptProposalBodySchema),
      async (c) => {
        const { id, proposalId } = c.req.valid("param");
        const body: AcceptProposalResponse = await acceptKnowledgeProposal(
          deps,
          requireAuth(c).user,
          id,
          proposalId,
          c.req.valid("json"),
        );
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/knowledge/proposals/:proposalId/discard",
      validated("param", knowledgeProposalParamSchema),
      async (c) => {
        const { id, proposalId } = c.req.valid("param");
        await discardKnowledgeProposal(deps, requireAuth(c).user, id, proposalId);
        return c.json({ ok: true as const }, 200);
      },
    );
}
