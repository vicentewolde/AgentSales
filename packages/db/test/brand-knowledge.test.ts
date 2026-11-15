import type { BrandKnowledgeRepository, KnowledgeProposalRepository } from "@agentsales/core";
import {
  createInMemoryBrandKnowledgeRepository,
  createInMemoryKnowledgeProposalRepository,
} from "@agentsales/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBrandKnowledgeRepository,
  createKnowledgeProposalRepository,
} from "../src/repositories/brand-knowledge.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F9.7 (ADR-0043): el conocimiento de la marca y las propuestas, iguales contra el doble en memoria
// y contra Drizzle sobre PGlite (con la migración 0026).

type Setup = {
  knowledge: BrandKnowledgeRepository;
  proposals: KnowledgeProposalRepository;
  newBroker: () => Promise<string>;
};

const BROKER = {
  name: "Vinny",
  primaryColor: "#123456",
  secondaryColor: "#abcdef",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
};

const USAGE = {
  provider: "anthropic-api" as const,
  model: "claude",
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
  costUsd: 0.25,
  priceTable: "2026-10-01",
  requestId: null,
};

function knowledgeContract(name: string, make: () => Promise<Setup>) {
  describe(`${name} · BrandKnowledgeRepository`, () => {
    let s: Setup;
    beforeAll(async () => {
      s = await make();
    });

    it("guarda postura, tono y ejemplos (reemplaza los ejemplos, en su orden)", async () => {
      const brokerId = await s.newBroker();
      expect(await s.knowledge.get(brokerId)).toBeNull();
      await s.knowledge.save(brokerId, {
        stance: "Postura",
        tone: null,
        examples: [
          { text: "Uno", note: null, favorite: false },
          { text: "Dos", note: "por qué", favorite: true },
        ],
      });
      const saved = await s.knowledge.save(brokerId, {
        stance: "Otra",
        tone: "Tono",
        examples: [
          { text: "Tres", note: null, favorite: false },
          { text: "Cuatro", note: null, favorite: true },
        ],
      });
      expect(saved.knowledge).toMatchObject({ brokerId, stance: "Otra", tone: "Tono" });
      expect((await s.knowledge.listExamples(brokerId)).map((example) => example.text)).toEqual([
        "Tres",
        "Cuatro",
      ]);
    });

    it("las novedades: las más nuevas primero, archivar las saca y `since` filtra", async () => {
      const brokerId = await s.newBroker();
      const old = await s.knowledge.addUpdate(brokerId, {
        project: "P",
        date: "2026-08-01",
        text: "Vieja",
        source: "operator",
      });
      const recent = await s.knowledge.addUpdate(brokerId, {
        project: "P",
        date: "2026-11-10",
        text: "Nueva",
        source: "proposal",
      });
      expect((await s.knowledge.listUpdates(brokerId)).map((update) => update.text)).toEqual([
        "Nueva",
        "Vieja",
      ]);
      expect(
        (await s.knowledge.listUpdates(brokerId, { since: "2026-09-01" })).map((u) => u.id),
      ).toEqual([recent.id]);
      const edited = await s.knowledge.editUpdate(old.id, {
        project: "Q",
        date: "2026-08-02",
        text: "Editada",
      });
      expect(edited).toMatchObject({ project: "Q", text: "Editada", source: "operator" });
      const archived = await s.knowledge.archiveUpdate(old.id);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect((await s.knowledge.listUpdates(brokerId)).map((u) => u.id)).toEqual([recent.id]);
      expect(await s.knowledge.listUpdates(brokerId, { includeArchived: true })).toHaveLength(2);
      expect(await s.knowledge.getUpdate("00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });

  describe(`${name} · KnowledgeProposalRepository`, () => {
    let s: Setup;
    beforeAll(async () => {
      s = await make();
    });

    it("una corrida activa por marca; termina con sus propuestas en orden y se resuelven una vez", async () => {
      const brokerId = await s.newBroker();
      const run = await s.proposals.createRun({ brokerId, sourceText: "Notas", createdBy: null });
      expect(run).toMatchObject({ status: "queued", sourceText: "Notas", warnings: [] });
      await expect(
        s.proposals.createRun({ brokerId, sourceText: "Otra", createdBy: null }),
      ).rejects.toMatchObject({ code: "KNOWLEDGE_RUN_CONFLICT" });
      expect(await s.proposals.markSucceeded(run.id, { warnings: [], proposals: [] })).toBe(false);
      expect(await s.proposals.markRunning(run.id)).toBe(true);
      const used = await s.proposals.addLlmUsage(run.id, USAGE);
      expect(used.llmUsage?.costUsd).toBe(0.25);
      expect(
        await s.proposals.markSucceeded(run.id, {
          warnings: ["ojo"],
          proposals: [
            { kind: "update", text: "Primera", project: "P", date: "2026-11-10" },
            { kind: "fact", text: "Segunda", project: null, date: null },
          ],
        }),
      ).toBe(true);
      expect(await s.proposals.getRun(run.id)).toMatchObject({
        status: "succeeded",
        warnings: ["ojo"],
      });
      const pending = await s.proposals.listProposals(brokerId, { status: "pending" });
      expect(pending.map((proposal) => proposal.text)).toEqual(["Primera", "Segunda"]);
      const [first] = pending;
      expect(await s.proposals.resolveProposal(first?.id ?? "", "accepted")).toBe(true);
      expect(await s.proposals.resolveProposal(first?.id ?? "", "discarded")).toBe(false);
      expect((await s.proposals.getProposal(first?.id ?? ""))?.status).toBe("accepted");
      // Ya no hay corrida activa: se puede pedir otra.
      const next = await s.proposals.createRun({ brokerId, sourceText: "Más", createdBy: null });
      expect(await s.proposals.markFailed(next.id, { code: "X", message: "falló" })).toBe(true);
      expect((await s.proposals.listRuns(brokerId)).map((item) => item.id)).toEqual([
        next.id,
        run.id,
      ]);
    });
  });
}

let sequence = 0;
knowledgeContract("en memoria", async () => ({
  knowledge: createInMemoryBrandKnowledgeRepository(),
  proposals: createInMemoryKnowledgeProposalRepository(),
  newBroker: async () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  },
}));

let database: TestDatabase;
afterAll(async () => {
  await database?.close();
});
knowledgeContract("Drizzle", async () => {
  database ??= await createTestDatabase();
  const brokers = createBrokerRepository(database.db);
  let n = 0;
  return {
    knowledge: createBrandKnowledgeRepository(database.db),
    proposals: createKnowledgeProposalRepository(database.db),
    newBroker: async () => {
      n += 1;
      const broker = await brokers.create(
        {
          ...BROKER,
          slug: `marca-${n}-${Math.random().toString(36).slice(2, 8)}`,
          brandName: `M${n}`,
        },
        { kind: "brand" },
      );
      return broker.id;
    },
  };
});

describe("sumLlmCost suma las lecturas de texto (F9.7 B2)", () => {
  it("el gasto de una lectura entra al tope de la marca", async () => {
    database ??= await createTestDatabase();
    const brokers = createBrokerRepository(database.db);
    const broker = await brokers.create(
      { ...BROKER, slug: "gasto-lectura", brandName: "Gasto" },
      { kind: "brand" },
    );
    const proposals = createKnowledgeProposalRepository(database.db);
    const run = await proposals.createRun({
      brokerId: broker.id,
      sourceText: "x",
      createdBy: null,
    });
    await proposals.addLlmUsage(run.id, USAGE);
    const [row] = await createContentRunRepository(database.db).sumLlmCost({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
      brokerId: broker.id,
    });
    expect(row).toMatchObject({ brokerId: broker.id, costUsd: 0.25, runs: 1 });
  });
});
