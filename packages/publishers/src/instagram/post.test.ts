import {
  isAppError,
  type Platform,
  type Publication,
  type Publisher,
  publishListing,
  publishPublication,
} from "@agentsales/core";
import {
  createPostPublicationScenario,
  createPublicationScenario,
  POST_SCENARIO_TOKEN,
  type PostPublicationScenario,
} from "@agentsales/core/testing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createInstagramPublisher } from "./publisher.js";

// F9-T13: contratos de Instagram para los posts de una marca, de punta a punta (el intento de core
// con el publisher real contra la Graph API simulada con msw): imagen suelta, carrusel y reel; el
// texto de cada idioma; la cuota de la cuenta compartida con los avisos; un medio que Instagram no
// pudo descargar; y un corte después de crear el contenedor, sin publicar dos veces. Ninguna
// llamada sale a Meta (`onUnhandledFrame: "error"`). La prueba real (S1) es del operador.

const BASE = "https://graph.instagram.com/v25.0";
/** La cuenta de Instagram del escenario de avisos: la misma para posts y avisos. */
const SHARED_IG = "17841400000000001";
/** Otra cuenta de Instagram (por ejemplo, la de AgentPey): su cuota es aparte. */
const OTHER_IG = "17841400000000002";
const NOW = Date.parse("2026-10-20T15:00:00Z");
const SIX_HOURS = 6 * 60 * 60_000;

const { server } = usePlatformServer();

/** Lo que `media_publish` hace en cada llamada: publicar, publicar y cortar, o fallar sin publicar. */
type PublishBehavior = "ok" | "error-after-publish" | "error";

type FakeContainer = {
  igUserId: string;
  fields: Record<string, string>;
  status: string;
  published: number;
};

/**
 * Instagram simulado con estado: contenedores, publicaciones y la cuota **por cuenta de
 * Instagram** (`quota_usage` cuenta los `media_publish` de esa cuenta, como la nota §6). `log`
 * guarda el orden de lo que pasó.
 */
