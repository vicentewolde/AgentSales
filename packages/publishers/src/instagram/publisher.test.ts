import {
  type AbortSignalLike,
  type PlatformAccount,
  type PublishContext,
  type PublishInput,
  type PublishMediaItem,
  withDryRun,
} from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { useInstagramServer } from "../../test/instagram-server.js";
import { INSTAGRAM_ERRORS } from "./errors.js";
import { createInstagramGraph } from "./graph.js";
import {
  abortableSleep,
  createInstagramPublisher,
  type InstagramPublishNote,
} from "./publisher.js";

const BASE = "https://graph.instagram.com/v25.0";
const IG = "17841400000000001";
const TOKEN = "IGAA-token-de-prueba";
const START = Date.parse("2026-10-05T12:00:00Z");

const { server } = useInstagramServer();

type PublishBehavior = "ok" | "error-after-publish" | "error" | "not-ready";

/**
 * Instagram simulado con estado: recuerda los contenedores (con un guion de estados por consulta),
 * las publicaciones y el orden de lo que pasó (`log`), para afirmar que nada se publica dos veces.
 */
function fakeInstagram(clock: { now: number }) {
  let nextContainer = 0;
  let nextMedia = 0;
  const containers = new Map<
    string,
    { fields: Record<string, string>; statuses: string[]; published: number; mediaId?: string }
  >();
  const media = new Map<
    string,
    { id: string; caption: string; timestamp: string; permalink: string }
  >();
  const log: string[] = [];
  const state = {
    containers,
    media,
    log,
    /** Estados que devuelve cada contenedor nuevo, en orden (el último se repite). */
    statusesFor: (_fields: Record<string, string>): string[] => ["FINISHED"],
    publishBehaviors: [] as PublishBehavior[],
    quota: { quota_usage: 0, config: { quota_total: 100 } } as unknown,
    quotaRejects: false,
    mediaFails: false,
    /** Registra un contenedor de un intento anterior. */
    seed(id: string, statuses: string[], fields: Record<string, string> = {}) {
      containers.set(id, { fields, statuses, published: 0 });
    },
    /** Un medio ya publicado en la cuenta. */
    seedMedia(id: string, caption: string, timestamp: number) {
      media.set(id, {
        id,
        caption,
        timestamp: new Date(timestamp).toISOString(),
        permalink: `https://www.instagram.com/p/${id}/`,
      });
    },
    publishCount: (id: string) => containers.get(id)?.published ?? 0,
  };

  const publishMedia = (containerId: string) => {
    const container = containers.get(containerId);
    if (container === undefined) throw new Error(`sin contenedor ${containerId}`);
    container.published += 1;
    const id = `m-${++nextMedia}`;
    container.mediaId = id;
    state.seedMedia(id, container.fields.caption ?? "", clock.now);
    return id;
  };

  server.use(
    http.get(`${BASE}/${IG}/content_publishing_limit`, () => {
      log.push("quota");
      return state.quotaRejects
        ? HttpResponse.json({ error: { code: 100, message: "Unsupported" } }, { status: 400 })
        : HttpResponse.json({ data: [state.quota] });
    }),
    http.post(`${BASE}/${IG}/media`, async ({ request }) => {
      const fields = Object.fromEntries(new URLSearchParams(await request.text()));
      const id = `c-${++nextContainer}`;
      containers.set(id, { fields, statuses: [...state.statusesFor(fields)], published: 0 });
      log.push(`create:${id}`);
      return HttpResponse.json({ id });
    }),
    http.get(`${BASE}/${IG}/media`, () => {
      log.push("recent");
      return HttpResponse.json({ data: [...media.values()].reverse() });
    }),
    http.post(`${BASE}/${IG}/media_publish`, async ({ request }) => {
      const containerId = new URLSearchParams(await request.text()).get("creation_id") ?? "";
      log.push(`publish:${containerId}`);
      const behavior = state.publishBehaviors.shift() ?? "ok";
      if (behavior === "not-ready") {
        return HttpResponse.json(
          { error: { code: 9007, error_subcode: 2207027 } },
          { status: 400 },
        );
      }
      if (behavior === "error") return new HttpResponse("caído", { status: 500 });
      const id = publishMedia(containerId);
      return behavior === "error-after-publish"
        ? new HttpResponse("se cortó", { status: 502 })
        : HttpResponse.json({ id });
    }),
    http.get(`${BASE}/:id`, ({ params }) => {
      const id = String(params.id);
      const container = containers.get(id);
      if (container !== undefined) {
        log.push(`status:${id}`);
        const status_code =
          container.published > 0
            ? "PUBLISHED"
            : container.statuses.length > 1
              ? (container.statuses.shift() ?? "FINISHED")
              : (container.statuses[0] ?? "FINISHED");
        const [code, subcode] = status_code.split(":");
        return HttpResponse.json({
          status_code: code,
          status: subcode === undefined ? code : `Error: ${subcode}`,
        });
      }
      const item = media.get(id);
      if (item !== undefined) {
        log.push(`media:${id}`);
        if (state.mediaFails) return new HttpResponse("caído", { status: 500 });
        return HttpResponse.json(item);
      }
      return HttpResponse.json({ error: { code: 100 } }, { status: 400 });
    }),
  );
  return state;
}

