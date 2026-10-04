import { describe, expect, it } from "vitest";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import type { NewListing } from "../ports/listing-repository.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "../testing/index.js";
import { evaluateListingContent } from "./evaluate-listing-content.js";

/** El borrador de ejemplo con un número que no está en los datos del aviso. */
const DRAFT_WITH_INVENTED_NUMBER = {
  ...SAMPLE_CONTENT_DRAFT,
  instagram: {
    ...SAMPLE_CONTENT_DRAFT.instagram,
    body: "Tiene 847 m² de jardín privado.",
  },
};

async function setup(responses: ScriptedLlmResponse[]) {
  const listings = createInMemoryListingRepository();
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    ...rest
  } = contentListingFixture({ internalNotes: "acepta ofertas bajo la tasación" });
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "h",
  });
  const llm = createInMemoryLlmProvider(responses);
  const deps = {
    listings,
    brokers: createInMemoryBrokerRepository([contentBrokerFixture()]),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(contentDefinitionsFixture()),
    llm,
  };
  return { deps, listing, llm };
}

describe("evaluateListingContent", () => {
  it("un borrador limpio: los 3 canales sin errores", async () => {
    const t = await setup([{ data: SAMPLE_CONTENT_DRAFT }]);

    const result = await evaluateListingContent(t.deps, { listingId: t.listing.id });

    expect(result).toMatchObject({
      listingId: t.listing.id,
      externalRef: t.listing.externalRef,
      model: "modelo-falso",
      promptVersion: "listing-content-v1",
      attempts: 1,
      hasErrors: false,
    });
    expect(result.texts.map((item) => [item.platform, item.checks])).toEqual([
      ["instagram", []],
      ["portal_inmobiliario", []],
      ["fb_marketplace", []],
    ]);
    expect(result.texts[1]?.text.title).toMatch(/en venta/);
  });

  it("un número inventado por la IA es un error de la revisión", async () => {
    const t = await setup([{ data: DRAFT_WITH_INVENTED_NUMBER }]);

    const result = await evaluateListingContent(t.deps, { listingId: t.listing.id });

    expect(result.hasErrors).toBe(true);
    const instagram = result.texts.find((item) => item.platform === "instagram");
    expect(instagram?.checks.map((check) => check.code)).toContain("NUMBER_NOT_IN_DATA");
  });

  it("la IA ve el brief, nunca las notas internas", async () => {
    const t = await setup([{ data: SAMPLE_CONTENT_DRAFT }]);

    await evaluateListingContent(t.deps, { listingId: t.listing.id });

    expect(JSON.stringify(t.llm.requests)).not.toContain("tasación");
  });

  it("los errores de la IA y del aviso suben tal cual", async () => {
    const t = await setup([{ error: LLM_ERRORS.authRequired() }]);
    await expect(evaluateListingContent(t.deps, { listingId: t.listing.id })).rejects.toMatchObject(
      { code: "LLM_AUTH_REQUIRED" },
    );
    await expect(evaluateListingContent(t.deps, { listingId: "nadie" })).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
    });
  });
});
