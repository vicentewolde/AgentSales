import { describe, expect, it } from "vitest";
import { ALL_SCOPE, brokerScope } from "./access.js";
import { isAppError } from "./errors.js";
import {
  assertLlmBudget,
  brokersNeedingApiKey,
  llmProviderFor,
  monthlySpend,
} from "./llm-budget.js";
import {
  hasLlmPrice,
  LLM_PRICE_TABLE,
  LLM_UNKNOWN_MODEL_PRICE_TABLE,
  type LlmTokenUsage,
  llmCallCost,
  roundUsd,
} from "./llm-usage.js";
import type { LLMProvider } from "./ports/llm-provider.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
} from "./testing/index.js";

// F7-T12 (spec F7 §4.7): el proveedor de cada corredor, el costo de cada llamada y el tope del mes.

const provider = (name: LLMProvider["name"]): LLMProvider => ({
  name,
  generateStructured: async () => ({ data: {}, model: "m" }),
});

const usage = (overrides: Partial<LlmTokenUsage> = {}): LlmTokenUsage => ({
  inputTokens: 1_000_000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  requestId: "req_1",
  ...overrides,
});

describe("llmProviderFor", () => {
  const own = provider("claude-cli");
  const api = provider("anthropic-api");

  it("el propio usa el del operador y el no propio la API", () => {
    expect(llmProviderFor(contentBrokerFixture({ operatorOwned: true }), { own, api })).toBe(own);
    expect(llmProviderFor(contentBrokerFixture(), { own, api })).toBe(api);
  });

  it("con fake, todos usan fake (también sin clave)", () => {
    const fake = provider("fake");
    expect(llmProviderFor(contentBrokerFixture(), { own: fake, api: null })).toBe(fake);
  });

  it("sin clave, el no propio falla con LLM_NOT_CONFIGURED y lo que falta", () => {
    try {
      llmProviderFor(contentBrokerFixture(), { own, api: null });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("LLM_NOT_CONFIGURED");
      expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
    }
    expect(llmProviderFor(contentBrokerFixture({ operatorOwned: true }), { own, api: null })).toBe(
      own,
    );
  });
});

describe("llmCallCost", () => {
  it.each([
    ["claude-sonnet-5-5", 2, 10, 0.1],
    ["claude-opus-5-5", 4, 20, 0.2],
    ["claude-fable-5-1", 10, 50, 0.25],
    ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ])(
    "%s: entrada, salida, lectura y escritura de caché por millón",
    (model, input, output, read) => {
      const cost = (u: Partial<LlmTokenUsage>) =>
        llmCallCost("anthropic-api", model, usage({ inputTokens: 0, ...u })).costUsd;
      expect(cost({ inputTokens: 50_000 })).toBeCloseTo(input * 0.05, 10);
      expect(cost({ outputTokens: 50_000 })).toBeCloseTo(output * 0.05, 10);
      expect(cost({ cacheReadInputTokens: 50_000 })).toBeCloseTo(read * 0.05, 10);
      expect(cost({ cacheCreationInputTokens: 50_000 })).toBeCloseTo(input * 1.25 * 0.05, 10);
    },
  );

  it("Haiku 5.5 sobre 100.000 tokens de prompt cobra el segundo tramo (también la salida)", () => {
    const at = (prompt: number) =>
      llmCallCost(
        "anthropic-api",
        "claude-haiku-5-5",
        usage({ inputTokens: prompt, outputTokens: 1_000_000 }),
      ).costUsd;
    expect(at(100_000)).toBeCloseTo(100_000 * 0.1e-6 + 0.5, 10);
    expect(at(100_002)).toBeCloseTo(100_002 * 0.5e-6 + 2.5, 10);
    // La caché cuenta para el tramo.
    const cached = llmCallCost(
      "anthropic-api",
      "claude-haiku-5-5",
      usage({ inputTokens: 2, cacheReadInputTokens: 100_000, outputTokens: 0 }),
    );
    expect(cached.costUsd).toBeCloseTo(2 * 0.5e-6 + 100_000 * 0.01e-6, 10);
  });

  it("redondea a micro-dólares: sin el ruido de los decimales binarios", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    const cost = llmCallCost("anthropic-api", "claude-sonnet-5-5", usage({ inputTokens: 600 }));
    expect(cost.costUsd).toBe(0.0012);
  });

  it("acepta el id con fecha, anota la tabla y conserva tokens y request-id", () => {
    const cost = llmCallCost("anthropic-api", "claude-sonnet-5-5-20261001", usage());
    expect(cost).toMatchObject({
      provider: "anthropic-api",
      model: "claude-sonnet-5-5-20261001",
      inputTokens: 1_000_000,
      requestId: "req_1",
      costUsd: 2,
      priceTable: LLM_PRICE_TABLE,
    });
  });

  it("el plan del operador y fake cuestan 0 sin tabla", () => {
    for (const name of ["claude-cli", "fake"] as const) {
      expect(llmCallCost(name, "claude-sonnet-5-5", usage())).toMatchObject({
        costUsd: 0,
        priceTable: null,
      });
    }
  });

  it("un modelo de la API sin precio se estima con el más caro, para que el tope siga frenando", () => {
    expect(hasLlmPrice("claude-desconocido-9")).toBe(false);
    expect(hasLlmPrice("claude-sonnet-5-5-20261001")).toBe(true);
    expect(llmCallCost("anthropic-api", "claude-desconocido-9", usage())).toMatchObject({
      costUsd: 10,
      priceTable: LLM_UNKNOWN_MODEL_PRICE_TABLE,
    });
  });
});

