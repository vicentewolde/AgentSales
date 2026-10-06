import { AppError, type Publication, type Publisher, publishListing } from "@agentsales/core";
import {
  createFakePublisher,
  createInMemoryJobQueue,
  createInMemoryPublicationRepository,
  createPublicationScenario,
  type FakePublisherOptions,
  PUBLICATION_SCENARIO_TOKEN,
} from "@agentsales/core/testing";
import { createInstagramPublisher } from "@agentsales/publishers";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  instagramNoteLogger,
  PUBLICATION_PUBLISH_QUEUE,
  publicationPublishJob,
  requeuePublishingPublications,
} from "./publication-publish.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

const TOKEN = PUBLICATION_SCENARIO_TOKEN;

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

/** Un aviso aprobado con carrusel y reel ya en `publishing`, y el job con sus dependencias. */
async function setup(
  options: { dryRun?: boolean; publisher?: Publisher; fake?: FakePublisherOptions } = {},
) {
  const t = await createPublicationScenario();
  const { started } = await publishListing(t.deps, {
    listingId: t.listingId,
    platform: "instagram",
    dryRun: options.dryRun ?? false,
    actor: "operator",
  });
  const fake = createFakePublisher(options.fake);
  const controller = new AbortController();
  const job = publicationPublishJob({
    shared: {
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      contents: t.contents,
      media: t.media,
      listings: t.listings,
      storage: t.storage,
      publishers: { instagram: options.publisher ?? fake },
      workerMode: "live",
    },
    signal: controller.signal,
  });
  const { logger, lines } = captureLogger();
  const { boss, workers } = fakeBoss();
  await registerJobs(boss, [job], logger);
  /** Corre un intento como pg-boss: por el registro, con su manejo de errores y su log. */
  const attempt = (publication: Publication, retryCount = 0, retryLimit = 2) =>
    workers.get("publication.publish")?.([
      { id: `job-${retryCount}`, data: { publicationId: publication.id }, retryCount, retryLimit },
    ]);
  const [post, reel] = started;
  if (post === undefined || reel === undefined) throw new Error("faltan publicaciones");
  const current = (id: string) => t.publications.all().find((p) => p.id === id);
  return { t, fake, job, lines, attempt, post, reel, current, controller };
}

describe("job publication.publish · cola", () => {
  it("es exclusive por publicationId, con 2 reintentos desde 60 s y 15 min (sobre el tope de 12 min del intento)", () => {
    expect(PUBLICATION_PUBLISH_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 900,
    });
  });
});

