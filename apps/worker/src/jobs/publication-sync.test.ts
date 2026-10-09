import { randomUUID } from "node:crypto";
import {
  AppError,
  type Publication,
  type PublicationOperations,
  type Publisher,
  publishListing,
  type RemoteStatus,
} from "@agentsales/core";
import { createPublicationScenario, type PublicationScenario } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { publicationPublishJob } from "./publication-publish.js";
import {
  enqueueLiveSyncs,
  PUBLICATION_SYNC_QUEUE,
  PUBLISHED_SYNC_DELAY_MS,
  publicationSyncJob,
} from "./publication-sync.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

const PORTAL = "portal_inmobiliario";
// La hora real: el token del escenario vence una hora después de crearlo.
const NOW = new Date();

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

/** Operaciones de Portal guionadas: `getStatus` responde con `respond` y cuenta las llamadas. */
function fakeOperations(respond: () => Promise<RemoteStatus>) {
  const calls: string[] = [];
  const unused = async (): Promise<RemoteStatus> => {
    throw new Error("el sync solo lee");
  };
  const operations: PublicationOperations = {
    pause: unused,
    resume: unused,
    close: unused,
    getStatus: async (ref) => {
      calls.push(ref.externalId);
      return respond();
    },
  };
  return { operations, calls };
}

const active: RemoteStatus = {
  status: "active",
  subStatus: [],
  stopTime: "2027-04-07T12:00:00.000-03:00",
  expirationTime: null,
};

/** Una publicación de Portal ya publicada (como la deja el intento), con ids uuid (los jobs los exigen). */
async function publishedPortal(t: PublicationScenario, dryRun: boolean): Promise<Publication> {
  const [started] = (
    await publishListing(t.deps, { listingId: t.listingId, platform: PORTAL, dryRun, actor: "cli" })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  if (!dryRun) {
    await t.publications.saveProgress(started.id, {
      pictureIds: ["1-MLC_PIC"],
      sellerContact: { contact: null, email: null, countryCode2: "56", phone2: "911112222" },
      itemId: "MLC1234567890",
      descriptionDone: true,
    });
  }
  return t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: { externalId: dryRun ? `dry-run:${started.id}` : "MLC1234567890" },
    },
    { actor: "system" },
  );
}

async function setup(respond: () => Promise<RemoteStatus> = async () => active) {
  const t = await createPublicationScenario({ platform: PORTAL, nextId: () => randomUUID() });
  const fake = fakeOperations(respond);
  const job = publicationSyncJob({
    shared: {
      lock: t.deps.lock,
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      mercadoLibre: null,
      operationsFor: (platform) => (platform === PORTAL ? fake.operations : undefined),
      now: () => NOW,
    },
    signal: new AbortController().signal,
  });
  const { logger, lines } = captureLogger();
  const { boss, workers } = fakeBoss();
  await registerJobs(boss, [job], logger);
  const attempt = (publication: Publication, retryCount = 0, retryLimit = 2) =>
    workers.get("publication.sync")?.([
      { id: `job-${retryCount}`, data: { publicationId: publication.id }, retryCount, retryLimit },
    ]);
  const current = (id: string) => t.publications.all().find((p) => p.id === id);
  return { t, calls: fake.calls, attempt, lines, current };
}