function fakeInstagram(clock: { now: number }) {
  let nextContainer = 0;
  let nextMedia = 0;
  const containers = new Map<string, FakeContainer>();
  const media = new Map<
    string,
    { igUserId: string; caption: string; timestamp: string; media_type: string; product: string }
  >();
  const log: string[] = [];
  const state = {
    containers,
    log,
    quotaTotal: 100,
    usage: new Map<string, number>(),
    /** El estado de cada contenedor nuevo, según sus campos (por defecto `FINISHED`). */
    statusFor: (_fields: Record<string, string>, _id: string): string => "FINISHED",
    publishBehaviors: [] as PublishBehavior[],
    publishes: () => log.filter((entry) => entry.startsWith("publish:")),
    created: () => [...containers.entries()].map(([id, container]) => ({ id, ...container })),
  };

  const publish = (containerId: string) => {
    const container = containers.get(containerId);
    if (container === undefined) throw new Error(`sin contenedor ${containerId}`);
    container.published += 1;
    state.usage.set(container.igUserId, (state.usage.get(container.igUserId) ?? 0) + 1);
    const id = `m-${++nextMedia}`;
    const reel = container.fields.media_type === "REELS";
    media.set(id, {
      igUserId: container.igUserId,
      caption: container.fields.caption ?? "",
      timestamp: new Date(clock.now).toISOString(),
      media_type: reel
        ? "VIDEO"
        : container.fields.media_type === "CAROUSEL"
          ? "CAROUSEL_ALBUM"
          : "IMAGE",
      product: reel ? "REELS" : "FEED",
    });
    return id;
  };
  const mediaView = (id: string) => {
    const item = media.get(id);
    return {
      id,
      caption: item?.caption,
      timestamp: item?.timestamp,
      permalink: `https://www.instagram.com/p/${id}/`,
      media_type: item?.media_type,
      media_product_type: item?.product,
    };
  };

  server.use(
    http.get(`${BASE}/:ig/content_publishing_limit`, ({ params }) => {
      const ig = String(params.ig);
      log.push(`quota:${ig}`);
      return HttpResponse.json({
        data: [
          { quota_usage: state.usage.get(ig) ?? 0, config: { quota_total: state.quotaTotal } },
        ],
      });
    }),
    http.post(`${BASE}/:ig/media`, async ({ params, request }) => {
      const fields = Object.fromEntries(new URLSearchParams(await request.text()));
      const id = `c-${++nextContainer}`;
      containers.set(id, {
        igUserId: String(params.ig),
        fields,
        status: state.statusFor(fields, id),
        published: 0,
      });
      log.push(`create:${id}`);
      return HttpResponse.json({ id });
    }),
    http.get(`${BASE}/:ig/media`, ({ params }) => {
      const ig = String(params.ig);
      log.push(`recent:${ig}`);
      const recent = [...media.entries()]
        .filter(([, item]) => item.igUserId === ig)
        .map(([id]) => mediaView(id))
        .reverse();
      return HttpResponse.json({ data: recent });
    }),
    http.post(`${BASE}/:ig/media_publish`, async ({ request }) => {
      const containerId = new URLSearchParams(await request.text()).get("creation_id") ?? "";
      log.push(`publish:${containerId}`);
      const behavior = state.publishBehaviors.shift() ?? "ok";
      if (behavior === "error") return new HttpResponse("caído", { status: 500 });
      const id = publish(containerId);
      if (behavior === "error-after-publish") return new HttpResponse("se cortó", { status: 502 });
      return HttpResponse.json({ id });
    }),
    http.get(`${BASE}/:id`, ({ params }) => {
      const id = String(params.id);
      const container = containers.get(id);
      if (container !== undefined) {
        log.push(`status:${id}`);
        const [code, subcode] = (container.published > 0 ? "PUBLISHED" : container.status).split(
          ":",
        );
        return HttpResponse.json({
          status_code: code,
          status: subcode === undefined ? code : `Error: ${subcode}`,
        });
      }
      if (media.has(id)) return HttpResponse.json(mediaView(id));
      return HttpResponse.json({ error: { code: 100 } }, { status: 400 });
    }),
  );
  return state;
}

