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
  type InstagramPublisherOptions,
  type InstagramPublishNote,
} from "./publisher.js";

const BASE = "https://graph.instagram.com/v25.0";
const IG = "17841400000000001";
const TOKEN = "IGAA-token-de-prueba";
const START = Date.parse("2026-10-05T12:00:00Z");
const MIN = 60_000;

const { server, requests } = useInstagramServer();

/**
 * Qué hace `media_publish`: publicar (`ok`), publicar y cortar la respuesta (`*-after-publish`),
 * fallar sin publicar (`error`) o decir que el medio aún no está listo (`not-ready`).
 */
type PublishBehavior =
  | "ok"
  | "error-after-publish"
  | "garbage-after-publish"
  | "error"
  | "not-ready";

type FakeMedia = {
  id: string;
  caption: string;
  timestamp: string;
  permalink: string;
  media_type: string;
  media_product_type: string;
};

/** El tipo de medio que deja un contenedor al publicarse (nota §4.6). */
const mediaTypeOf = (fields: Record<string, string>) =>
  fields.media_type === "REELS"
    ? { media_type: "VIDEO", media_product_type: "REELS" }
    : fields.media_type === "CAROUSEL"
      ? { media_type: "CAROUSEL_ALBUM", media_product_type: "FEED" }
      : { media_type: "IMAGE", media_product_type: "FEED" };

/**
 * Instagram simulado con estado: recuerda los contenedores (con un guion de estados por consulta),
 * las publicaciones y el orden de lo que pasó (`log`), para afirmar que nada se publica dos veces.
 */