describe("job publication.sync", () => {
  it("la política: exclusive por publicación, 2 reintentos desde 60 s y expira a los 2 min", () => {
    expect(PUBLICATION_SYNC_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 120,
    });
  });

  it("en live lee la plataforma y guarda lo leído; correrlo de nuevo no cambia nada más (idempotente)", async () => {
    const { t, calls, attempt, current, lines } = await setup();
    const publication = await publishedPortal(t, false);

    await attempt(publication);
    await attempt(publication);

    expect(calls).toEqual(["MLC1234567890", "MLC1234567890"]);
    expect(current(publication.id)).toMatchObject({
      status: "published",
      remoteState: { status: "active", checkedAt: NOW.toISOString() },
    });
    const events = await t.publications.listEvents(publication.id);
    expect(events.filter((event) => event.type === "sync")).toHaveLength(2);
    expect(events.filter((event) => event.toStatus === "published")).toHaveLength(1);
    expect(JSON.stringify(lines)).toContain("sync: estado de la plataforma guardado");
  });

  it("solo live: una publicación de dry-run se salta sin llamar a la plataforma", async () => {
    const { t, calls, attempt, current, lines } = await setup();
    const publication = await publishedPortal(t, true);

    await attempt(publication);

    expect(calls).toEqual([]);
    expect(current(publication.id)?.remoteState).toBeNull();
    expect(JSON.stringify(lines)).toContain("sync: nada que leer");
  });

  it("si la publicación cambió mientras se leía: se reintenta; en el último intento, información y cierra", async () => {
    let operatorPauses: (() => Promise<unknown>) | undefined;
    const { t, attempt, lines } = await setup(async () => {
      await operatorPauses?.();
      return active;
    });
    const publication = await publishedPortal(t, false);
    operatorPauses = async () => {
      operatorPauses = undefined;
      await t.publications.transition(
        publication.id,
        { from: "published", to: "paused" },
        { actor: "operator" },
      );
    };

    await expect(attempt(publication, 0)).rejects.toMatchObject({
      code: "PUBLICATION_SYNC_STALE",
    });

    operatorPauses = async () => {
      operatorPauses = undefined;
      await t.publications.transition(
        publication.id,
        { from: "paused", to: "published" },
        { actor: "operator" },
      );
    };
    await expect(attempt(publication, 2)).resolves.toBeUndefined();
    // Información (pino: 30), no un error, y el job se cierra bien.
    const stale = lines.find((line) => String(line.msg).includes("se lee en el próximo sync"));
    expect(stale).toMatchObject({ level: 30, code: "PUBLICATION_SYNC_STALE" });
    expect(lines.at(-1)).toMatchObject({ msg: "job terminado" });
  });

  it("un error de la plataforma no reintentable cierra el job sin reintento; uno reintentable sube", async () => {
    let error = new AppError("ML_REQUEST_REJECTED", "rechazado");
    const { t, attempt } = await setup(async () => {
      throw error;
    });
    const publication = await publishedPortal(t, false);

    await expect(attempt(publication)).resolves.toBeUndefined();
    error = new AppError("ML_UNAVAILABLE", "sin respuesta", { retriable: true });
    await expect(attempt(publication)).rejects.toMatchObject({ code: "ML_UNAVAILABLE" });
  });
});

describe("al arrancar: el sync de las de Portal en live", () => {
  it("encola solo Portal en live, published o paused, con la cuenta conectada", async () => {
    const { t } = await setup();
    const live = await publishedPortal(t, false);
    const other = await createPublicationScenario({
      platform: PORTAL,
      nextId: () => randomUUID(),
    });
    await publishedPortal(other, true);
    const disconnected = await publishedPortal(
      await createPublicationScenario({ platform: PORTAL, nextId: () => randomUUID() }),
      false,
    );

    const publications = {
      listByStatus: async (status: Publication["status"]) => [
        ...(await t.publications.listByStatus(status)),
        ...(await other.publications.listByStatus(status)),
        ...(status === "published" ? [disconnected] : []),
      ],
    };
    // La cuenta de la de dry-run está conectada: se salta por ser simulación, no por la cuenta.
    const accounts = {
      get: async (id: string) =>
        id === disconnected.platformAccountId
          ? null
          : ((await t.platformAccounts.get(id)) ?? (await other.platformAccounts.get(id))),
    };

    const result = await enqueueLiveSyncs(publications, accounts, t.queue);

    expect(result).toEqual({ enqueued: 1, alreadyQueued: 0, failed: [] });
    expect(t.queue.jobs).toContainEqual({
      name: "publication.sync",
      data: { publicationId: live.id },
      options: { singletonKey: live.id },
    });
  });

  it("una que falla al encolar no corta las demás", async () => {
    const { t } = await setup();
    const live = await publishedPortal(t, false);
    const result = await enqueueLiveSyncs(t.publications, t.platformAccounts, {
      enqueue: async () => {
        throw new AppError("QUEUE_UNAVAILABLE", "sin cola", { retriable: true });
      },
    });
    expect(result).toEqual({
      enqueued: 0,
      alreadyQueued: 0,
      failed: [{ publicationId: live.id, code: "QUEUE_UNAVAILABLE" }],
    });
  });

  it("también las pausadas; una con la cuenta vencida no; una ya en cola se cuenta aparte", async () => {
    const { t } = await setup();
    const paused = await publishedPortal(t, false);
    await t.publications.transition(
      paused.id,
      { from: "published", to: "paused" },
      { actor: "operator" },
    );
    const expiredScenario = await createPublicationScenario({
      platform: PORTAL,
      nextId: () => randomUUID(),
    });
    const expired = await publishedPortal(expiredScenario, false);
    await expiredScenario.platformAccounts.changeStatus(
      expired.platformAccountId,
      "connected",
      "expired",
    );
    const publications = {
      listByStatus: async (status: Publication["status"]) => [
        ...(await t.publications.listByStatus(status)),
        ...(await expiredScenario.publications.listByStatus(status)),
      ],
    };
    const accounts = {
      get: async (id: string) =>
        (await t.platformAccounts.get(id)) ?? (await expiredScenario.platformAccounts.get(id)),
    };

    expect(await enqueueLiveSyncs(publications, accounts, t.queue)).toEqual({
      enqueued: 1,
      alreadyQueued: 0,
      failed: [],
    });
    expect(
      t.queue.jobs.filter((job) => job.name === "publication.sync").map((job) => job.data),
    ).toEqual([{ publicationId: paused.id }]);
    expect(await enqueueLiveSyncs(publications, accounts, { enqueue: async () => null })).toEqual({
      enqueued: 0,
      alreadyQueued: 1,
      failed: [],
    });
  });
});

