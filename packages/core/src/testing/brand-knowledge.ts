import type {
  BrandKnowledge,
  KnowledgeExample,
  KnowledgeProposal,
  KnowledgeRun,
  KnowledgeUpdate,
} from "../brand-knowledge.js";
import { AppError } from "../errors.js";
import { addLlmCall } from "../llm-usage.js";
import type {
  BrandKnowledgeRepository,
  KnowledgeProposalRepository,
} from "../ports/brand-knowledge-repository.js";
import { structuredCopy } from "./copy.js";

// El conocimiento de la marca en memoria (spec F9.7, ADR-0043), con la semántica de los de Drizzle.

const uuidLike = (prefix: string, sequence: number) =>
  `${prefix}-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

/** El orden de las novedades: las más nuevas primero (fecha y después creación). */
const newestFirst = (a: KnowledgeUpdate, b: KnowledgeUpdate) =>
  b.date.localeCompare(a.date) ||
  b.createdAt.getTime() - a.createdAt.getTime() ||
  b.id.localeCompare(a.id);

export function createInMemoryBrandKnowledgeRepository(): BrandKnowledgeRepository {
  let sequence = 0;
  const knowledge = new Map<string, BrandKnowledge>();
  const examples = new Map<string, KnowledgeExample[]>();
  const updates = new Map<string, KnowledgeUpdate>();
  const tick = () => new Date(Date.now() + sequence++);
  return {
    async get(brokerId) {
      const found = knowledge.get(brokerId);
      return found === undefined ? null : structuredCopy(found);
    },
    async listExamples(brokerId) {
      return structuredCopy(examples.get(brokerId) ?? []);
    },
    async save(brokerId, data) {
      const at = tick();
      const saved: BrandKnowledge = {
        brokerId,
        stance: data.stance,
        tone: data.tone,
        updatedAt: at,
      };
      knowledge.set(brokerId, saved);
      const list = data.examples.map((example) => ({
        id: uuidLike("e0000000", ++sequence),
        brokerId,
        text: example.text,
        note: example.note,
        favorite: example.favorite,
        createdAt: tick(),
      }));
      examples.set(brokerId, list);
      return structuredCopy({ knowledge: saved, examples: list });
    },
    async listUpdates(brokerId, options = {}) {
      return [...updates.values()]
        .filter(
          (update) =>
            update.brokerId === brokerId &&
            (options.includeArchived === true || update.archivedAt === null) &&
            (options.since === undefined || update.date >= options.since),
        )
        .sort(newestFirst)
        .slice(0, options.limit ?? 500)
        .map(structuredCopy);
    },
    async getUpdate(id) {
      const found = updates.get(id);
      return found === undefined ? null : structuredCopy(found);
    },
    async addUpdate(brokerId, update) {
      const created: KnowledgeUpdate = {
        id: uuidLike("a0000000", ++sequence),
        brokerId,
        project: update.project,
        date: update.date,
        text: update.text,
        source: update.source,
        archivedAt: null,
        createdAt: tick(),
      };
      updates.set(created.id, created);
      return structuredCopy(created);
    },
    async editUpdate(id, update) {
      const current = updates.get(id);
      if (current === undefined) return null;
      const changed = { ...current, ...update };
      updates.set(id, changed);
      return structuredCopy(changed);
    },
    async archiveUpdate(id) {
      const current = updates.get(id);
      if (current === undefined) return null;
      const changed = { ...current, archivedAt: current.archivedAt ?? tick() };
      updates.set(id, changed);
      return structuredCopy(changed);
    },
  };
}

export type InMemoryKnowledgeProposalRepository = KnowledgeProposalRepository & {
  allRuns(): KnowledgeRun[];
};

export function createInMemoryKnowledgeProposalRepository(): InMemoryKnowledgeProposalRepository {
  let sequence = 0;
  const runs = new Map<string, KnowledgeRun>();
  const proposals = new Map<string, KnowledgeProposal>();
  const tick = () => new Date(Date.now() + sequence++);
  const change = (id: string, from: KnowledgeRun["status"][], patch: Partial<KnowledgeRun>) => {
    const current = runs.get(id);
    if (current === undefined || !from.includes(current.status)) return false;
    runs.set(id, { ...current, ...patch });
    return true;
  };
  return {
    async createRun(run) {
      const active = [...runs.values()].some(
        (item) =>
          item.brokerId === run.brokerId && (item.status === "queued" || item.status === "running"),
      );
      if (active) {
        throw new AppError(
          "KNOWLEDGE_RUN_CONFLICT",
          "Ya hay una lectura de texto en curso para esta marca",
        );
      }
      const created: KnowledgeRun = {
        id: uuidLike("b0000000", ++sequence),
        brokerId: run.brokerId,
        status: "queued",
        sourceText: run.sourceText,
        warnings: [],
        error: null,
        llmUsage: null,
        createdBy: run.createdBy,
        startedAt: null,
        finishedAt: null,
        createdAt: tick(),
      };
      runs.set(created.id, created);
      return structuredCopy(created);
    },
    async getRun(id) {
      const found = runs.get(id);
      return found === undefined ? null : structuredCopy(found);
    },
    async listRuns(brokerId, limit = 10) {
      return [...runs.values()]
        .filter((run) => run.brokerId === brokerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map(structuredCopy);
    },
    async markRunning(id) {
      const current = runs.get(id);
      return change(id, ["queued", "running"], {
        status: "running",
        startedAt: current?.startedAt ?? new Date(),
      });
    },
    async markSucceeded(id, result) {
      const run = runs.get(id);
      if (run?.status !== "running") return false;
      // Como en Postgres: las de una corrida nacen juntas (misma hora) y quedan en su orden.
      const createdAt = tick();
      for (const proposal of result.proposals) {
        const created: KnowledgeProposal = {
          id: uuidLike("c0000000", ++sequence),
          brokerId: run.brokerId,
          runId: id,
          kind: proposal.kind,
          text: proposal.text,
          project: proposal.project,
          date: proposal.date,
          status: "pending",
          createdAt,
        };
        proposals.set(created.id, created);
      }
      return change(id, ["running"], {
        status: "succeeded",
        warnings: [...result.warnings],
        finishedAt: new Date(),
      });
    },
    async markFailed(id, error) {
      return change(id, ["queued", "running"], {
        status: "failed",
        error: { ...error },
        finishedAt: new Date(),
      });
    },
    async addLlmUsage(id, call) {
      const current = runs.get(id);
      if (current === undefined) {
        throw new AppError("KNOWLEDGE_RUN_NOT_FOUND", `No existe la corrida ${id}`);
      }
      const updated = { ...current, llmUsage: addLlmCall(current.llmUsage, call) };
      runs.set(id, updated);
      return structuredCopy(updated);
    },
    async listProposals(brokerId, options = {}) {
      return [...proposals.values()]
        .filter(
          (proposal) =>
            proposal.brokerId === brokerId &&
            (options.status === undefined || proposal.status === options.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, options.limit ?? 100)
        .map(structuredCopy);
    },
    async getProposal(id) {
      const found = proposals.get(id);
      return found === undefined ? null : structuredCopy(found);
    },
    async resolveProposal(id, status) {
      const current = proposals.get(id);
      if (current === undefined || current.status !== "pending") return false;
      proposals.set(id, { ...current, status });
      return true;
    },
    allRuns: () => [...runs.values()].map(structuredCopy),
  };
}
