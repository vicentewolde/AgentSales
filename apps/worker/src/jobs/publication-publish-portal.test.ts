import { randomUUID } from "node:crypto";
import { publishListing } from "@agentsales/core";
import {
  createInMemoryPlatformCatalogRepository,
  createPublicationScenario,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { useMercadoLibreSim } from "../../test/mercadolibre-sim.js";
import { createWorkerPortal } from "../portal.js";
import { publicationPublishJob } from "./publication-publish.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

// F4-T23: de punta a punta, el job de publicar con una publicación de Portal en `dry_run` y el
// publisher del worker con sus clientes reales contra un Mercado Libre simulado (msw): solo
// lecturas y `POST /items/validate`; nunca sube una foto ni crea o cambia un ítem.

const sim = useMercadoLibreSim();

/** Un pg-boss falso: guarda el handler de cada cola para llamarlo como lo haría `work`. */
function fakeBoss() {
  const workers = new Map<string, Parameters<WorkerBoss["work"]>[2]>();
  const boss: WorkerBoss = {
    createQueue: async () => {},
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (name, _options, handler) => {
      workers.set(name, handler);
      return name;
    },
    schedule: async () => {},
  };
  return { boss, workers };
}

async function setup() {
  const t = await createPublicationScenario({
    platform: "portal_inmobiliario",
    nextId: randomUUID,
  });
  const { logger, lines } = captureLogger();
  // Los clientes reales de Mercado Libre (sin `clients`): msw responde por ellos.
  const portal = createWorkerPortal({
    catalogRepository: createInMemoryPlatformCatalogRepository(),
    storage: t.storage,
    logger,
  });
  const [started] = (
    await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "portal_inmobiliario",
      dryRun: true,
      actor: "operator",
    })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  const job = publicationPublishJob({
    shared: {
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      contents: t.contents,
      media: t.media,
      listings: t.listings,
      brokers: t.brokers,
      storage: t.storage,
      publishers: { portal_inmobiliario: portal.publisher },
      workerMode: "dry-run",
      mercadoLibre: null,
    },
    queue: t.queue,
    signal: new AbortController().signal,
  });
  const { boss, workers } = fakeBoss();
  await registerJobs(boss, [job], logger);
  const attempt = () =>
    workers.get("publication.publish")?.([
      { id: "job-0", data: { publicationId: started.id }, retryCount: 0, retryLimit: 2 },
    ]);
  return { t, started, attempt, lines };
}

describe("job publication.publish · Portal en simulación (F4-T23)", () => {
  it("con validate en 204: queda simulada, solo con lecturas y validate", async () => {
    sim.use("accept");
    const { t, started, attempt } = await setup();

    await attempt();

    expect(t.publications.all().find((p) => p.id === started.id)).toMatchObject({
      status: "published",
      dryRun: true,
    });
    expect(await sim.writes()).toEqual([]);
    const requests = await sim.recorded();
    expect(requests.filter((r) => r.path === "/items/validate")).toHaveLength(1);
    expect(requests.every((r) => r.method === "GET" || r.path === "/items/validate")).toBe(true);
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toEqual([]);
  });

  it("sin cupo (402) la simulación pasa con la advertencia en la bitácora (D14), sin escribir", async () => {
    sim.use("no_quota");
    const { t, started, attempt } = await setup();

    await attempt();

    expect(t.publications.all().find((p) => p.id === started.id)?.status).toBe("published");
    const events = await t.publications.listEvents(started.id);
    const notes = events.flatMap((event) =>
      event.type === "publish_attempt" && Array.isArray(event.payload.notes)
        ? event.payload.notes
        : [],
    );
    expect(notes.some((note) => String(note).includes("ML_NO_QUOTA"))).toBe(true);
    expect(await sim.writes()).toEqual([]);
  });
});