const photo = (index: number): PublishMediaItem => ({
  mediaId: `media-${index}`,
  kind: "image",
  mime: "image/jpeg",
  storagePath: `brokers/b/listings/l/processed/ig_4x5/${index}.jpg`,
  url: `https://r2.test/${index}.jpg?X-Amz-Signature=firma`,
  bytes: 300_000,
  width: 1080,
  height: 1350,
  durationS: null,
});

const post = (count: number, caption = "Depto luminoso en Ñuñoa\n\n#nunoa"): PublishInput => ({
  publicationId: "pub-1",
  platform: "instagram",
  format: "post",
  title: null,
  caption,
  media: Array.from({ length: count }, (_, i) => photo(i + 1)),
});

const reelInput: PublishInput = {
  ...post(0, "Reel en Ñuñoa"),
  format: "reel",
  media: [
    {
      ...photo(1),
      kind: "video",
      mime: "video/mp4",
      url: "https://r2.test/reel.mp4?X-Amz-Signature=firma",
      height: 1920,
      durationS: 30,
    },
  ],
};

const account: PlatformAccount = {
  id: "account-1",
  brokerId: "broker-1",
  platform: "instagram",
  externalAccountId: IG,
  displayName: "@corredora",
  status: "connected",
  tokenExpiresAt: null,
  meta: {},
  hasCredentials: true,
  createdAt: new Date(START),
  updatedAt: new Date(START),
};