/** Dos corredores, cada uno con un aviso, y corridas con su gasto. */
async function spending() {
  const capped = contentBrokerFixture({ llmMonthlyCapUsd: 1 });
  const other = contentBrokerFixture({
    id: "00000000-0000-4000-8000-0000000000b2",
    slug: "otro",
    brandName: "Otra",
    llmMonthlyCapUsd: null,
  });
  const brokers = createInMemoryBrokerRepository([capped, other]);
  const owner: Record<string, string> = { "aviso-1": capped.id, "aviso-2": other.id };
  const { contentRuns } = createInMemoryContentRepositories({
    brokerOfListing: (id) => owner[id] ?? null,
  });
  const spend = async (listingId: string, inputTokens: number) => {
    const run = await contentRuns.create({ listingId, texts: true });
    await contentRuns.addLlmUsage(
      run.id,
      llmCallCost("anthropic-api", "claude-sonnet-5-5", usage({ inputTokens })),
    );
    // Una corrida que falla después de gastar también cuenta.
    await contentRuns.markFailed(run.id, { code: "LLM_OUTPUT_INVALID", message: "falló" });
  };
  return { capped, other, brokers, contentRuns, spend };
}

describe("assertLlmBudget", () => {
  it("bajo el tope pasa; al llegar, LLM_BUDGET_EXCEEDED con lo gastado y el tope", async () => {
    const { capped, contentRuns, spend } = await spending();
    await spend("aviso-1", 400_000); // US$ 0,80
    await expect(assertLlmBudget({ contentRuns }, capped, new Date())).resolves.toBeUndefined();
    await spend("aviso-1", 150_000); // US$ 1,10: una llamada puede pasarse un poco
    await expect(assertLlmBudget({ contentRuns }, capped, new Date())).rejects.toMatchObject({
      code: "LLM_BUDGET_EXCEEDED",
      details: { spentUsd: expect.closeTo(1.1, 10), capUsd: 1 },
    });
  });

  it("sin tope no consulta; el gasto de otro corredor no cuenta", async () => {
    const { capped, other, contentRuns, spend } = await spending();
    await spend("aviso-2", 5_000_000);
    await expect(assertLlmBudget({ contentRuns }, other, new Date())).resolves.toBeUndefined();
    await expect(assertLlmBudget({ contentRuns }, capped, new Date())).resolves.toBeUndefined();
  });

  it("el gasto de otro mes no cuenta", async () => {
    const { capped, contentRuns, spend } = await spending();
    await spend("aviso-1", 5_000_000);
    const nextMonth = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    await expect(assertLlmBudget({ contentRuns }, capped, nextMonth)).resolves.toBeUndefined();
  });
});

describe("monthlySpend", () => {
  it("cada corredor del alcance, también los que no gastaron; el corredor ve solo el suyo", async () => {
    const { capped, other, brokers, contentRuns, spend } = await spending();
    await spend("aviso-1", 250_000);
    await spend("aviso-1", 250_000);
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    const all = await monthlySpend({ contentRuns, brokers }, { month, scope: ALL_SCOPE });
    expect(all).toEqual(
      expect.arrayContaining([
        {
          brokerId: capped.id,
          slug: capped.slug,
          spentUsd: expect.closeTo(1, 10),
          capUsd: 1,
          runs: 2,
        },
        { brokerId: other.id, slug: "otro", spentUsd: 0, capUsd: null, runs: 0 },
      ]),
    );
    const own = await monthlySpend(
      { contentRuns, brokers },
      { month, scope: brokerScope(other.id) },
    );
    expect(own).toEqual([{ brokerId: other.id, slug: "otro", spentUsd: 0, capUsd: null, runs: 0 }]);
  });

  it("un mes mal escrito es MONTH_INVALID", async () => {
    const { brokers, contentRuns } = await spending();
    await expect(
      monthlySpend({ contentRuns, brokers }, { month: "2026-13", scope: ALL_SCOPE }),
    ).rejects.toMatchObject({ code: "MONTH_INVALID" });
  });
});

describe("brokersNeedingApiKey", () => {
  const brokers = [
    contentBrokerFixture({ slug: "propio", operatorOwned: true }),
    contentBrokerFixture({ slug: "ajeno" }),
  ];

  it("sin clave, los no propios; con clave o con fake, ninguno", () => {
    expect(brokersNeedingApiKey(brokers, { provider: "claude-cli", hasApiKey: false })).toEqual([
      "ajeno",
    ]);
    expect(brokersNeedingApiKey(brokers, { provider: "claude-cli", hasApiKey: true })).toEqual([]);
    expect(brokersNeedingApiKey(brokers, { provider: "fake", hasApiKey: false })).toEqual([]);
  });
});
