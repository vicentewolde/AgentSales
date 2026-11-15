import {
  contentBrokerFixture,
  createInMemoryBrandKnowledgeRepository,
  createInMemoryBrokerRepository,
  createInMemoryEditorialProfileRepository,
  createInMemoryKnowledgeProposalRepository,
} from "@agentsales/core/testing";
import { createLlmProvider } from "@agentsales/llm";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { knowledgeLlmProviderOptions } from "../llm-options.js";
import { BRAND_PROPOSE_QUEUE, brandProposeJob } from "./brand-propose.js";

// F9.7 B2 (ADR-0043): el job `brand.propose` con el proveedor `fake` del worker (nunca la IA real).

const env = {
  LLM_MODEL: "sonnet",
  CLAUDE_CLI_PATH: "/opt/claude",
  LLM_TIMEOUT_SECONDS: 180,
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_API_KEY: undefined,
} as const;

const SECRET_TEXT = "Notas internas: el comercio piloto de la calle Secreta 123 empezó el lunes.";

describe("job brand.propose", () => {
  it("es exclusive, con 2 reintentos con backoff", () => {
    expect(BRAND_PROPOSE_QUEUE).toMatchObject({ policy: "exclusive", retryLimit: 2 });
  });

  it("con fake deja propuestas pendientes y el log no lleva el texto", async () => {
    const broker = contentBrokerFixture({ kind: "brand", operatorOwned: true });
    const knowledgeProposals = createInMemoryKnowledgeProposalRepository();
    const run = await knowledgeProposals.createRun({
      brokerId: broker.id,
      sourceText: SECRET_TEXT,
      createdBy: null,
    });
    const job = brandProposeJob({
      shared: {
        knowledgeProposals,
        brokers: createInMemoryBrokerRepository([broker]),
        editorialProfiles: createInMemoryEditorialProfileRepository(),
        brandKnowledge: createInMemoryBrandKnowledgeRepository(),
        contentRuns: { sumLlmCost: async () => [] },
        llm: createLlmProvider(knowledgeLlmProviderOptions({ ...env, LLM_PROVIDER: "fake" }, {})),
        apiLlm: null,
      },
      signal: new AbortController().signal,
    });
    const { logger, lines } = captureLogger();
    await job.run(
      { knowledgeRunId: run.id },
      { jobId: "job-1", logger, isLastAttempt: false, retryCount: 0 },
    );
    expect((await knowledgeProposals.getRun(run.id))?.status).toBe("succeeded");
    expect(await knowledgeProposals.listProposals(broker.id, { status: "pending" })).toHaveLength(
      2,
    );
    expect(lines.find((line) => line.msg === "propuestas de conocimiento listas")).toMatchObject({
      proposals: 2,
    });
    expect(JSON.stringify(lines)).not.toContain("Secreta");
  });
});
