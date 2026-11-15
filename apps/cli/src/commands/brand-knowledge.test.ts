import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKnowledgeProposals } from "@agentsales/core";
import {
  createInMemoryBrandKnowledgeRepository,
  createInMemoryKnowledgeProposalRepository,
  createInMemoryLlmProvider,
} from "@agentsales/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, fakeClock, harness } from "../../test/harness.js";
import {
  runKnowledgeEdit,
  runKnowledgeShow,
  runProposalAccept,
  runProposalsList,
  runPropose,
  runUpdateAdd,
  runUpdateArchive,
  runUpdateList,
} from "./brand-knowledge.js";

// F9.7 B1 y B2 (ADR-0043): `agentsales brand knowledge|update|propose|proposals`, contra la API en
// proceso; la IA es un doble (nunca la real).

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const brandKnowledge = createInMemoryBrandKnowledgeRepository();
  const knowledgeProposals = createInMemoryKnowledgeProposalRepository();
  const h = harness({ deps: { brandKnowledge, knowledgeProposals } });
  const agentpey = await h.brokers.create({ ...brokerData("agentpey"), brandName: "AgentPey" });
  const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-knowledge-"));
  dirs.push(cwd);
  return {
    h,
    agentpey,
    cwd,
    brandKnowledge,
    knowledgeProposals,
    deps: { ...h.io, client: h.client, cwd },
  };
}

describe("brand knowledge", () => {
  it("edit con opciones y --file, y show lo muestra", async () => {
    const s = await setup();
    await writeFile(
      join(s.cwd, "conocimiento.json"),
      JSON.stringify({
        examples: [{ text: "Un relato con escena", note: "abre fuerte", favorite: true }],
      }),
    );
    await expect(
      runKnowledgeEdit(s.deps, {
        broker: "agentpey",
        stance: "Que los agentes compren con límites",
        file: "conocimiento.json",
      }),
    ).resolves.toBe(0);
    expect(await s.brandKnowledge.get(s.agentpey.id)).toMatchObject({
      stance: "Que los agentes compren con límites",
      tone: null,
    });
    await expect(runKnowledgeShow(s.deps, { broker: "agentpey" })).resolves.toBe(0);
    expect(s.h.text()).toContain("★ Un relato con escena");
    await expect(runKnowledgeEdit(s.deps, { broker: "agentpey" })).resolves.toBe(1);
  });
});

describe("brand update", () => {
  it("agrega, lista y archiva una novedad", async () => {
    const s = await setup();
    await expect(
      runUpdateAdd(s.deps, {
        broker: "agentpey",
        project: "AgentPey en Stellar",
        date: "2026-11-10",
        text: "Pasó a testnet.",
      }),
    ).resolves.toBe(0);
    const [update] = await s.brandKnowledge.listUpdates(s.agentpey.id);
    await expect(runUpdateList(s.deps, { broker: "agentpey" })).resolves.toBe(0);
    expect(s.h.text()).toContain("2026-11-10 · AgentPey en Stellar: Pasó a testnet.");
    await expect(runUpdateArchive(s.deps, update?.id ?? "", { broker: "agentpey" })).resolves.toBe(
      0,
    );
    expect(await s.brandKnowledge.listUpdates(s.agentpey.id)).toEqual([]);
  });
});

describe("brand propose y proposals", () => {
  it("lee el texto, espera la lectura (el worker con una IA falsa) y acepta una propuesta", async () => {
    const s = await setup();
    await writeFile(join(s.cwd, "notas.txt"), "Notas: el piloto partió en Santiago esta semana.");
    const llm = createInMemoryLlmProvider([
      {
        data: {
          proposals: [
            { kind: "update", text: "Partió el piloto.", project: "Piloto", date: "2026-11-12" },
          ],
          warnings: [],
        },
      },
    ]);
    const clock = fakeClock(async () => {
      for (const run of s.knowledgeProposals.allRuns().filter((item) => item.status === "queued")) {
        await runKnowledgeProposals(
          {
            knowledgeProposals: s.knowledgeProposals,
            brokers: s.h.brokers,
            editorialProfiles: s.h.editorialProfiles,
            brandKnowledge: s.brandKnowledge,
            contentRuns: { sumLlmCost: async () => [] },
            llm,
          },
          { knowledgeRunId: run.id, isLastAttempt: false },
        );
      }
    });
    await expect(
      runPropose(
        { ...s.deps, ...clock, stdinIsTty: () => true, readStdin: async () => "" },
        { broker: "agentpey", file: "notas.txt" },
      ),
    ).resolves.toBe(0);
    expect(s.h.text()).toContain("Novedad · 2026-11-12 · Piloto: Partió el piloto.");
    const [proposal] = await s.knowledgeProposals.listProposals(s.agentpey.id);
    await expect(
      runProposalAccept(s.deps, proposal?.id ?? "", {
        broker: "agentpey",
        text: "Partió el piloto en Santiago.",
      }),
    ).resolves.toBe(0);
    expect((await s.brandKnowledge.listUpdates(s.agentpey.id))[0]).toMatchObject({
      text: "Partió el piloto en Santiago.",
      source: "proposal",
    });
    await expect(runProposalsList(s.deps, { broker: "agentpey" })).resolves.toBe(0);
    expect(s.h.text()).toContain("No hay propuestas pendientes");
  });
});