/** El publisher real con un reloj falso: `sleep` lo avanza al instante. */
function instagramPublisher(clock: { now: number }) {
  return createInstagramPublisher({
    now: () => new Date(clock.now),
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
}

/** Un post de la marca con su cuenta de Instagram y el publisher real contra el Instagram falso. */
async function setup(
  options: Parameters<typeof createPostPublicationScenario>[0] & { ig?: string } = {},
) {
  const clock = { now: NOW };
  const ig = fakeInstagram(clock);
  const { ig: igUserId = SHARED_IG, ...scenario } = options;
  const t = await createPostPublicationScenario({
    texts: [{ platform: "instagram", language: "es" }],
    accounts: [{ platform: "instagram", externalAccountId: igUserId }],
    ...scenario,
  });
  const publisher = instagramPublisher(clock);
  return { clock, ig, t, publisher, ...runner(t, publisher, clock) };
}

/** Un intento de core (el handler del job) sobre una publicación del post. */
function runner(t: PostPublicationScenario, publisher: Publisher, clock: { now: number }) {
  const deps = t.publishDeps(
    { instagram: publisher } satisfies Partial<Record<Platform, Publisher>>,
    { now: () => new Date(clock.now) },
  );
  const attempt = (publication: Publication, retryCount = 0) =>
    publishPublication(deps, { publicationId: publication.id, isLastAttempt: false, retryCount });
  const start = (language: "es" | "en" = "es") =>
    t.toPublishing(t.publicationOf("instagram", language));
  return { attempt, start };
}

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const signed = (path: string) => `memory://${path}?ttl=3600`;
const CAPTION_ES = "Texto en es para instagram\n\n#agentpey #ia";
const CAPTION_EN = "Texto en en para instagram\n\n#agentpey #ia";

describe("Instagram para posts · los tres formatos (F9-T13)", () => {
  it("imagen suelta: un contenedor con el ig_4x5 de la primera foto y el caption con los hashtags", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "image", images: 2 });
    const publication = await start();
    expect(publication).toMatchObject({ format: "post", mediaIds: [t.images[0]?.id] });

    await expect(attempt(publication)).resolves.toMatchObject({ outcome: "published" });

    expect(ig.created()).toEqual([
      expect.objectContaining({
        id: "c-1",
        igUserId: SHARED_IG,
        fields: { image_url: signed(`posts/${t.post.id}/ig_4x5/foto.jpg`), caption: CAPTION_ES },
      }),
    ]);
    expect(ig.publishes()).toEqual(["publish:c-1"]);
    expect(t.current(publication.id)).toMatchObject({
      status: "published",
      externalId: "m-1",
      externalUrl: "https://www.instagram.com/p/m-1/",
      dryRun: false,
    });
  });

  it("carrusel de 3: hijos con los ig_4x5 en su orden y el carrusel con el caption", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "carousel", images: 3 });
    const publication = await start();
    expect(publication.mediaIds).toEqual(t.images.map((item) => item.id));

    await expect(attempt(publication)).resolves.toMatchObject({ outcome: "published" });

    const paths = ["foto", "foto-2", "foto-3"].map((name) =>
      signed(`posts/${t.post.id}/ig_4x5/${name}.jpg`),
    );
    expect(ig.created().map((container) => container.fields)).toEqual([
      ...paths.map((url) => ({ image_url: url, is_carousel_item: "true" })),
      { media_type: "CAROUSEL", children: "c-1,c-2,c-3", caption: CAPTION_ES },
    ]);
    expect(ig.publishes()).toEqual(["publish:c-4"]);
    expect(t.current(publication.id)?.status).toBe("published");
  });

  it("reel: el ig_reel del video, con la portada del segundo 1 y compartido en el feed", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "video", images: 0, video: true });
    const publication = await start();
    expect(publication).toMatchObject({ format: "reel", mediaIds: [t.reel?.id] });

    await expect(attempt(publication)).resolves.toMatchObject({ outcome: "published" });

    expect(ig.created().map((container) => container.fields)).toEqual([
      {
        media_type: "REELS",
        video_url: signed(`posts/${t.post.id}/ig_reel/video.mp4`),
        caption: CAPTION_ES,
        thumb_offset: "1000",
        share_to_feed: "true",
      },
    ]);
    expect(ig.publishes()).toEqual(["publish:c-1"]);
  });

  it("una marca con dos idiomas: dos publicaciones de la misma cuenta, cada una con su texto", async () => {
    const { ig, t, attempt, start } = await setup({
      kind: "image",
      texts: [
        { platform: "instagram", language: "es" },
        { platform: "instagram", language: "en" },
      ],
    });
    const es = await start("es");
    const en = await start("en");
    expect(es.platformAccountId).toBe(en.platformAccountId);

    await attempt(es);
    await attempt(en);

    expect(ig.created().map((container) => container.fields.caption)).toEqual([
      CAPTION_ES,
      CAPTION_EN,
    ]);
    expect(ig.publishes()).toEqual(["publish:c-1", "publish:c-2"]);
    expect([t.current(es.id)?.status, t.current(en.id)?.status]).toEqual([
      "published",
      "published",
    ]);
  });

  it("un post de solo texto no llega a Instagram: el publisher tampoco lo acepta", async () => {
    // La revisión del texto (F9-T11) lo frena al aprobar (`MEDIA_REQUIREMENT`, en
    // `post-content.test.ts`) y el plan no abre la publicación; el publisher, por si algo se lo salta.
    const { ig, t, publisher } = await setup({ kind: "text", images: 0, texts: [] });
    const error = await caught(
      publisher.publish(
        {
          publicationId: "pub-texto",
          platform: "instagram",
          format: "post",
          title: null,
          caption: CAPTION_ES,
          media: [],
        },
        {
          account: (await t.platformAccounts.listByBroker(t.broker.id, "instagram"))[0] ?? never(),
          credentials: { accessToken: POST_SCENARIO_TOKEN },
          progress: null,
          saveProgress: async () => {},
        },
      ),
    );
    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "PUBLISH_INPUT_INVALID",
      false,
    ]);
    expect(ig.log).toEqual([]);
  });
});