describe("job publication.publish: el sync 2 min después de publicar Portal en live", () => {
  /** Un publisher de Portal que siempre publica. */
  const portalPublisher: Publisher = {
    platform: PORTAL,
    formats: ["post"],
    validate: () => ({ ok: true }),
    preflight: async () => ({ ok: true }),
    publish: async () => ({
      externalId: "MLC1234567890",
      externalUrl: null,
      simulated: false,
    }),
  };

  async function publishSetup(
    dryRun: boolean,
    queue?: (t: PublicationScenario) => Pick<PublicationScenario["queue"], "enqueue">,
  ) {
    const t = await createPublicationScenario({ platform: PORTAL, nextId: () => randomUUID() });
    const [publication] = (
      await publishListing(t.deps, {
        listingId: t.listingId,
        platform: PORTAL,
        dryRun,
        actor: "cli",
      })
    ).started;
    if (publication === undefined) throw new Error("falta la publicación");
    const job = publicationPublishJob({
      shared: {
        publications: t.publications,
        platformAccounts: t.platformAccounts,
        contents: t.contents,
        media: t.media,
        listings: t.listings,
        brokers: t.brokers,
        storage: t.storage,
        publishers: { [PORTAL]: portalPublisher },
        workerMode: "live",
        mercadoLibre: null,
      },
      queue: queue?.(t) ?? t.queue,
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const { logger, lines } = captureLogger();
    const { boss, workers } = fakeBoss();
    await registerJobs(boss, [job], logger);
    await workers.get("publication.publish")?.([
      { id: "job-0", data: { publicationId: publication.id }, retryCount: 0, retryLimit: 2 },
    ]);
    return { t, publication, lines };
  }

  it("en live encola el sync en 2 min con la clave de la publicación", async () => {
    const { t, publication } = await publishSetup(false);
    expect(t.queue.jobs).toContainEqual({
      name: "publication.sync",
      data: { publicationId: publication.id },
      options: {
        singletonKey: publication.id,
        startAfter: new Date(NOW.getTime() + PUBLISHED_SYNC_DELAY_MS),
      },
    });
  });

  it("si la cola falla, avisa solo con el código y el job termina bien; si ya había uno, lo anota", async () => {
    const failing = await publishSetup(false, (t) => ({
      enqueue: async (name, data, options) => {
        if (name === "publication.sync") {
          throw new AppError("QUEUE_UNAVAILABLE", "sin cola", { retriable: true });
        }
        return t.queue.enqueue(name, data, options);
      },
    }));
    expect(failing.lines.find((line) => line.level === 40)).toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      msg: "no se pudo encolar el sync de la publicación: lo hace el arranque o Actualizar",
    });
    expect(failing.lines.at(-1)).toMatchObject({ msg: "job terminado" });

    const queued = await publishSetup(false, () => ({ enqueue: async () => null }));
    expect(JSON.stringify(queued.lines)).toContain("ya había un sync de la publicación en la cola");
  });

  it("en dry-run no encola ningún sync", async () => {
    const { t } = await publishSetup(true);
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toEqual([]);
  });
});
