import {
  BRAND_KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROPOSAL_KINDS,
  knowledgeExampleSchema,
  knowledgeProposalSchema,
  knowledgeRunSchema,
  knowledgeUpdateSchema,
} from "@agentsales/core";
import { z } from "zod";

// Contratos del conocimiento y el estilo de la marca (spec F9.7 parte B, ADR-0043). Solo la forma
// y topes holgados (el tamaño del pedido): las reglas con sus mensajes en español son de core.

const text = (max: number) => z.string().max(max + 50);
const L = BRAND_KNOWLEDGE_LIMITS;

// Las fechas viajan como texto ISO: se leen con `coerce`.
export const knowledgeExampleJsonSchema = knowledgeExampleSchema.extend({
  createdAt: z.coerce.date(),
});
export const knowledgeUpdateJsonSchema = knowledgeUpdateSchema.extend({
  createdAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type KnowledgeUpdateJson = z.infer<typeof knowledgeUpdateJsonSchema>;
export const knowledgeProposalJsonSchema = knowledgeProposalSchema.extend({
  createdAt: z.coerce.date(),
});
export type KnowledgeProposalJson = z.infer<typeof knowledgeProposalJsonSchema>;
export const knowledgeRunJsonSchema = knowledgeRunSchema.omit({ sourceText: true }).extend({
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
});
export type KnowledgeRunJson = z.infer<typeof knowledgeRunJsonSchema>;

/** `PUT /brokers/:id/knowledge`: la postura, el tono y los ejemplos (reemplaza; las novedades no). */
export const brandKnowledgeBodySchema = z
  .object({
    stance: text(L.stance).nullable(),
    tone: text(L.tone).nullable(),
    examples: z
      .array(
        z
          .object({
            text: text(L.example),
            note: text(L.exampleNote).nullable().optional(),
            favorite: z.boolean().optional(),
          })
          .strict(),
      )
      .max(L.examples * 2),
  })
  .strict();
export type BrandKnowledgeBody = z.infer<typeof brandKnowledgeBodySchema>;

/** `GET` y `PUT /brokers/:id/knowledge`. */
export const brandKnowledgeResponseSchema = z.object({
  knowledge: z.object({
    brokerId: z.string(),
    stance: z.string().nullable(),
    tone: z.string().nullable(),
    examples: z.array(knowledgeExampleJsonSchema),
    updates: z.array(knowledgeUpdateJsonSchema),
    updatesForAi: z.number().int().nonnegative(),
    updatedAt: z.coerce.date().nullable(),
  }),
});
export type BrandKnowledgeResponse = z.infer<typeof brandKnowledgeResponseSchema>;

/** `POST` y `PATCH` de una novedad. */
export const knowledgeUpdateBodySchema = z
  .object({ project: text(L.project), date: z.string().max(20), text: text(L.updateText) })
  .strict();
export type KnowledgeUpdateBody = z.infer<typeof knowledgeUpdateBodySchema>;

export const knowledgeUpdateParamSchema = z.object({ id: z.uuid(), updateId: z.uuid() });
export const knowledgeUpdatesQuerySchema = z.object({
  archived: z.enum(["true", "false"]).optional(),
});
export const knowledgeUpdateResponseSchema = z.object({ update: knowledgeUpdateJsonSchema });
export type KnowledgeUpdateResponse = z.infer<typeof knowledgeUpdateResponseSchema>;
export const knowledgeUpdatesResponseSchema = z.object({
  updates: z.array(knowledgeUpdateJsonSchema),
});
export type KnowledgeUpdatesResponse = z.infer<typeof knowledgeUpdatesResponseSchema>;

/** `POST /brokers/:id/knowledge/proposals`: el texto largo (B2). */
export const knowledgeProposalsBodySchema = z.object({ text: text(L.sourceText) }).strict();
export const knowledgeRunResponseSchema = z.object({ run: knowledgeRunJsonSchema });
export type KnowledgeRunResponse = z.infer<typeof knowledgeRunResponseSchema>;

/** `GET /brokers/:id/knowledge/proposals`: las lecturas recientes y lo que espera al operador. */
export const knowledgeProposalsResponseSchema = z.object({
  runs: z.array(knowledgeRunJsonSchema),
  pending: z.array(knowledgeProposalJsonSchema),
});
export type KnowledgeProposalsResponse = z.infer<typeof knowledgeProposalsResponseSchema>;

export const knowledgeProposalParamSchema = z.object({ id: z.uuid(), proposalId: z.uuid() });
export const knowledgeRunParamSchema = z.object({ id: z.uuid(), runId: z.uuid() });
export const knowledgeRunDetailResponseSchema = z.object({
  run: knowledgeRunJsonSchema,
  proposals: z.array(knowledgeProposalJsonSchema),
});
export type KnowledgeRunDetailResponse = z.infer<typeof knowledgeRunDetailResponseSchema>;

/** `POST …/proposals/:proposalId/accept`: con lo que el operador editó (todo opcional). */
export const acceptProposalBodySchema = z
  .object({
    kind: z.enum(KNOWLEDGE_PROPOSAL_KINDS).optional(),
    text: text(L.updateText).optional(),
    project: text(L.project).optional(),
    date: z.string().max(20).optional(),
  })
  .strict();
export type AcceptProposalBody = z.infer<typeof acceptProposalBodySchema>;

export const acceptProposalResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update"), update: knowledgeUpdateJsonSchema }),
  z.object({ kind: z.literal("fact"), facts: z.array(z.string()) }),
]);
export type AcceptProposalResponse = z.infer<typeof acceptProposalResponseSchema>;

/** `POST …/proposals/:proposalId/discard`. */
export const discardProposalResponseSchema = z.object({ ok: z.literal(true) });
