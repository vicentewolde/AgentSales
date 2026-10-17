import {
  ALL_SCOPE,
  type BrokerRepository,
  brokerScope,
  type ContentRepository,
  type ContentRunRepository,
  type ImportRunRepository,
  type ListingRepository,
  type LlmCallUsage,
  type PlatformAccountRepository,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";
import { newContent } from "./content-repositories.contract.js";
import { brokerData, newListing, REPORT } from "./import-repositories.contract.js";
import { connectedAccount } from "./platform-accounts.contract.js";

/**
 * Suite de contrato de F7-T02: el alcance en SQL de las listas, lo que solo cambia el
 * administrador en un corredor, el gasto de IA por corrida y los textos vigentes de varios avisos.
 * Corre igual contra los dobles en memoria y contra Drizzle sobre PGlite.
 */
export type ScopeRepositories = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  importRuns: ImportRunRepository;
  accounts: PlatformAccountRepository;
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

const call = (overrides: Partial<LlmCallUsage> = {}): LlmCallUsage => ({
  provider: "anthropic-api",
  model: "claude-sonnet-5-5",
  inputTokens: 1000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 500,
  costUsd: 0.007,
  priceTable: "2026-10-16",
  requestId: unique("req"),
  ...overrides,
});

const COUNTS = { rowsTotal: 1, rowsCreated: 1, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 };

export function scopeRepositoriesContract(name: string, make: () => Promise<ScopeRepositories>) {
  describe(`${name} · alcance, ajustes del corredor y gasto de IA (F7-T02)`, () => {
    let repos: ScopeRepositories;
    let mine: string;
    let other: string;
    beforeAll(async () => {
      repos = await make();
      mine = (await repos.brokers.create(brokerData(unique("mio")))).id;
      other = (await repos.brokers.create(brokerData(unique("otro")))).id;
    });

    it("un corredor nuevo no es propio ni tiene tope; el administrador los cambia", async () => {
      const created = await repos.brokers.findById(mine);
      expect(created).toMatchObject({ operatorOwned: false, llmMonthlyCapUsd: null });
      expect(
        await repos.brokers.setSettings(mine, { operatorOwned: true, llmMonthlyCapUsd: 12.5 }),
      ).toMatchObject({ operatorOwned: true, llmMonthlyCapUsd: 12.5 });
      // `undefined` no toca; `null` quita el tope.
      expect(await repos.brokers.setSettings(mine, { llmMonthlyCapUsd: null })).toMatchObject({
        operatorOwned: true,
        llmMonthlyCapUsd: null,
      });
      expect(await repos.brokers.setSettings(mine, {})).toMatchObject({ operatorOwned: true });
      // Se redondea a centavos; un monto imposible no llega a la base.
      expect(
        (await repos.brokers.setSettings(mine, { llmMonthlyCapUsd: 3.456 })).llmMonthlyCapUsd,
      ).toBe(3.46);
      for (const cap of [Number.NaN, -1, Number.POSITIVE_INFINITY, 1e8]) {
        await expect(
          repos.brokers.setSettings(mine, { llmMonthlyCapUsd: cap }),
        ).rejects.toMatchObject({ code: "BROKER_SETTINGS_INVALID" });
      }
      expect((await repos.brokers.findById(mine))?.llmMonthlyCapUsd).toBe(3.46);
      await repos.brokers.setSettings(mine, { operatorOwned: false });
      const missing = "00000000-0000-0000-0000-000000000000";
      await expect(repos.brokers.setSettings(missing, {})).rejects.toMatchObject({
        code: "BROKER_NOT_FOUND",
      });
    });

    it("cada lista con dos corredores devuelve solo lo del alcance", async () => {
      const myListing = await repos.listings.create(newListing(mine, unique("P")));
      const theirListing = await repos.listings.create(newListing(other, unique("P")));
      const ids = (list: { id: string }[]) => list.map((item) => item.id);

      expect(ids(await repos.brokers.list(brokerScope(mine)))).toEqual([mine]);
      expect(ids(await repos.brokers.list(ALL_SCOPE))).toEqual(
        expect.arrayContaining([mine, other]),
      );

      const scoped = ids(await repos.listings.list({}, brokerScope(mine)));
      expect(scoped).toContain(myListing.id);
      expect(scoped).not.toContain(theirListing.id);
      expect(ids(await repos.listings.list())).toEqual(
        expect.arrayContaining([myListing.id, theirListing.id]),
      );

      const input = { xlsxPath: "/tmp/x.xlsx", mediaDir: null, broker: null };
      const newRun = () =>
        repos.importRuns.create({ source: "xlsx", fileName: "x.xlsx", dryRun: false, input });
      const myRun = await newRun();
      const theirRun = await newRun();
      const pending = await newRun();
      await repos.importRuns.recordListingsResult(myRun.id, {
        brokerId: mine,
        counts: COUNTS,
        report: REPORT,
      });
      await repos.importRuns.recordListingsResult(theirRun.id, {
        brokerId: other,
        counts: COUNTS,
        report: REPORT,
      });
      const myRuns = ids(await repos.importRuns.list(50, brokerScope(mine)));
      expect(myRuns).toContain(myRun.id);
      expect(myRuns).not.toContain(theirRun.id);
      // Una carga sin corredor todavía solo la ve el administrador.
      expect(myRuns).not.toContain(pending.id);
      expect(ids(await repos.importRuns.list(50))).toEqual(
        expect.arrayContaining([myRun.id, theirRun.id, pending.id]),
      );

      const myAccount = await repos.accounts.upsertConnected(connectedAccount(mine));
      const theirAccount = await repos.accounts.upsertConnected(connectedAccount(other));
      const accounts = ids(await repos.accounts.list(brokerScope(mine)));
      expect(accounts).toContain(myAccount.id);
      expect(accounts).not.toContain(theirAccount.id);
      expect(ids(await repos.accounts.list())).toEqual(
        expect.arrayContaining([myAccount.id, theirAccount.id]),
      );
    });

    it("addLlmUsage suma cada llamada, también a la vez y en una corrida que falló", async () => {
      const listing = await repos.listings.create(newListing(mine, unique("P")));
      const run = await repos.contentRuns.create({ listingId: listing.id, texts: true });
      expect(run.llmUsage).toBeNull();
      await Promise.all([
        repos.contentRuns.addLlmUsage(run.id, call({ requestId: "a" })),
        repos.contentRuns.addLlmUsage(run.id, call({ requestId: "b", outputTokens: 100 })),
      ]);
      await repos.contentRuns.markFailed(run.id, { code: "LLM_INVALID_OUTPUT", message: "x" });
      const updated = await repos.contentRuns.addLlmUsage(run.id, call({ requestId: null }));
      expect(updated.llmUsage).toMatchObject({
        calls: 3,
        inputTokens: 3000,
        outputTokens: 1100,
        provider: "anthropic-api",
        model: "claude-sonnet-5-5",
        priceTable: "2026-10-16",
      });
      expect(updated.llmUsage?.costUsd).toBeCloseTo(0.021, 10);
      expect([...(updated.llmUsage?.requestIds ?? [])].sort()).toEqual(["a", "b"]);
      expect(await repos.contentRuns.get(run.id)).toEqual(updated);
      await expect(
        repos.contentRuns.addLlmUsage("00000000-0000-0000-0000-000000000000", call()),
      ).rejects.toMatchObject({ code: "CONTENT_RUN_NOT_FOUND" });
    });

    it("sumLlmCost suma por corredor las corridas creadas en el rango", async () => {
      const broker = (await repos.brokers.create(brokerData(unique("gasto")))).id;
      const listing = await repos.listings.create(newListing(broker, unique("P")));
      const first = await repos.contentRuns.create({ listingId: listing.id, texts: true });
      await repos.contentRuns.addLlmUsage(first.id, call({ costUsd: 0.02 }));
      await repos.contentRuns.markFailed(first.id, { code: "X", message: "x" });
      const second = await repos.contentRuns.create({ listingId: listing.id, texts: true });
      await repos.contentRuns.addLlmUsage(second.id, call({ costUsd: 0.03 }));
      // Una sin uso no cuenta.
      await repos.contentRuns.markFailed(second.id, { code: "X", message: "x" });
      await repos.contentRuns.create({ listingId: listing.id, texts: false });

      const now = Date.now();
      const range = { from: new Date(now - 60_000), to: new Date(now + 60_000) };
      const [spend] = await repos.contentRuns.sumLlmCost({ ...range, brokerId: broker });
      expect(spend?.brokerId).toBe(broker);
      expect(spend?.runs).toBe(2);
      expect(spend?.costUsd).toBeCloseTo(0.05, 10);
      const all = await repos.contentRuns.sumLlmCost(range);
      expect(all.map((row) => row.brokerId)).toContain(broker);
      // Fuera del rango no hay nada.
      expect(
        await repos.contentRuns.sumLlmCost({
          from: new Date(now + 60_000),
          to: new Date(now + 120_000),
          brokerId: broker,
        }),
      ).toEqual([]);
    });

    it("listCurrentMany da lo mismo que listCurrent de cada aviso", async () => {
      const a = await repos.listings.create(newListing(mine, unique("P")));
      const b = await repos.listings.create(newListing(mine, unique("P")));
      for (const listing of [a, b]) {
        for (const round of [1, 2]) {
          const run = await repos.contentRuns.create({ listingId: listing.id, texts: true });
          await repos.contentRuns.markRunning(run.id);
          await repos.contentRuns.markSucceeded(run.id, {
            report: { ...REPORT_FOR_RUN },
            contents: [
              newContent("instagram", { body: `ronda ${round}` }),
              newContent("portal_inmobiliario", { body: `ronda ${round}` }),
            ],
          });
        }
      }
      const one = [
        ...(await repos.contents.listCurrent(a.id)),
        ...(await repos.contents.listCurrent(b.id)),
      ];
      const many = await repos.contents.listCurrentMany([a.id, b.id, a.id]);
      const key = (content: { id: string }) => content.id;
      expect(many.map(key).sort()).toEqual(one.map(key).sort());
      expect(many.every((content) => content.body === "ronda 2")).toBe(true);
      expect(await repos.contents.listCurrentMany([])).toEqual([]);
    });
  });
}

const REPORT_FOR_RUN = { warnings: [] };