/** Reloj falso: `sleep` avanza el reloj al instante y anota cuánto se esperó. */
function setup(options: { signal?: AbortSignalLike; progress?: unknown } = {}) {
  const clock = { now: START };
  const sleeps: number[] = [];
  const notes: InstagramPublishNote[] = [];
  const ig = fakeInstagram(clock);
  const saved: unknown[] = [];
  const publisher = createInstagramPublisher({
    now: () => new Date(clock.now),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    onNote: (note) => notes.push(note),
  });
  const context = (progress: unknown = options.progress ?? null): PublishContext => ({
    account,
    credentials: { accessToken: TOKEN },
    progress,
    async saveProgress(value) {
      saved.push(value);
      ig.log.push("save");
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { clock, sleeps, notes, ig, saved, publisher, context };
}

describe("createInstagramPublisher · contenedores nuevos", () => {
  it("carrusel de 3: hijos sin caption, el carrusel con children y caption, progreso antes de publicar y el enlace del carrusel", async () => {
    const { ig, saved, publisher, context } = setup();
    const input = post(3);
    await expect(publisher.publish(input, context())).resolves.toEqual({
      externalId: "m-1",
      externalUrl: "https://www.instagram.com/p/m-1/",
      simulated: false,
    });
    expect([1, 2, 3].map((n) => ig.containers.get(`c-${n}`)?.fields)).toEqual(
      [1, 2, 3].map((n) => ({ image_url: photo(n).url, is_carousel_item: "true" })),
    );
    expect(ig.containers.get("c-4")?.fields).toEqual({
      media_type: "CAROUSEL",
      children: "c-1,c-2,c-3",
      caption: input.caption,
    });
    expect(saved).toEqual([
      {
        attemptStartedAt: new Date(START).toISOString(),
        childIds: ["c-1", "c-2", "c-3"],
        containerId: "c-4",
      },
    ]);
    expect(ig.log).toEqual([
      "quota",
      "create:c-1",
      "create:c-2",
      "create:c-3",
      "status:c-1",
      "status:c-2",
      "status:c-3",
      "create:c-4",
      "save",
      "status:c-4",
      "publish:c-4",
      "media:m-1",
    ]);
  });

  it("imagen suelta: un contenedor con image_url y caption, sin hijos", async () => {
    const { ig, saved, publisher, context } = setup();
    await publisher.publish(post(1), context());
    expect(ig.containers.get("c-1")?.fields).toEqual({
      image_url: photo(1).url,
      caption: post(1).caption,
    });
    expect(saved).toMatchObject([{ childIds: [], containerId: "c-1" }]);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("reel: REELS con thumb_offset y share_to_feed, sondeo IN_PROGRESS → FINISHED a los 5 y 10 s", async () => {
    const { ig, sleeps, publisher, context } = setup();
    ig.statusesFor = () => ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    await expect(publisher.publish(reelInput, context())).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.containers.get("c-1")?.fields).toEqual({
      media_type: "REELS",
      video_url: reelInput.media[0]?.url,
      caption: "Reel en Ñuñoa",
      thumb_offset: "1000",
      share_to_feed: "true",
    });
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(ig.log.filter((entry) => entry.startsWith("status"))).toHaveLength(3);
  });

  it("sondeo agotado: IG_CONTAINER_TIMEOUT reintentable a los 5 min, con el progreso guardado", async () => {
    const { ig, sleeps, saved, publisher, context } = setup();
    ig.statusesFor = () => ["IN_PROGRESS"];
    await expect(publisher.publish(reelInput, context())).rejects.toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
      retriable: true,
    });
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
    expect(saved).toHaveLength(1);
    expect(ig.publishCount("c-1")).toBe(0);
  });

  it("un contenedor en ERROR se clasifica por su subcódigo (sin subcódigo, reintentable)", async () => {
    const rejected = setup();
    rejected.ig.statusesFor = () => ["ERROR:2207026"];
    await expect(rejected.publisher.publish(reelInput, rejected.context())).rejects.toMatchObject({
      code: "IG_MEDIA_REJECTED",
      retriable: false,
    });
    const unknown = setup();
    unknown.ig.statusesFor = () => ["ERROR"];
    await expect(unknown.publisher.publish(reelInput, unknown.context())).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
    });
  });

  it("si media_publish dice que aún no está listo, consulta el estado y publica una vez", async () => {
    const { ig, publisher, context } = setup();
    ig.publishBehaviors = ["not-ready", "ok"];
    await expect(publisher.publish(post(1), context())).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.log.slice(ig.log.indexOf("publish:c-1"))).toEqual([
      "publish:c-1",
      "status:c-1",
      "publish:c-1",
      "media:m-1",
    ]);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("si falla leer el enlace, la publicación queda hecha sin enlace (no se repite)", async () => {
    const { ig, publisher, context } = setup();
    ig.mediaFails = true;
    await expect(publisher.publish(post(1), context())).resolves.toEqual({
      externalId: "m-1",
      externalUrl: null,
      simulated: false,
    });
  });
});

describe("createInstagramPublisher · cupo", () => {
  it("sin cupo: IG_PUBLISH_LIMIT sin crear contenedores", async () => {
    const { ig, publisher, context } = setup();
    ig.quota = { quota_usage: 100, config: { quota_total: 100 } };
    await expect(publisher.publish(post(2), context())).rejects.toMatchObject({
      code: "IG_PUBLISH_LIMIT",
      retriable: false,
    });
    expect(ig.containers.size).toBe(0);
  });

  it("si el cupo no responde se sigue y se anota; sin total, también se sigue", async () => {
    const rejected = setup();
    rejected.ig.quotaRejects = true;
    await expect(rejected.publisher.publish(post(1), rejected.context())).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(rejected.notes).toEqual([
      { code: "QUOTA_UNAVAILABLE", errorCode: "IG_REQUEST_REJECTED" },
    ]);

    const noTotal = setup();
    noTotal.ig.quota = { quota_usage: 500 };
    await expect(noTotal.publisher.publish(post(1), noTotal.context())).resolves.toMatchObject({
      externalId: "m-1",
    });
  });
});

describe("createInstagramPublisher · retoma desde el progreso", () => {
  const progress = (containerId: string, startedAt = START) => ({
    attemptStartedAt: new Date(startedAt).toISOString(),
    childIds: [],
    containerId,
  });

  it("contenedor FINISHED: lo publica sin crear otro ni consultar el cupo", async () => {
    const { ig, publisher, context } = setup();
    ig.seed("c-9", ["FINISHED"], { caption: post(1).caption });
    await expect(publisher.publish(post(1), context(progress("c-9")))).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.log).toEqual(["status:c-9", "publish:c-9", "media:m-1"]);
  });

  it("contenedor IN_PROGRESS: espera y publica el mismo", async () => {
    const { ig, sleeps, publisher, context } = setup();
    ig.seed("c-9", ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    await publisher.publish(post(1), context(progress("c-9")));
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(ig.publishCount("c-9")).toBe(1);
    expect(ig.containers.size).toBe(1);
  });

  it("contenedor PUBLISHED: busca el medio (mismo caption, después del intento) sin publicar", async () => {
    const { ig, publisher, context } = setup();
    const input = post(1);
    ig.seed("c-9", ["FINISHED"]);
    ig.containers.set("c-9", { fields: {}, statuses: [], published: 1 });
    ig.seedMedia("m-viejo", input.caption, START - 60 * 60_000);
    ig.seedMedia("m-otro", "Otro texto", START + 1_000);
    ig.seedMedia("m-7", `${input.caption}\n`, START + 30_000);
    await expect(publisher.publish(input, context(progress("c-9")))).resolves.toEqual({
      externalId: "m-7",
      externalUrl: "https://www.instagram.com/p/m-7/",
      simulated: false,
    });
    expect(ig.log).toEqual(["status:c-9", "recent"]);
  });

  it("contenedor PUBLISHED sin medio reconocible: IG_PUBLISH_OUTCOME_UNKNOWN, no reintentable", async () => {
    const { ig, publisher, context } = setup();
    ig.containers.set("c-9", { fields: {}, statuses: [], published: 1 });
    ig.seedMedia("m-viejo", post(1).caption, START - 60 * 60_000);
    await expect(publisher.publish(post(1), context(progress("c-9")))).rejects.toMatchObject({
      code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      retriable: false,
    });
    expect(ig.log).not.toContain("publish:c-9");
  });

  it("contenedor EXPIRED o ERROR: arma contenedores nuevos", async () => {
    for (const status of ["EXPIRED", "ERROR:2207001"]) {
      const { ig, saved, publisher, context } = setup();
      ig.seed("c-90", [status]);
      await expect(publisher.publish(post(1), context(progress("c-90")))).resolves.toMatchObject({
        externalId: "m-1",
      });
      expect(ig.publishCount("c-90")).toBe(0);
      expect(ig.publishCount("c-1")).toBe(1);
      expect(saved).toMatchObject([{ containerId: "c-1" }]);
    }
  });

  it("un progreso sin contenedor o ilegible empieza de cero", async () => {
    for (const saved of [
      { attemptStartedAt: new Date(START).toISOString(), childIds: [], containerId: null },
      { otro: 1 },
    ]) {
      const { ig, publisher, context } = setup();
      await publisher.publish(post(1), context(saved));
      expect(ig.log[0]).toBe("quota");
    }
  });

  it("nunca dos media_publish sobre el mismo contenedor: un corte después de publicar se reconoce", async () => {
    const { ig, saved, publisher, context } = setup();
    const input = post(2);
    ig.publishBehaviors = ["error-after-publish"];
    await expect(publisher.publish(input, context())).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
    });
    // El reintento parte del progreso guardado: el contenedor ya está publicado.
    await expect(publisher.publish(input, context(saved[0]))).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.publishCount("c-3")).toBe(1);
    expect(ig.log.filter((entry) => entry.startsWith("publish:"))).toEqual(["publish:c-3"]);
  });

  it("un media_publish que falló sin publicar se repite solo después de consultar el estado", async () => {
    const { ig, saved, publisher, context } = setup();
    ig.publishBehaviors = ["error"];
    await expect(publisher.publish(post(1), context())).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
    });
    await publisher.publish(post(1), context(saved[0]));
    const firstPublish = ig.log.indexOf("publish:c-1");
    expect(ig.log.slice(firstPublish)).toEqual([
      "publish:c-1",
      "status:c-1",
      "publish:c-1",
      "media:m-1",
    ]);
    expect(ig.publishCount("c-1")).toBe(1);
  });
});

