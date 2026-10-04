import { listingContentResponseSchema } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { harness, readyListing, simulateContentWorker } from "../../test/harness.js";
import { type ContentOptions, runContent } from "./content.js";

async function prepared() {
  const h = harness();
  const listing = await readyListing(h);
  await h.contentRuns.create({ listingId: listing.id, texts: true });
  await simulateContentWorker(h, listing.id).finish();
  return { h, listing };
}

const run = (h: ReturnType<typeof harness>, options: ContentOptions = {}, ref = "P-001") =>
  runContent({ ...h.io, client: h.client }, ref, options);

describe("runContent", () => {
  it("imprime los textos vigentes de los tres canales con su revisión", async () => {
    const { h } = await prepared();

    expect(await run(h)).toBe(0);
    const text = h.text();
    expect(text).toContain("Contenido de P-001");
    expect(text).toContain("Carrusel de Instagram: 0 imágenes");
    expect(text).toContain("Última preparación: lista");
    expect(text).toContain("Instagram  borrador · listing-content-v1");
    expect(text).toContain("Departamento luminoso en Ñuñoa.");
    expect(text).toContain("#nunoa #departamento #venta #santiago #propiedades");
    expect(text).toContain("Portal Inmobiliario");
    expect(text).toContain("Facebook Marketplace");
    expect(text).toContain("Revisión:");
  });

  it("--platform portal muestra solo ese canal", async () => {
    const { h } = await prepared();

    expect(await run(h, { platform: "portal" })).toBe(0);
    const text = h.text();
    expect(text).toContain("Portal Inmobiliario");
    expect(text).not.toContain("Facebook Marketplace");
    expect(text).not.toContain("#nunoa");
  });

  it("--json entrega el contenido con el contrato (filtrado por canal si se pide)", async () => {
    const { h } = await prepared();

    expect(await run(h, { json: true, platform: "marketplace" })).toBe(0);
    const body = listingContentResponseSchema.parse(JSON.parse(h.text()));
    expect(body.contents.map((item) => item.platform)).toEqual(["fb_marketplace"]);
    expect(body.latestRun).toMatchObject({ status: "succeeded" });
  });

  it("un canal que no existe es PLATFORM_INVALID, sin llamar a la API", async () => {
    const { h } = await prepared();
    const before = h.requests.length;

    expect(await run(h, { platform: "tiktok" })).toBe(1);
    expect(h.errors()).toContain("PLATFORM_INVALID");
    expect(h.requests).toHaveLength(before);
  });

  it("sin textos todavía, sugiere preparar", async () => {
    const h = harness();
    await readyListing(h);

    expect(await run(h)).toBe(0);
    expect(h.text()).toContain("Todavía no tiene textos");
    expect(h.text()).toContain("agentsales prepare P-001");
  });
});
