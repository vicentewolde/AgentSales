import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  confirmManualPublication,
  marketplaceProgressSchema,
  publishListing,
} from "@agentsales/core";
import { createPublicationScenario } from "@agentsales/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { createWorkerFakeFacebook } from "../../test/fake-facebook.js";
import { createWorkerMarketplacePublisher } from "../marketplace/publisher.js";
import { createMarketplaceWindows } from "../marketplace/windows.js";
import { publicationPublishJob } from "./publication-publish.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

// Prueba de punta a punta del job de publicar en Marketplace (spec F5-T10): el job, core, el
// publisher y el registro de ventanas de verdad, contra un Facebook falso de páginas locales (sin
// red: toda petición pasa por `context.route` y lo que no es local queda en `unexpected`).

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

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

async function setup(options: { form?: string } = {}) {
  const fb = await createWorkerFakeFacebook({
    "/marketplace/create/rental": options.form ?? "form.html",
    "/marketplace/item/123/": "item.html",
  });
  const t = await createPublicationScenario({ platform: "fb_marketplace" });
  const { started } = await publishListing(
    { ...t.deps, marketplace: { ufConfigured: true, automation: true } },
    { listingId: t.listingId, platform: "fb_marketplace", dryRun: false, actor: "operator" },
  );
  const publication = started[0];
  if (publication === undefined) throw new Error("no se inició la publicación");
  const { logger, lines } = captureLogger();
  const windows = createMarketplaceWindows({
    publications: t.publications,
    confirm: (publicationId, url) =>
      confirmManualPublication(
        { lock: t.deps.lock, publications: t.publications },
        { publicationId, url, actor: "system" },
      ),
    timeoutMs: 60_000,
    pollMs: 50,
    logger,
  });
  cleanups.push(async () => {
    await windows.closeAll();
    await fb.cleanup();
    expect(fb.unexpected).toEqual([]);
  });
  const tmpRoot = join(fb.root, "tmp", "marketplace");
  const openProfile = (brokerId: string) => fb.openProfile(brokerId);
  const profiles = fb.profiles;
  const job = publicationPublishJob({
    shared: {
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      contents: t.contents,
      media: t.media,
      listings: t.listings,
      brokers: t.brokers,
      storage: t.storage,
      publishers: {
        fb_marketplace: createWorkerMarketplacePublisher({
          openProfile,
          storage: t.storage,
          tmpRoot,
          windows,
          tuning: {
            fill: { pauseMs: 0, controlWaitMs: 1_000, photosWaitMs: 5_000, guardWaitMs: 1_000 },
            formWaitMs: 2_000,
            profileBusyWaitMs: 0,
          },
        }),
      },
      workerMode: "live",
      marketplaceAutomation: true,
      mercadoLibre: null,
      uf: {
        async valuesBetween(from, to) {
          return [
            { date: from, value: "41126.12" },
            { date: to, value: "41130.94" },
          ];
        },
      },
    },
    queue: t.queue,
    signal: new AbortController().signal,
    marketplaceWindows: windows,
  });
  const { boss, workers } = fakeBoss();
  await registerJobs(boss, [job], logger);
  const attempt = () =>
    workers.get("publication.publish")?.([
      { id: "job-0", data: { publicationId: publication.id }, retryCount: 0, retryLimit: 2 },
    ]);
  return { t, publication, windows, profiles, tmpRoot, lines, attempt, openProfile };
}

describe("publicar en Marketplace de punta a punta (spec F5-T10)", () => {
  it("deja el formulario listo con evidencia, y el Publicar del operador lleva a published con su enlace", async () => {
    const s = await setup();

    await s.attempt();

    const ready = await s.t.publications.get(s.publication.id);
    expect(ready?.status).toBe("awaiting_manual_confirm");
    const progress = marketplaceProgressSchema.parse(ready?.progress);
    expect(progress).toMatchObject({ simulated: false, ufValue: "41130.94" });
    // 5.800 UF a 41.130,94: el precio en pesos que quedó escrito en el formulario.
    expect(progress.priceClp).toBe(238_559_452);
    const page = s.profiles[0]?.page;
    if (page === undefined) throw new Error("no se abrió el perfil");
    expect(await page.locator('[name="precio"]').inputValue()).toBe("238559452");
    const dir = join(s.tmpRoot, s.publication.id);
    expect((await readdir(dir)).sort()).toEqual(["formulario.aria.yml", "formulario.png"]);
    expect(s.windows.size()).toBe(1);
    // Facebook sube las fotos después de adjuntarlas: tienen que seguir legibles (2026-10-14).
    await expect
      .poll(() => page.evaluate("[window.__uploadFailed, (window.__uploadOk ?? 0) > 0]"), {
        timeout: 3_000,
      })
      .toEqual([undefined, true]);
    expect(
      await page.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks),
    ).not.toContain("publicar");

    // El operador revisa la ventana y hace él el clic final (aquí, el test por él).
    await page.locator("#publicar").click();

    await expect
      .poll(async () => (await s.t.publications.get(s.publication.id))?.status, { timeout: 5_000 })
      .toBe("published");
    const published = await s.t.publications.get(s.publication.id);
    expect(published).toMatchObject({
      externalId: "123",
      externalUrl: "https://www.facebook.com/marketplace/item/123/",
    });
    // Con el aviso confirmado, el registro cierra la ventana y suelta el perfil.
    await expect.poll(() => s.windows.size()).toBe(0);
    await expect.poll(() => s.profiles[0]?.isOpen()).toBe(false);
  });

  it("ante una pantalla no esperada falla, cierra la ventana y libera el perfil", async () => {
    const s = await setup({ form: "login-form.html" });

    await s.attempt();

    const failed = await s.t.publications.get(s.publication.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toMatchObject({ code: "MARKETPLACE_SESSION_EXPIRED" });
    expect((await s.t.platformAccounts.get(failed?.platformAccountId ?? ""))?.status).toBe(
      "expired",
    );
    expect(s.windows.size()).toBe(0);
    expect(s.profiles[0]?.isOpen()).toBe(false);
    // Nada en el disco (las fotos van en memoria) y el perfil quedó libre.
    expect(await readdir(join(s.tmpRoot, s.publication.id)).catch(() => [])).toEqual([]);
    const again = await s.openProfile("otro-corredor");
    await again.close();
    const reopened = await s.openProfile(s.t.account?.brokerId ?? "");
    await reopened.close();
  });
});
