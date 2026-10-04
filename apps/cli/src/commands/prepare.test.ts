import { AppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import {
  fakeClock,
  harness,
  readyListing,
  sampleContents,
  simulateContentWorker,
} from "../../test/harness.js";
import { type PrepareOptions, runPrepare } from "./prepare.js";

type Harness = ReturnType<typeof harness>;

const run = (
  h: Harness,
  clock: ReturnType<typeof fakeClock>,
  options: PrepareOptions = {},
  ref = "P-001",
) => runPrepare({ ...h.io, client: h.client, sleep: clock.sleep, now: clock.now }, ref, options);

describe("runPrepare", () => {
  it("pide la corrida, muestra cada etapa y termina con el resumen y la revisión", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 2_000) await worker.stage("media");
      if (elapsed === 4_000) await worker.stage("renders");
      if (elapsed === 6_000) await worker.stage("texts");
      if (elapsed === 8_000) await worker.finish();
    });

    const code = await run(h, clock);

    expect(code).toBe(0);
    expect(clock.sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
    const created = await h.contentRuns.latest(listing.id);
    expect(h.queue.jobs).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: created?.id },
        options: { singletonKey: created?.id },
      },
    ]);
    expect(h.out[0]).toBe(`Preparación ${created?.id} (P-001): en cola…`);
    expect(h.out).toEqual(
      expect.arrayContaining([
        "procesando fotos y videos…",
        "armando la portada y la ficha…",
        "redactando los textos…",
      ]),
    );
    const text = h.text();
    expect(text).toContain(`Preparación ${created?.id}  lista`);
    expect(text).toContain("Medios: procesados 1 · ya estaban 0 · ilegibles 0");
    expect(text).toContain("Portada y ficha: armadas 2 · sin cambios 0");
    expect(text).toContain("Reel: sin video");
    expect(text).toContain("Textos: listing-content-v1 · 1 intento · 12 s");
    expect(text).toContain("Advertencias (1)");
    expect(text).toContain("Revisión editorial");
    expect(text).toContain("Instagram: sin problemas");
    expect(text).toContain("→ Mira los textos con: agentsales content P-001");
    // El modelo de la IA no sale en la vista.
    expect(text).not.toContain("modelo-falso");
  });

  it("la revisión muestra los problemas de cada canal", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(() => worker.finish(sampleContents("Un departamento increíble.")));

    expect(await run(h, clock)).toBe(0);
    expect(h.text()).toContain("Instagram: 1 advertencia");
    expect(h.text()).toContain("⚠ SUPERLATIVE:");
  });

  it("avisa si sigue en cola a los 20 s", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 24_000) await worker.finish();
    });

    expect(await run(h, clock)).toBe(0);
    expect(h.out).toContain("Sigue en cola: ¿está corriendo el worker? (pnpm dev)");
  });

  it("si ya había una corrida activa, sigue esa y lo dice", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const active = await h.contentRuns.create({ listingId: listing.id, texts: false });
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(() => worker.finish());

    expect(await run(h, clock)).toBe(0);
    expect(h.errors()).toContain(
      "Ya había una preparación de P-001 en curso: sigo esa (esa no redacta los textos)",
    );
    expect(h.out[0]).toBe(`Preparación ${active.id} (P-001): en cola…`);
    expect(h.text()).toContain("sin textos (--no-texts)");
  });

  it("--no-wait con una corrida reusada: el id sigue siendo la única línea de stdout", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const active = await h.contentRuns.create({ listingId: listing.id, texts: true });

    expect(await run(h, fakeClock(), { wait: false })).toBe(0);
    expect(h.out).toEqual([active.id]);
    expect(h.errors()).toContain("Ya había una preparación");
  });

  it("si la revisión no se puede leer al final, muestra el resumen y sale con 0", async () => {
    const h = harness({
      beforeRequest: (url, method) => {
        if (method === "GET" && url.endsWith("/content")) throw new Error("sin conexión");
      },
    });
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);

    expect(
      await run(
        h,
        fakeClock(() => worker.finish()),
      ),
    ).toBe(0);
    expect(h.text()).toContain("lista");
    expect(h.errors()).toContain("No se pudo leer la revisión editorial");
  });

  it("--no-wait imprime el id y sale sin consultar", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const clock = fakeClock();

    expect(await run(h, clock, { wait: false })).toBe(0);
    const created = await h.contentRuns.latest(listing.id);
    expect(h.out).toEqual([created?.id]);
    expect(h.errors()).toContain("agentsales content P-001");
    expect(clock.sleeps).toEqual([]);
  });

  it("--no-texts pide una corrida sin textos y no muestra la revisión", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(() => worker.finish());

    expect(await run(h, clock, { texts: false })).toBe(0);
    expect(await h.contentRuns.latest(listing.id)).toMatchObject({ texts: false });
    expect(h.text()).not.toContain("Revisión editorial");
    expect(h.requests).not.toContain(`GET /listings/${listing.id}/content`);
  });

  it("con textos editados a mano se detiene y explica; con --replace-edits sigue", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    await h.contentRuns.create({ listingId: listing.id, texts: true });
    await worker.finish();
    const [instagram] = await h.contents.listCurrent(listing.id);
    await h.contents.update(instagram?.id ?? "", { body: "a mano", status: "edited" });

    const blocked = fakeClock();
    expect(await run(h, blocked)).toBe(1);
    expect(h.errors()).toContain("✗ CONTENT_EDITED: P-001 tiene textos editados a mano");
    expect(h.errors()).toContain("--no-texts");
    expect(h.errors()).toContain("--replace-edits");

    const clock = fakeClock(() => worker.finish(sampleContents("Texto nuevo de la IA.")));
    expect(await run(h, clock, { replaceEdits: true })).toBe(0);
    // La edición a mano quedó reemplazada por los textos nuevos.
    const [current] = await h.contents.listCurrent(listing.id);
    expect(current).toMatchObject({ status: "draft", body: "Texto nuevo de la IA." });
  });

  it("una corrida fallida sale con 1 y muestra el código y el mensaje", async () => {
    const h = harness();
    const listing = await readyListing(h);
    const worker = simulateContentWorker(h, listing.id);
    const clock = fakeClock(() =>
      worker.fail(
        "LLM_AUTH_REQUIRED",
        "La CLI de Claude no tiene sesión: ábrela con `claude` y usa /login",
      ),
    );

    expect(await run(h, clock)).toBe(1);
    expect(h.text()).toContain(
      "Error: LLM_AUTH_REQUIRED: La CLI de Claude no tiene sesión: ábrela con `claude` y usa /login",
    );
    expect(h.errors()).toContain("La preparación falló");
  });

  it("un aviso que no está listo, o que no existe, sale con 1 y un mensaje claro", async () => {
    const h = harness();
    const listing = await readyListing(h);
    h.listings.setStatus(listing.id, "draft");

    expect(await run(h, fakeClock())).toBe(1);
    expect(h.errors()).toContain("✗ LISTING_NOT_READY: El aviso tiene que estar listo");
    expect(h.errors()).toContain("agentsales listing P-001");

    expect(await run(h, fakeClock(), {}, "NADA")).toBe(1);
    expect(h.errors()).toContain("LISTING_NOT_FOUND");
  });

  it("si la API deja de responder mientras espera, para tras 3 fallas", async () => {
    let down = false;
    const h = harness({
      beforeRequest: (url) => {
        if (down && url.includes("/content-runs/")) {
          throw new AppError("ECONNREFUSED", "sin conexión");
        }
      },
    });
    await readyListing(h);
    const clock = fakeClock(() => {
      down = true;
    });

    expect(await run(h, clock)).toBe(1);
    expect(clock.sleeps).toHaveLength(3);
    expect(h.errors()).toContain("Dejé de esperar; revisa la preparación más tarde");
  });
});
