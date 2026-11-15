import type { AbortSignalLike } from "../abort.js";
import {
  BRAND_KNOWLEDGE_LIMITS,
  type KnowledgeProposal,
  type KnowledgeRun,
  type KnowledgeUpdate,
  type KnowledgeUpdateInput,
  normalizeKnowledgeSourceText,
  normalizeKnowledgeUpdate,
} from "../brand-knowledge.js";
import { generateValidated } from "../content/generate.js";
import { contentRunErrorOf } from "../content/run-error.js";
import { editorialProfileView, normalizeEditorialProfile } from "../editorial-profile.js";
import { AppError, isAppError } from "../errors.js";
import { assertLlmBudget, llmProviderFor } from "../llm-budget.js";
import { llmCallCost } from "../llm-usage.js";
import type {
  BrandKnowledgeRepository,
  KnowledgeProposalRepository,
} from "../ports/brand-knowledge-repository.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import {
  buildKnowledgePrompt,
  KNOWLEDGE_JSON_SCHEMA,
  validateKnowledgeResponse,
} from "../social/knowledge-prompt.js";
import type { User } from "../user.js";
import { assertBrandAccess, assertRoomForUpdate } from "./brand-knowledge.js";

// «Actualizar desde un texto largo» (spec F9.7 B2, ADR-0043 punto 2): el operador pega un texto,
// la IA propone novedades y hechos (una corrida, job `brand.propose`) y el operador acepta (con
// edición) o descarta cada propuesta. Nada entra al conocimiento sin él (D2).

type Actor = Pick<User, "id" | "role" | "brokerId">;

export type RequestKnowledgeProposalsDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  knowledgeProposals: Pick<KnowledgeProposalRepository, "createRun" | "markFailed">;
  /** Para el tope de IA del mes (`sumLlmCost` suma también estas lecturas). */
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  queue: JobQueue;
  now?: () => Date;
};

/**
 * Pide la lectura de un texto (`brand.edit`): valida el texto (20 a 20.000 caracteres), revisa el
 * tope de IA del mes de la marca (`LLM_BUDGET_EXCEEDED`, 409), crea la corrida (una activa por
 * marca: `KNOWLEDGE_RUN_CONFLICT`, 409) y encola `brand.propose`. Si la cola no responde, la
 * corrida queda `failed` con `QUEUE_UNAVAILABLE`.
 */
