import { describe, expect, it } from "vitest";
import { publicationHarness } from "../../test/harness.js";
import { type ApproveOptions, runApprove } from "./approve.js";

type Setup = Awaited<ReturnType<typeof publicationHarness>>;

const run = ({ h, t }: Setup, options: ApproveOptions = {}) =>
  runApprove({ ...h.io, client: h.client }, t.listingId, options);

describe("runApprove", () => {
  it("sin --platform aprueba los canales sin errores e informa cada uno; nacen carrusel y reel", async () => {
    const setup = await publicationHarness({ approve: false });

    const code = await run(setup);

    expect(code).toBe(0);
    const text = setup.h.text();
    expect(text).toContain("✓ Instagram: aprobado · listas para publicar: carrusel y reel");
    expect(text).toContain("✓ Portal Inmobiliario: aprobado");
    expect(text).toContain("sin cuenta conectada: conéctala y publica con agentsales publish");
    expect(text).toContain("→ Publica con: agentsales publish");
    expect(
      setup.t.publications
        .all()
        .map((p) => p.format)
        .sort(),
    ).toEqual(["post", "reel"]);
    const events = await setup.t.publications.listEvents(setup.t.byFormat("post")?.id ?? "");
    expect(events[0]?.actor).toBe("cli");
  });

  it("un canal con errores se informa y no corta los demás; sale con 1", async () => {
    const setup = await publicationHarness({ approve: false });
    await setup.t.contents.update(await setup.t.instagramId(), {
      body: "Departamento con 99 estacionamientos",
      status: "edited",
    });

    const code = await run(setup);

    expect(code).toBe(1);
    expect(setup.h.errors()).toContain("✗ Instagram: CONTENT_HAS_ERRORS");
    expect(setup.h.errors()).toContain("corrige los errores (agentsales content");
    expect(setup.h.text()).toContain("✓ Portal Inmobiliario: aprobado");
    expect(setup.t.publications.all()).toEqual([]);
  });

  it("con --platform aprueba solo ese canal; si tiene errores, muestra el motivo de la API", async () => {
    const setup = await publicationHarness({ approve: false });
    await setup.t.contents.update(await setup.t.instagramId(), {
      body: "Departamento con 99 estacionamientos",
      status: "edited",
    });

    expect(await run(setup, { platform: "instagram" })).toBe(1);
    expect(setup.h.errors()).toContain("✗ Instagram: CONTENT_HAS_ERRORS");
    expect(setup.h.text()).not.toContain("Portal");
  });

  it("--undo quita la aprobación de los aprobados y descarta lo que no salió", async () => {
    const setup = await publicationHarness();

    expect(await run(setup, { undo: true })).toBe(0);
    expect(setup.h.text()).toContain(
      "✓ Instagram: aprobación quitada · descartadas: carrusel y reel",
    );
    expect(setup.t.publications.all().every((p) => p.status === "cancelled")).toBe(true);
  });

  it("--undo sin textos aprobados no hace nada", async () => {
    const setup = await publicationHarness({ approve: false });

    expect(await run(setup, { undo: true })).toBe(0);
    expect(setup.h.text()).toContain("no tiene textos aprobados");
  });

  it("un --platform desconocido es PLATFORM_INVALID sin llamar a la API", async () => {
    const setup = await publicationHarness();

    expect(await run(setup, { platform: "tiktok" })).toBe(1);
    expect(setup.h.errors()).toContain("PLATFORM_INVALID");
    expect(setup.h.requests).toEqual([]);
  });

  it("Portal: nace el aviso y, si le falta algo al aviso, lo avisa (se aprueba igual)", async () => {
    const setup = await publicationHarness({ platform: "portal_inmobiliario", approve: false });
    const listing = await setup.t.listings.get(setup.t.listingId);
    const broker = listing === null ? null : await setup.t.brokers.findById(listing.brokerId);
    if (broker === null) throw new Error("falta el corredor");
    const { id, logoMediaId: _logo, autoPublish: _auto, ...data } = broker;
    await setup.t.brokers.update(id, { ...data, whatsapp: null });

    expect(await run(setup, { platform: "portal" })).toBe(0);
    expect(setup.h.text()).toContain(
      "✓ Portal Inmobiliario: aprobado · listas para publicar: aviso",
    );
    expect(setup.h.errors()).toContain("Para publicar en Portal falta:");
    expect(setup.h.text()).toMatch(/→ Publica con: agentsales publish \S+ --platform portal/);
    expect(setup.h.errors()).toMatch(/ {4}• .*WhatsApp/);
  });
});