describe("Instagram para posts · cuota compartida con los avisos (F9-T13)", () => {
  it("los avisos gastan la cuota de la cuenta y el post se reprograma como uno de un aviso", async () => {
    const { clock, ig, t, attempt, start } = await setup({ kind: "image" });
    ig.quotaTotal = 2;

    // Un aviso del corredor sale por la misma cuenta de Instagram: carrusel y reel.
    const listing = await createPublicationScenario();
    const { started } = await publishListing(listing.deps, {
      listingId: listing.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const listingDeps = {
      publications: listing.publications,
      platformAccounts: listing.platformAccounts,
      contents: listing.contents,
      media: listing.media,
      listings: listing.listings,
      brokers: listing.brokers,
      storage: listing.storage,
      publishers: { instagram: instagramPublisher(clock) },
      workerMode: "live" as const,
      marketplaceAutomation: true,
      mercadoLibre: null,
      now: () => new Date(clock.now),
    };
    for (const publication of started) {
      await expect(
        publishPublication(listingDeps, { publicationId: publication.id, isLastAttempt: false }),
      ).resolves.toMatchObject({ outcome: "published" });
    }
    expect(ig.usage.get(SHARED_IG)).toBe(2);

    // El post de la misma cuenta ya no tiene cupo: se reprograma (6 h), sin crear contenedores.
    const containersBefore = ig.containers.size;
    const publication = await start();
    const result = await attempt(publication);

    expect(result).toMatchObject({ outcome: "rescheduled" });
    expect(t.current(publication.id)).toMatchObject({
      status: "scheduled",
      dryRun: false,
      scheduledAt: new Date(clock.now + SIX_HOURS),
      lastError: { code: "IG_PUBLISH_LIMIT", retriable: false },
    });
    expect(ig.containers.size).toBe(containersBefore);
    const events = await t.publications.listEvents(publication.id);
    expect(events.find((event) => event.toStatus === "scheduled")).toMatchObject({
      fromStatus: "publishing",
      actor: "system",
      payload: { reason: "rate_limit" },
    });
    expect(
      events.filter((event) => event.type === "publish_attempt").at(-1)?.payload,
    ).toMatchObject({ result: "rescheduled", error: { code: "IG_PUBLISH_LIMIT" } });
  });

  it("tras 3 esperas seguidas por cuota (MAX_LIMIT_WAITS), la cuarta deja el post en failed, como un aviso", async () => {
    const { clock, ig, t, attempt, start } = await setup({ kind: "image" });
    ig.quotaTotal = 1;
    ig.usage.set(SHARED_IG, 1);
    const publication = await start();
    /** El disparo de cada minuto (T07) retoma la programada: `scheduled` → `publishing`. */
    const resume = () =>
      t.publications.transition(
        publication.id,
        {
          from: "scheduled",
          to: "publishing",
          changes: { dryRun: false, incrementAttempts: true },
        },
        { actor: "system" },
      );

    for (let wait = 1; wait <= 3; wait += 1) {
      await expect(attempt(publication)).resolves.toMatchObject({ outcome: "rescheduled" });
      expect(t.current(publication.id)?.status).toBe("scheduled");
      clock.now += SIX_HOURS;
      await resume();
    }
    const fourth = await caught(attempt(publication));

    expect(isAppError(fourth) && [fourth.code, fourth.retriable]).toEqual([
      "IG_PUBLISH_LIMIT",
      false,
    ]);
    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      lastError: { code: "IG_PUBLISH_LIMIT" },
    });
    const results = (await t.publications.listEvents(publication.id))
      .filter((event) => event.type === "publish_attempt")
      .map((event) => (event.payload as { result: string }).result);
    expect(results).toEqual(["rescheduled", "rescheduled", "rescheduled", "failed"]);
    expect(ig.containers.size).toBe(0);
  });

  it("otra cuenta de Instagram (otra marca) tiene su propia cuota", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "image", ig: OTHER_IG });
    ig.quotaTotal = 1;
    ig.usage.set(SHARED_IG, 1);

    await expect(attempt(await start())).resolves.toMatchObject({ outcome: "published" });

    expect(ig.log).toContain(`quota:${OTHER_IG}`);
    expect(ig.usage.get(OTHER_IG)).toBe(1);
    expect(t.publications.all()[0]?.status).toBe("published");
  });
});