export async function requestKnowledgeProposals(
  deps: RequestKnowledgeProposalsDeps,
  actor: Actor,
  brokerId: string,
  text: string,
): Promise<KnowledgeRun> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  const sourceText = normalizeKnowledgeSourceText(text);
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`);
  }
  await assertLlmBudget(deps, broker, (deps.now ?? (() => new Date()))());
  const run = await deps.knowledgeProposals.createRun({
    brokerId,
    sourceText,
    createdBy: actor.id ?? null,
  });
  try {
    await deps.queue.enqueue("brand.propose", { knowledgeRunId: run.id }, { singletonKey: run.id });
  } catch (cause) {
    const error = {
      code: "QUEUE_UNAVAILABLE",
      message: "No se pudo encolar la lectura: vuelve a intentarlo",
    };
    await deps.knowledgeProposals.markFailed(run.id, error).catch(() => false);
    throw new AppError("QUEUE_UNAVAILABLE", error.message, { retriable: true, cause });
  }
  return { ...run };
}

export type RunKnowledgeProposalsDeps = {
  knowledgeProposals: Pick<
    KnowledgeProposalRepository,
    "getRun" | "markRunning" | "markSucceeded" | "markFailed" | "addLlmUsage"
  >;
  brokers: Pick<BrokerRepository, "findById">;
  /** Los hechos actuales (para no repetirlos). */
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  /** Las novedades actuales (para no repetirlas). */
  brandKnowledge: Pick<BrandKnowledgeRepository, "listUpdates">;
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  llm: LLMProvider;
  apiLlm?: LLMProvider | null;
  now?: () => Date;
};

export type RunKnowledgeProposalsResult =
  | { outcome: "succeeded"; proposals: number }
  | { outcome: "skipped"; status: KnowledgeRun["status"] };

/**
 * Atiende una lectura (job `brand.propose`): la IA de la marca con su tope (antes de cada llamada)
 * y su gasto anotado por llamada; la respuesta validada con zod (un reintento) y las propuestas
 * guardadas `pending` con la corrida, en una transacción. Un error no reintentable, o el último
 * intento, deja la corrida `failed` con un mensaje limpio.
 */
export async function runKnowledgeProposals(
  deps: RunKnowledgeProposalsDeps,
  params: { knowledgeRunId: string; isLastAttempt: boolean; signal?: AbortSignalLike },
): Promise<RunKnowledgeProposalsResult> {
  const run = await deps.knowledgeProposals.getRun(params.knowledgeRunId);
  if (run === null) {
    throw new AppError("KNOWLEDGE_RUN_NOT_FOUND", `No existe la lectura ${params.knowledgeRunId}`);
  }
  if (run.status === "succeeded" || run.status === "failed") {
    return { outcome: "skipped", status: run.status };
  }
  if (!(await deps.knowledgeProposals.markRunning(run.id))) {
    const current = await deps.knowledgeProposals.getRun(run.id);
    return { outcome: "skipped", status: current?.status ?? run.status };
  }
  try {
    const broker = await deps.brokers.findById(run.brokerId);
    if (broker === null) throw new AppError("BROKER_NOT_FOUND", "No existe la marca de la lectura");
    const profile = editorialProfileView(broker.id, await deps.editorialProfiles.get(broker.id));
    const updates = await deps.brandKnowledge.listUpdates(broker.id, { limit: 60 });
    const clock = deps.now ?? (() => new Date());
    const llm = llmProviderFor(broker, { own: deps.llm, api: deps.apiLlm ?? null });
    const { data } = await generateValidated(
      {
        llm,
        beforeCall: async () => {
          const current = (await deps.brokers.findById(broker.id)) ?? broker;
          await assertLlmBudget(deps, current, clock());
        },
        onUsage: async (model, usage) => {
          await deps.knowledgeProposals.addLlmUsage(run.id, llmCallCost(llm.name, model, usage));
        },
      },
      {
        buildPrompt: (issues) =>
          buildKnowledgePrompt(
            {
              brandName: broker.brandName,
              sourceText: run.sourceText,
              facts: profile.facts,
              updates: updates.map(({ date, project, text }) => ({ date, project, text })),
            },
            issues,
          ),
        jsonSchema: KNOWLEDGE_JSON_SCHEMA,
        validate: validateKnowledgeResponse,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
      },
    );
    const saved = await deps.knowledgeProposals.markSucceeded(run.id, {
      warnings: data.warnings,
      proposals: data.proposals,
    });
    if (!saved) {
      const current = await deps.knowledgeProposals.getRun(run.id);
      return { outcome: "skipped", status: current?.status ?? "succeeded" };
    }
    return { outcome: "succeeded", proposals: data.proposals.length };
  } catch (caught) {
    const error = isAppError(caught)
      ? caught
      : new AppError("INTERNAL_ERROR", "Error interno al leer el texto", { cause: caught });
    if (!error.retriable || params.isLastAttempt) {
      await deps.knowledgeProposals.markFailed(run.id, contentRunErrorOf(error)).catch(() => false);
    }
    throw error;
  }
}

/** Las lecturas recientes y las propuestas que esperan, como las ven la API y la CLI. */
export type KnowledgeProposalsView = {
  runs: Omit<KnowledgeRun, "sourceText">[];
  pending: KnowledgeProposal[];
};

/** Las lecturas recientes (sin el texto) y las propuestas pendientes (`broker.view`). */
export async function listKnowledgeProposals(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    knowledgeProposals: Pick<KnowledgeProposalRepository, "listRuns" | "listProposals">;
  },
  actor: Pick<User, "role" | "brokerId">,
  brokerId: string,
): Promise<KnowledgeProposalsView> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  const [runs, pending] = await Promise.all([
    deps.knowledgeProposals.listRuns(brokerId, 5),
    deps.knowledgeProposals.listProposals(brokerId, { status: "pending", limit: 100 }),
  ]);
  return { runs: runs.map(({ sourceText: _text, ...rest }) => rest), pending };
}

/** Una lectura de la marca, sin el texto (`broker.view`). */
export async function getKnowledgeRun(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    knowledgeProposals: Pick<KnowledgeProposalRepository, "getRun" | "listProposals">;
  },
  actor: Pick<User, "role" | "brokerId">,
  brokerId: string,
  runId: string,
): Promise<{ run: Omit<KnowledgeRun, "sourceText">; proposals: KnowledgeProposal[] }> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  const run = await deps.knowledgeProposals.getRun(runId);
  if (run === null || run.brokerId !== brokerId) {
    throw new AppError("KNOWLEDGE_RUN_NOT_FOUND", `No existe la lectura ${runId}`);
  }
  const { sourceText: _text, ...rest } = run;
  const proposals = (await deps.knowledgeProposals.listProposals(brokerId, { limit: 200 })).filter(
    (proposal) => proposal.runId === runId,
  );
  return { run: rest, proposals };
}

async function pendingProposal(
  repo: Pick<KnowledgeProposalRepository, "getProposal">,
  brokerId: string,
  proposalId: string,
): Promise<KnowledgeProposal> {
  const proposal = await repo.getProposal(proposalId);
  if (proposal === null || proposal.brokerId !== brokerId) {
    throw new AppError("KNOWLEDGE_PROPOSAL_NOT_FOUND", `No existe la propuesta ${proposalId}`);
  }
  if (proposal.status !== "pending") {
    throw new AppError(
      "KNOWLEDGE_PROPOSAL_RESOLVED",
      proposal.status === "accepted"
        ? "Esa propuesta ya se aceptó"
        : "Esa propuesta ya se descartó",
    );
  }
  return proposal;
}

/** Lo que el operador cambia al aceptar (B2: «aceptar con edición»). */
export type AcceptProposalEdit = {
  /** Aceptarla como otra cosa: una novedad como hecho o al revés. */
  kind?: "update" | "fact";
  text?: string;
  project?: string;
  date?: string;
};

export type AcceptProposalResult =
  | { kind: "update"; update: KnowledgeUpdate }
  | { kind: "fact"; facts: string[] };

/**
 * Acepta una propuesta (`brand.edit`), con lo que el operador haya editado: una novedad entra a las
 * novedades (`source = proposal`; sin fecha, la de hoy); un hecho se suma a los hechos del perfil
 * editorial (con sus reglas: `EDITORIAL_PROFILE_INVALID` si ya hay 50 o pasa de 300 caracteres).
 * Después la marca `accepted`. Una propuesta ya resuelta es `KNOWLEDGE_PROPOSAL_RESOLVED` (409).
 */
export async function acceptKnowledgeProposal(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    knowledgeProposals: Pick<KnowledgeProposalRepository, "getProposal" | "resolveProposal">;
    brandKnowledge: Pick<BrandKnowledgeRepository, "addUpdate" | "listUpdates">;
    editorialProfiles: Pick<EditorialProfileRepository, "get" | "upsert">;
    now?: () => Date;
  },
  actor: Pick<User, "role" | "brokerId">,
  brokerId: string,
  proposalId: string,
  edit: AcceptProposalEdit = {},
): Promise<AcceptProposalResult> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  const proposal = await pendingProposal(deps.knowledgeProposals, brokerId, proposalId);
  const kind = edit.kind ?? proposal.kind;
  const text = edit.text ?? proposal.text;
  const resolved = () => deps.knowledgeProposals.resolveProposal(proposal.id, "accepted");
  if (kind === "update") {
    const today = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const input: KnowledgeUpdateInput = {
      project: edit.project ?? proposal.project ?? "",
      date: edit.date ?? proposal.date ?? today,
      text,
    };
    const update = normalizeKnowledgeUpdate(input);
    await assertRoomForUpdate(deps.brandKnowledge, brokerId);
    if (!(await resolved())) await pendingProposal(deps.knowledgeProposals, brokerId, proposalId);
    const saved = await deps.brandKnowledge.addUpdate(brokerId, { ...update, source: "proposal" });
    return { kind: "update", update: saved };
  }
  const current = editorialProfileView(brokerId, await deps.editorialProfiles.get(brokerId));
  const { knowledge: _knowledge, brokerId: _id, updatedAt: _at, ...data } = current;
  const next = normalizeEditorialProfile({
    ...data,
    pillars: data.pillars.map((pillar) => ({ ...pillar })),
    cadence: { ...data.cadence },
    facts: [...data.facts, text],
  });
  if (!(await resolved())) await pendingProposal(deps.knowledgeProposals, brokerId, proposalId);
  const saved = await deps.editorialProfiles.upsert(brokerId, next);
  return { kind: "fact", facts: saved.facts };
}

/** Descarta una propuesta (`brand.edit`): no entra a nada. */
export async function discardKnowledgeProposal(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    knowledgeProposals: Pick<KnowledgeProposalRepository, "getProposal" | "resolveProposal">;
  },
  actor: Pick<User, "role" | "brokerId">,
  brokerId: string,
  proposalId: string,
): Promise<void> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  await pendingProposal(deps.knowledgeProposals, brokerId, proposalId);
  if (!(await deps.knowledgeProposals.resolveProposal(proposalId, "discarded"))) {
    await pendingProposal(deps.knowledgeProposals, brokerId, proposalId);
  }
}

/** Cuántas novedades activas caben todavía (para el panel). */
export const KNOWLEDGE_UPDATES_MAX = BRAND_KNOWLEDGE_LIMITS.updates;
