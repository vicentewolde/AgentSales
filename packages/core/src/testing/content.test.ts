import { describe, expect, it } from "vitest";
import type { LlmCallUsage } from "../llm-usage.js";
import { createInMemoryContentRepositories } from "./content.js";

const call: LlmCallUsage = {
  provider: "fake",
  model: "fake",
  inputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 1,
  costUsd: 0.5,
  priceTable: null,
  requestId: null,
};

const range = () => ({
  from: new Date(Date.now() - 60_000),
  to: new Date(Date.now() + 60_000),
});

describe("doble de contenido · sumLlmCost (F9-T04)", () => {
  it("sin brokerOfListing suma los posts; solo falla al encontrar una corrida de aviso", async () => {
    const { contentRuns } = createInMemoryContentRepositories({
      brokerOfPost: () => "marca-1",
    });
    const postRun = await contentRuns.create({ postId: "post-1", texts: true });
    await contentRuns.addLlmUsage(postRun.id, call);
    // Una corrida de aviso sin gasto no hace falta cruzarla.
    await contentRuns.create({ listingId: "listing-1", texts: true });
    expect(await contentRuns.sumLlmCost(range())).toEqual([
      { brokerId: "marca-1", costUsd: 0.5, runs: 1 },
    ]);

    const listingRun = await contentRuns.create({ listingId: "listing-2", texts: true });
    await contentRuns.addLlmUsage(listingRun.id, call);
    await expect(contentRuns.sumLlmCost(range())).rejects.toThrow("brokerOfListing");
  });
});