describe("Instagram para posts · reintentos sin publicar dos veces (F9-T13, ADR-0014)", () => {
  it("Instagram no pudo descargar la foto: el reintento arma un contenedor nuevo y publica una vez", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "image" });
    ig.statusFor = (_fields, id) => (id === "c-1" ? "ERROR:2207052" : "FINISHED");
    const publication = await start();

    const first = await caught(attempt(publication, 0));
    expect(isAppError(first) && [first.code, first.retriable]).toEqual([
      "IG_MEDIA_FETCH_FAILED",
      true,
    ]);
    expect(t.current(publication.id)).toMatchObject({
      status: "publishing",
      progress: { containerId: "c-1" },
    });

    await expect(attempt(publication, 1)).resolves.toMatchObject({ outcome: "published" });

    expect(ig.created().map((container) => container.id)).toEqual(["c-1", "c-2"]);
    expect(ig.publishes()).toEqual(["publish:c-2"]);
    expect(t.current(publication.id)).toMatchObject({ status: "published", externalId: "m-1" });
  });

  it("un corte después de publicar: el reintento reconoce el medio y no publica de nuevo", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "carousel", images: 2 });
    ig.publishBehaviors = ["error-after-publish"];
    const publication = await start();

    const first = await caught(attempt(publication, 0));
    expect(isAppError(first) && first.retriable).toBe(true);
    expect(t.current(publication.id)).toMatchObject({
      status: "publishing",
      progress: { containerId: "c-3", publishRequestedAt: expect.any(String) },
    });

    await expect(attempt(publication, 1)).resolves.toMatchObject({ outcome: "published" });

    expect(ig.publishes()).toEqual(["publish:c-3"]);
    expect(ig.containers.size).toBe(3);
    expect(t.current(publication.id)).toMatchObject({ status: "published", externalId: "m-1" });
  });

  it("un corte antes de que Instagram publique: el reintento mira el contenedor y publica una sola vez", async () => {
    const { ig, t, attempt, start } = await setup({ kind: "video", images: 0, video: true });
    ig.publishBehaviors = ["error"];
    const publication = await start();

    expect(isAppError(await caught(attempt(publication, 0)))).toBe(true);
    expect(t.current(publication.id)?.status).toBe("publishing");

    await expect(attempt(publication, 1)).resolves.toMatchObject({ outcome: "published" });

    // Un solo contenedor: el reintento lo retoma, busca el medio (no está) y lo publica.
    expect(ig.containers.size).toBe(1);
    expect(ig.log.filter((entry) => entry.startsWith("recent:"))).toHaveLength(1);
    expect(ig.publishes()).toEqual(["publish:c-1", "publish:c-1"]);
    expect([...ig.containers.values()].map((container) => container.published)).toEqual([1]);
  });
});

function never(): never {
  throw new Error("falta la cuenta de Instagram del escenario");
}