describe("createInstagramPublisher · señal y cliente perezoso", () => {
  it("la señal corta la espera (IG_ABORTED, reintentable) con el progreso guardado", async () => {
    const controller = new AbortController();
    const clockless = fakeInstagram({ now: START });
    clockless.statusesFor = () => ["IN_PROGRESS"];
    const saved: unknown[] = [];
    const publisher = createInstagramPublisher({
      poll: { firstDelaysMs: [], intervalMs: 60_000, maxWaitMs: 5 * 60_000 },
    });
    const pending = publisher.publish(reelInput, {
      account,
      credentials: { accessToken: TOKEN },
      progress: null,
      async saveProgress(value) {
        saved.push(value);
        controller.abort();
      },
      signal: controller.signal,
    });
    await expect(pending).rejects.toMatchObject({ code: "IG_ABORTED", retriable: true });
    expect(saved).toHaveLength(1);
    expect(clockless.publishCount("c-1")).toBe(0);
  });

  it("con la señal ya disparada no llama a Instagram", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ig, publisher, context } = setup({ signal: controller.signal });
    await expect(publisher.publish(post(1), context())).rejects.toMatchObject({
      code: "IG_ABORTED",
    });
    expect(ig.log).toEqual([]);
  });

  it("validar y simular no construyen el cliente; publicar lo construye una sola vez", async () => {
    const factory = vi.fn(() => createInstagramGraph());
    const publisher = createInstagramPublisher({ graph: factory, sleep: async () => {} });
    expect(publisher.validate(post(1))).toEqual({ ok: true });
    await withDryRun(publisher).publish(post(1), {
      account,
      credentials: { accessToken: TOKEN },
      progress: null,
      saveProgress: async () => {},
    });
    expect(factory).not.toHaveBeenCalled();

    fakeInstagram({ now: START });
    const ctx: PublishContext = {
      account,
      credentials: { accessToken: TOKEN },
      progress: null,
      saveProgress: async () => {},
    };
    await publisher.publish(post(1), ctx);
    await publisher.publish(post(1), ctx);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("abortableSleep", () => {
  it("espera y, con la señal, corta al instante sin dejar el listener", async () => {
    await expect(abortableSleep(5)).resolves.toBeUndefined();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await abortableSleep(5, controller.signal);
    expect(removed).toHaveBeenCalledTimes(1);
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "IG_ABORTED" });
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(abortableSleep(5, controller.signal)).rejects.toEqual(INSTAGRAM_ERRORS.aborted());
  });
});