function fakeInstagram(clock: { now: number }) {
  let nextContainer = 0;
  let nextMedia = 0;
  const containers = new Map<
    string,
    { fields: Record<string, string>; statuses: string[]; published: number }
  >();
  const media: FakeMedia[] = [];
  const log: string[] = [];
  const state = {
    containers,
    media,
    log,
    /** Estados que devuelve cada contenedor nuevo, en orden (el último se repite). */
    statusesFor: (_fields: Record<string, string>): string[] => ["FINISHED"],
    publishBehaviors: [] as PublishBehavior[],
    quota: { quota_usage: 0, config: { quota_total: 100 } } as unknown,
    quotaError: null as null | { code: number; status: number },
    mediaFails: false,
    /** Registra un contenedor de un intento anterior. */
    seed(id: string, statuses: string[], fields: Record<string, string> = {}, published = 0) {
      containers.set(id, { fields, statuses, published });
    },
    /** Un medio ya publicado en la cuenta (el más nuevo queda primero en la lista). */
    seedMedia(id: string, caption: string, timestamp: number, fields: Record<string, string> = {}) {
      media.unshift({
        id,
        caption,
        timestamp: new Date(timestamp).toISOString(),
        permalink: `https://www.instagram.com/p/${id}/`,
        ...mediaTypeOf(fields),
      });
    },
    publishCount: (id: string) => containers.get(id)?.published ?? 0,
    publishes: () => log.filter((entry) => entry.startsWith("publish:")),
  };

  const publishMedia = (containerId: string) => {
    const container = containers.get(containerId);
    if (container === undefined) throw new Error(`sin contenedor ${containerId}`);
    container.published += 1;
    const id = `m-${++nextMedia}`;
    state.seedMedia(id, container.fields.caption ?? "", clock.now, container.fields);
    return id;
  };

  server.use(
    http.get(`${BASE}/${IG}/content_publishing_limit`, () => {
      log.push("quota");
      return state.quotaError === null
        ? HttpResponse.json({ data: [state.quota] })
        : HttpResponse.json(
            { error: { code: state.quotaError.code } },
            { status: state.quotaError.status },
          );
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
      return HttpResponse.json({ data: media });
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
      if (behavior === "error-after-publish") return new HttpResponse("se cortó", { status: 502 });
      if (behavior === "garbage-after-publish") return HttpResponse.json({ otro: true });
      return HttpResponse.json({ id });
    }),
    http.get(`${BASE}/:id`, ({ params }) => {
      const id = String(params.id);
      const container = containers.get(id);
      if (container !== undefined) {
        log.push(`status:${id}`);
        const next =
          container.published > 0
            ? "PUBLISHED"
            : container.statuses.length > 1
              ? (container.statuses.shift() ?? "FINISHED")
              : (container.statuses[0] ?? "FINISHED");
        const [code, subcode] = next.split(":");
        return HttpResponse.json({
          status_code: code,
          status: subcode === undefined ? code : `Error: ${subcode}`,
        });
      }
      const item = media.find((candidate) => candidate.id === id);
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

const CAPTION = "Depto luminoso en Ñuñoa\n\n#nunoa";

const post = (count: number, caption = CAPTION): PublishInput => ({
  publicationId: "pub-1",
  platform: "instagram",
  format: "post",
  title: null,
  caption,
  media: Array.from({ length: count }, (_, i) => photo(i + 1)),
});

const reelInput: PublishInput = {
  ...post(0),
  publicationId: "pub-2",
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
function setup(
  options: { signal?: AbortSignalLike; publisher?: Partial<InstagramPublisherOptions> } = {},
) {
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
    ...options.publisher,
  });
  const context = (progress: unknown = null): PublishContext => ({
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

const iso = (ms: number) => new Date(ms).toISOString();

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
    const progress = {
      attemptStartedAt: iso(START),
      childIds: ["c-1", "c-2", "c-3"],
      containerId: "c-4",
    };
    expect(saved).toEqual([progress, { ...progress, publishRequestedAt: iso(START) }]);
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
      "save",
      "publish:c-4",
      "media:m-1",
    ]);
  });

  it("imagen suelta: un contenedor con image_url y caption, sin hijos", async () => {
    const { ig, saved, publisher, context } = setup();
    await publisher.publish(post(1), context());
    expect(ig.containers.get("c-1")?.fields).toEqual({ image_url: photo(1).url, caption: CAPTION });
    expect(saved).toMatchObject([{ childIds: [], containerId: "c-1" }, { containerId: "c-1" }]);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("reel: REELS con thumb_offset y share_to_feed, sondeo IN_PROGRESS → FINISHED a los 5 y 10 s", async () => {
    const { ig, sleeps, publisher, context } = setup();
    ig.statusesFor = () => ["IN_PROGRESS", "UNKNOWN", "FINISHED"];
    await expect(publisher.publish(reelInput, context())).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.containers.get("c-1")?.fields).toEqual({
      media_type: "REELS",
      video_url: reelInput.media[0]?.url,
      caption: CAPTION,
      thumb_offset: "1000",
      share_to_feed: "true",
    });
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it("sondeo agotado: la última consulta es a los 5 min justos y luego IG_CONTAINER_TIMEOUT", async () => {
    const { ig, sleeps, saved, publisher, context } = setup();
    ig.statusesFor = () => ["IN_PROGRESS"];
    await expect(publisher.publish(reelInput, context())).rejects.toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
      retriable: true,
    });
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 30_000, MIN, MIN, MIN, 55_000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5 * MIN);
    expect(ig.log.filter((entry) => entry === "status:c-1")).toHaveLength(9);
    expect(saved).toHaveLength(1);
    expect(ig.publishCount("c-1")).toBe(0);
  });

  it("un reel que termina en la última consulta se publica", async () => {
    const { ig, publisher, context } = setup();
    ig.statusesFor = () => [...Array<string>(8).fill("IN_PROGRESS"), "FINISHED"];
    await expect(publisher.publish(reelInput, context())).resolves.toMatchObject({
      externalId: "m-1",
    });
  });

  it("un contenedor en ERROR o EXPIRED durante el sondeo se clasifica", async () => {
    for (const [status, code, retriable] of [
      ["ERROR:2207026", "IG_MEDIA_REJECTED", false],
      ["ERROR", "IG_UNAVAILABLE", true],
      ["EXPIRED", "IG_UNAVAILABLE", true],
    ] as const) {
      const { ig, publisher, context } = setup();
      ig.statusesFor = () => ["IN_PROGRESS", status];
      await expect(publisher.publish(reelInput, context())).rejects.toMatchObject({
        code,
        retriable,
      });
    }
  });

  it("un hijo del carrusel en ERROR corta antes de crear el carrusel", async () => {
    const { ig, saved, publisher, context } = setup();
    ig.statusesFor = (fields) =>
      fields.image_url === photo(2).url ? ["ERROR:2207009"] : ["FINISHED"];
    await expect(publisher.publish(post(3), context())).rejects.toMatchObject({
      code: "IG_MEDIA_REJECTED",
    });
    expect(ig.containers.size).toBe(3);
    expect(saved).toEqual([]);
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

  it("si media_publish nunca está listo, para a los 3 pedidos con IG_CONTAINER_TIMEOUT", async () => {
    const { ig, publisher, context } = setup();
    ig.publishBehaviors = ["not-ready", "not-ready", "not-ready", "not-ready"];
    await expect(publisher.publish(post(1), context())).rejects.toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
      retriable: true,
    });
    expect(ig.publishes()).toHaveLength(3);
  });

  it("si al esperar tras 'no listo' el contenedor ya salió, busca el medio sin volver a publicar", async () => {
    const { ig, publisher, context } = setup();
    ig.publishBehaviors = ["not-ready"];
    ig.statusesFor = () => ["FINISHED"];
    // Mientras se espera, otro intento lo publicó.
    const original = ig.containers.get.bind(ig.containers);
    let polls = 0;
    vi.spyOn(ig.containers, "get").mockImplementation((id) => {
      const container = original(id);
      if (container !== undefined && ig.publishes().length === 1 && ++polls === 1) {
        container.published = 1;
        ig.seedMedia("m-otro", CAPTION, START, { caption: CAPTION });
      }
      return container;
    });
    await expect(publisher.publish(post(1), context())).resolves.toMatchObject({
      externalId: "m-otro",
    });
    expect(ig.publishes()).toEqual(["publish:c-1"]);
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

  it("un input que no pasa la revisión es PUBLISH_INPUT_INVALID sin llamar a Instagram", async () => {
    const { ig, publisher, context } = setup();
    for (const input of [post(0), { ...reelInput, media: [] }, post(11)]) {
      await expect(publisher.publish(input, context())).rejects.toMatchObject({
        code: "PUBLISH_INPUT_INVALID",
        retriable: false,
      });
    }
    expect(ig.log).toEqual([]);
  });

  it("todo el intento tiene un tope: un carrusel lento no pasa los 12 min", async () => {
    const { ig, sleeps, publisher, context } = setup({ publisher: { attemptMaxMs: 7 * MIN } });
    ig.statusesFor = (fields) =>
      fields.media_type === "CAROUSEL"
        ? ["IN_PROGRESS"]
        : [...Array<string>(8).fill("IN_PROGRESS"), "FINISHED"];
    await expect(publisher.publish(post(2), context())).rejects.toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
    });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(7 * MIN);
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

  it("si el cupo no responde (rechazo o permiso) se sigue y se anota con el publicationId", async () => {
    for (const [error, errorCode] of [
      [{ code: 100, status: 400 }, "IG_REQUEST_REJECTED"],
      [{ code: 10, status: 403 }, "IG_PERMISSION_DENIED"],
    ] as const) {
      const { ig, notes, publisher, context } = setup();
      ig.quotaError = error;
      await expect(publisher.publish(post(1), context())).resolves.toMatchObject({
        externalId: "m-1",
      });
      expect(notes).toEqual([{ publicationId: "pub-1", code: "QUOTA_UNAVAILABLE", errorCode }]);
    }
  });

  it("sin total se sigue y se anota; un token vencido corta", async () => {
    const noTotal = setup();
    noTotal.ig.quota = { quota_usage: 500 };
    await expect(noTotal.publisher.publish(post(1), noTotal.context())).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(noTotal.notes).toEqual([{ publicationId: "pub-1", code: "QUOTA_TOTAL_UNKNOWN" }]);

    const expired = setup();
    expired.ig.quotaError = { code: 190, status: 400 };
    await expect(expired.publisher.publish(post(1), expired.context())).rejects.toMatchObject({
      code: "IG_AUTH_INVALID",
    });
    expect(expired.ig.containers.size).toBe(0);
  });
});

describe("createInstagramPublisher · retoma desde el progreso", () => {
  const progress = (containerId: string, extra: Record<string, unknown> = {}) => ({
    attemptStartedAt: iso(START),
    childIds: [],
    containerId,
    ...extra,
  });

  it("contenedor FINISHED: lo publica sin crear otro ni consultar el cupo", async () => {
    const { ig, publisher, context } = setup();
    ig.seed("c-9", ["FINISHED"], { caption: CAPTION });
    await expect(publisher.publish(post(1), context(progress("c-9")))).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.log).toEqual(["status:c-9", "save", "publish:c-9", "media:m-1"]);
  });

  it("contenedor IN_PROGRESS dentro de sus 5 min: espera (sin consultar dos veces seguidas) y publica el mismo", async () => {
    const { ig, sleeps, clock, publisher, context } = setup();
    clock.now = START + MIN;
    ig.seed("c-9", ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    await publisher.publish(post(1), context(progress("c-9")));
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(ig.publishCount("c-9")).toBe(1);
    expect(ig.containers.size).toBe(1);
  });

  it("contenedor IN_PROGRESS que ya gastó sus 5 min: se abandona y se arman nuevos", async () => {
    const { ig, clock, publisher, context } = setup();
    clock.now = START + 5 * MIN;
    ig.seed("c-90", ["IN_PROGRESS"]);
    await expect(publisher.publish(post(1), context(progress("c-90")))).resolves.toMatchObject({
      externalId: "m-1",
    });
    expect(ig.publishCount("c-90")).toBe(0);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("contenedor IN_PROGRESS que no termina en lo que le queda: IG_CONTAINER_TIMEOUT y el siguiente intento rehace", async () => {
    const { ig, sleeps, clock, publisher, context } = setup();
    clock.now = START + 4 * MIN;
    ig.seed("c-90", ["UNKNOWN"]);
    await expect(publisher.publish(post(1), context(progress("c-90")))).rejects.toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
    });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(MIN);
    await publisher.publish(post(1), context(progress("c-90")));
    expect(ig.publishCount("c-90")).toBe(0);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("contenedor PUBLISHED: busca el medio del mismo formato y caption, después del intento, sin publicar", async () => {
    const { ig, publisher, context } = setup();
    ig.seed("c-9", [], {}, 1);
    ig.seedMedia("m-viejo", CAPTION, START - 60 * MIN);
    ig.seedMedia("m-otro", "Otro texto", START + 1_000);
    ig.seedMedia("m-7", `${CAPTION.replace("\n\n", "\r\n\r\n")}  \n`, START + 30_000);
    await expect(publisher.publish(post(1), context(progress("c-9")))).resolves.toEqual({
      externalId: "m-7",
      externalUrl: "https://www.instagram.com/p/m-7/",
      simulated: false,
    });
    expect(ig.log).toEqual(["status:c-9", "recent"]);
    const recent = requests.find((request) => request.url.pathname.endsWith(`/${IG}/media`));
    expect(recent?.url.searchParams.get("limit")).toBe("10");
  });

  it("el carrusel y el reel del mismo caption no se confunden", async () => {
    for (const [input, expected] of [
      [reelInput, "m-reel"],
      [post(2), "m-carrusel"],
    ] as const) {
      const { ig, publisher, context } = setup();
      ig.seed("c-9", [], {}, 1);
      ig.seedMedia("m-reel", CAPTION, START + 10_000, { media_type: "REELS" });
      ig.seedMedia("m-carrusel", CAPTION, START + 20_000, { media_type: "CAROUSEL" });
      await expect(publisher.publish(input, context(progress("c-9")))).resolves.toMatchObject({
        externalId: expected,
      });
    }
  });

  it("el margen del reloj es de 2 min antes del intento", async () => {
    for (const [offset, found] of [
      [-2 * MIN, true],
      [-2 * MIN - 1_000, false],
    ] as const) {
      const { ig, publisher, context } = setup();
      ig.seed("c-9", [], {}, 1);
      ig.seedMedia("m-1", CAPTION, START + offset);
      const result = publisher.publish(post(1), context(progress("c-9")));
      if (found) await expect(result).resolves.toMatchObject({ externalId: "m-1" });
      else await expect(result).rejects.toMatchObject({ code: "IG_PUBLISH_OUTCOME_UNKNOWN" });
    }
  });

  it("contenedor PUBLISHED sin medio reconocible: IG_PUBLISH_OUTCOME_UNKNOWN, no reintentable, que dice qué hacer", async () => {
    const { ig, publisher, context } = setup();
    ig.seed("c-9", [], {}, 1);
    ig.seedMedia("m-viejo", CAPTION, START - 60 * MIN);
    await expect(publisher.publish(post(1), context(progress("c-9")))).rejects.toMatchObject({
      code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      retriable: false,
      message: expect.stringContaining("descártala"),
    });
    expect(ig.publishes()).toEqual([]);
  });

  it("contenedor EXPIRED o ERROR: arma contenedores nuevos", async () => {
    for (const status of ["EXPIRED", "ERROR:2207001"]) {
      const { ig, saved, publisher, context } = setup();
      ig.seed("c-90", [status]);
      await expect(publisher.publish(post(1), context(progress("c-90")))).resolves.toMatchObject({
        externalId: "m-1",
      });
      expect(ig.publishCount("c-90")).toBe(0);
      expect(saved).toMatchObject([{ containerId: "c-1" }, { containerId: "c-1" }]);
    }
  });

  it("un progreso sin contenedor empieza de cero; uno ilegible no adivina", async () => {
    const empty = setup();
    await empty.publisher.publish(
      post(1),
      empty.context({ attemptStartedAt: iso(START), childIds: [], containerId: null }),
    );
    expect(empty.ig.log[0]).toBe("quota");

    const unreadable = setup();
    await expect(
      unreadable.publisher.publish(post(1), unreadable.context({ otro: 1 })),
    ).rejects.toMatchObject({ code: "IG_PUBLISH_OUTCOME_UNKNOWN" });
    expect(unreadable.ig.log).toEqual([]);
  });

  it("nunca dos media_publish sobre el mismo contenedor: un corte después de publicar se reconoce", async () => {
    for (const [behavior, code] of [
      ["error-after-publish", "IG_UNAVAILABLE"],
      ["garbage-after-publish", "IG_UNEXPECTED_RESPONSE"],
    ] as const) {
      const { ig, saved, publisher, context } = setup();
      ig.publishBehaviors = [behavior];
      await expect(publisher.publish(post(2), context())).rejects.toMatchObject({ code });
      // El reintento parte del último progreso guardado: el contenedor ya está publicado.
      await expect(publisher.publish(post(2), context(saved.at(-1)))).resolves.toMatchObject({
        externalId: "m-1",
      });
      expect(ig.publishes()).toEqual(["publish:c-3"]);
    }
  });

  it("un media_publish sin respuesta y sin medio: espera, vuelve a mirar y lo pide una sola vez más", async () => {
    const { ig, sleeps, saved, publisher, context } = setup();
    ig.publishBehaviors = ["error"];
    await expect(publisher.publish(post(1), context())).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
    });
    const last = saved.at(-1);
    expect(last).toMatchObject({ publishRequestedAt: iso(START) });
    await publisher.publish(post(1), context(last));
    expect(sleeps).toEqual([MIN]);
    const retry = ig.log.slice(ig.log.indexOf("publish:c-1") + 1);
    expect(retry).toEqual([
      "status:c-1",
      "status:c-1",
      "recent",
      "save",
      "publish:c-1",
      "media:m-1",
    ]);
    expect(ig.publishCount("c-1")).toBe(1);
  });

  it("un media_publish sin respuesta que sí salió: lo reconoce al esperar, sin pedirlo otra vez", async () => {
    const { ig, clock, saved, publisher, context } = setup();
    ig.publishBehaviors = ["error"];
    await expect(publisher.publish(post(1), context())).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
    });
    // Instagram lo terminó de publicar poco después, sin que el contenedor lo muestre aún.
    ig.seedMedia("m-tarde", CAPTION, START + 20_000);
    clock.now = START + 2 * MIN;
    await expect(publisher.publish(post(1), context(saved.at(-1)))).resolves.toMatchObject({
      externalId: "m-tarde",
    });
    expect(ig.publishes()).toEqual(["publish:c-1"]);
  });
});

describe("createInstagramPublisher · señal y cliente perezoso", () => {
  it("la señal corta la espera del sondeo (IG_ABORTED, reintentable) con el progreso guardado", async () => {
    const controller = new AbortController();
    const { ig, saved, publisher, context } = setup({
      signal: controller.signal,
      publisher: {
        sleep: (ms, signal) => {
          controller.abort();
          return abortableSleep(ms, signal);
        },
      },
    });
    ig.statusesFor = () => ["IN_PROGRESS"];
    await expect(publisher.publish(reelInput, context())).rejects.toMatchObject({
      code: "IG_ABORTED",
      retriable: true,
    });
    expect(saved).toHaveLength(1);
    expect(ig.publishes()).toEqual([]);
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
    const ctx: PublishContext = {
      account,
      credentials: { accessToken: TOKEN },
      progress: null,
      saveProgress: async () => {},
    };
    expect(publisher.validate(post(1))).toEqual({ ok: true });
    await withDryRun(publisher).publish(post(1), ctx);
    expect(factory).not.toHaveBeenCalled();

    fakeInstagram({ now: START });
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