describe("job publication.publish · handler", () => {
  it("publica con el publisher y registra solo el resultado", async () => {
    const { fake, lines, attempt, post, current } = await setup();
    await attempt(post);
    expect(current(post.id)).toMatchObject({ status: "published" });
    expect(fake.published).toHaveLength(1);
    expect(lines.map((line) => line.msg)).toEqual([
      "job iniciado",
      "publicación publicada",
      "job terminado",
    ]);
    expect(lines[1]).toMatchObject({ mode: "live", data: { publicationId: post.id } });
  });

  it("en dry-run el log dice que fue una simulación", async () => {
    const { attempt, post, lines } = await setup({ dryRun: true });
    await attempt(post);
    expect(lines[1]).toMatchObject({
      msg: "publicación simulada (dry-run): no se envió nada",
      mode: "dry-run",
    });
  });

  it("el apagado en el último intento deja la publicación en publishing, sin bitácora, y el arranque la reencola", async () => {
    const holder: { controller?: AbortController } = {};
    const waiting: Publisher = {
      ...createFakePublisher(),
      publish: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => reject(new AppError("IG_ABORTED", "Se cortó la llamada", { retriable: true })),
            { once: true },
          );
          holder.controller?.abort();
        }),
    };
    const { t, attempt, post, current, controller, lines } = await setup({ publisher: waiting });
    holder.controller = controller;
    await expect(attempt(post, 2)).rejects.toMatchObject({ code: "IG_ABORTED", retriable: true });
    expect(current(post.id)).toMatchObject({ status: "publishing", lastError: null });
    const events = await t.publications.listEvents(post.id);
    expect(events.filter((event) => event.type === "publish_attempt")).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ code: "IG_ABORTED", retriable: true });

    const queue = createInMemoryJobQueue();
    const { requeued } = await requeuePublishingPublications(t.publications, queue);
    expect(requeued).toBe(2);
    expect(queue.jobs.map((job) => job.data)).toContainEqual({ publicationId: post.id });
  });

  it("pasa el retryCount a la bitácora y el último intento deja failed; uno no reintentable cierra el job", async () => {
    const unavailable = () =>
      new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true });
    const { t, attempt, post, reel, current, lines } = await setup({
      fake: {
        steps: [
          { error: unavailable() },
          { error: unavailable() },
          { error: new AppError("IG_MEDIA_REJECTED", "rechazado") },
        ],
      },
    });
    await expect(attempt(post, 0)).rejects.toMatchObject({ code: "IG_UNAVAILABLE" });
    expect(current(post.id)?.status).toBe("publishing");
    await expect(attempt(post, 2)).rejects.toMatchObject({ code: "IG_UNAVAILABLE" });
    expect(current(post.id)?.status).toBe("failed");
    const events = (await t.publications.listEvents(post.id)).filter(
      (event) => event.type === "publish_attempt",
    );
    expect(events.map((event) => event.payload.retry)).toEqual([0, 2]);

    // No reintentable: el registro lo anota y no lo relanza (pg-boss no reintenta).
    await expect(attempt(reel, 0)).resolves.toBeUndefined();
    expect(current(reel.id)?.status).toBe("failed");
    expect(lines.at(-1)).toMatchObject({
      msg: "job falló sin reintento (error no reintentable)",
      code: "IG_MEDIA_REJECTED",
      retriable: false,
    });
  });

  it("una que ya no está en publishing no se toca", async () => {
    const { attempt, post, lines } = await setup();
    await attempt(post);
    await attempt(post);
    expect(
      lines.filter((line) => line.msg === "la publicación no estaba en curso: nada que hacer"),
    ).toHaveLength(1);
  });

  it("una publicación en dry-run, con el worker en live, no construye el cliente de Instagram", async () => {
    const graph = vi.fn(() => {
      throw new Error("no debía construirse el cliente");
    });
    const { attempt, post, current } = await setup({
      dryRun: true,
      publisher: createInstagramPublisher({ graph }),
    });
    await attempt(post);
    expect(current(post.id)).toMatchObject({
      status: "published",
      externalId: `dry-run:${post.id}`,
    });
    expect(graph).not.toHaveBeenCalled();
  });

  it("los logs no llevan tokens, URLs firmadas ni el caption, ni siquiera en un error interno", async () => {
    const { t, attempt, post, reel, lines } = await setup({
      fake: { steps: [{}, { error: new Error("falló con el caption y IGAA-prueba") }] },
    });
    const caption = (await t.contents.get(post.contentId))?.body ?? "";
    expect(caption.length).toBeGreaterThan(20);
    await attempt(post);
    await attempt(reel);
    const written = JSON.stringify(lines);
    expect(lines.at(-1)).toMatchObject({ code: "INTERNAL_ERROR", retriable: false });
    for (const secret of [TOKEN, "memory://", "ttl=", caption.slice(0, 20), "con el caption"]) {
      expect(written).not.toContain(secret);
    }
  });

  it("un paso secundario que falla queda en el log con su paso y código", async () => {
    const { t, attempt, post, lines } = await setup();
    const original = t.listings.changeStatus.bind(t.listings);
    let failed = false;
    vi.spyOn(t.listings, "changeStatus").mockImplementation(async (...args) => {
      if (!failed) {
        failed = true;
        throw new AppError("DB_UNAVAILABLE", "La base no respondió", { retriable: true });
      }
      return original(...args);
    });
    await attempt(post);
    expect(
      lines.find((line) => line.msg === "un paso secundario de la publicación falló"),
    ).toMatchObject({ step: "listing_active", code: "DB_UNAVAILABLE" });
  });
});

describe("requeuePublishingPublications", () => {
  it("reencola todas las que están en publishing (idempotente por singletonKey) y sigue si una falla", async () => {
    const publications = createInMemoryPublicationRepository();
    const ids: string[] = [];
    for (const format of ["post", "reel"] as const) {
      const created = await publications.create(
        {
          listingId: "l1",
          platformAccountId: "a1",
          platform: "instagram",
          format,
          contentId: "c1",
          mediaIds: [],
        },
        { actor: "operator" },
      );
      await publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        { actor: "operator" },
      );
      ids.push(created.id);
    }
    await publications.create(
      {
        listingId: "l2",
        platformAccountId: "a1",
        platform: "instagram",
        format: "post",
        contentId: "c2",
        mediaIds: [],
      },
      { actor: "operator" },
    );
    let calls = 0;
    const queue = createInMemoryJobQueue({
      fail: () =>
        ++calls === 1
          ? new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true })
          : undefined,
    });
    await expect(requeuePublishingPublications(publications, queue)).resolves.toEqual({
      requeued: 1,
      failed: [ids[0]],
    });
    expect(queue.jobs).toEqual([
      {
        name: "publication.publish",
        data: { publicationId: ids[1] },
        options: { singletonKey: ids[1] },
      },
    ]);
  });
});

describe("instagramNoteLogger", () => {
  it("registra la nota con el publicationId y su código, nada más", () => {
    const { logger, lines } = captureLogger();
    instagramNoteLogger(logger)({
      publicationId: "p1",
      code: "QUOTA_UNAVAILABLE",
      errorCode: "IG_REQUEST_REJECTED",
    });
    expect(lines).toEqual([
      expect.objectContaining({
        msg: "nota del publicador de Instagram",
        publicationId: "p1",
        code: "QUOTA_UNAVAILABLE",
        errorCode: "IG_REQUEST_REJECTED",
      }),
    ]);
  });
});
