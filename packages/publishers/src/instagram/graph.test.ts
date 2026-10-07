import type { AbortSignalLike } from "@agentsales/core";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createInstagramGraph, subcodeOfStatus } from "./graph.js";

const BASE = "https://graph.instagram.com/v25.0";
const TOKEN = "IGAA-token-secreto-123";
const IG_USER = "17841400000000001";

const { server, requests } = usePlatformServer();
const graph = createInstagramGraph();

/** Responde `body` en cada forma: tal cual y dentro de la envoltura `data: [ … ]`. */
const shapes = (body: Record<string, unknown>) => [body, { data: [body] }];

describe("createInstagramGraph", () => {
  it("me: token en la cabecera Bearer, nunca en la URL; versión fija; con y sin envoltura", async () => {
    const profile = { user_id: IG_USER, username: "corredora", account_type: "BUSINESS" };
    for (const body of shapes(profile)) {
      server.use(http.get(`${BASE}/me`, () => HttpResponse.json(body)));
      await expect(graph.me(TOKEN)).resolves.toEqual({
        userId: IG_USER,
        username: "corredora",
        accountType: "BUSINESS",
      });
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url.pathname).toBe("/v25.0/me");
      expect(request.url.searchParams.get("fields")).toBe("user_id,username,account_type");
      expect(request.url.toString()).not.toContain(TOKEN);
    }
  });

  it("me acepta el id como número", async () => {
    server.use(
      http.get(`${BASE}/me`, () =>
        HttpResponse.json({ user_id: 1789, username: "c", account_type: "MEDIA_CREATOR" }),
      ),
    );
    await expect(graph.me(TOKEN)).resolves.toMatchObject({ userId: "1789" });
  });

  it("createContainer manda los campos de cada tipo como formulario", async () => {
    server.use(http.post(`${BASE}/${IG_USER}/media`, () => HttpResponse.json({ id: "c-1" })));
    await graph.createContainer(TOKEN, IG_USER, {
      kind: "image",
      imageUrl: "https://r2.test/a.jpg",
      caption: "Hola",
    });
    await graph.createContainer(TOKEN, IG_USER, {
      kind: "carousel_item",
      imageUrl: "https://r2.test/b.jpg",
    });
    await graph.createContainer(TOKEN, IG_USER, {
      kind: "carousel",
      children: ["c-1", "c-2", "c-3"],
      caption: "Carrusel",
    });
    await expect(
      graph.createContainer(TOKEN, IG_USER, {
        kind: "reel",
        videoUrl: "https://r2.test/reel.mp4",
        caption: "Reel",
        thumbOffsetMs: 1000,
        shareToFeed: true,
      }),
    ).resolves.toBe("c-1");
    expect(requests.map((request) => Object.fromEntries(request.form ?? []))).toEqual([
      { image_url: "https://r2.test/a.jpg", caption: "Hola" },
      { image_url: "https://r2.test/b.jpg", is_carousel_item: "true" },
      { media_type: "CAROUSEL", children: "c-1,c-2,c-3", caption: "Carrusel" },
      {
        media_type: "REELS",
        video_url: "https://r2.test/reel.mp4",
        caption: "Reel",
        thumb_offset: "1000",
        share_to_feed: "true",
      },
    ]);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.form?.has("access_token")).toBe(false);
    }
  });

  it("containerStatus: el estado y, en ERROR, el subcódigo; con y sin envoltura", async () => {
    for (const body of shapes({
      id: "c-1",
      status_code: "FINISHED",
      status: "Finished: Media has been uploaded",
    })) {
      server.use(http.get(`${BASE}/c-1`, () => HttpResponse.json(body)));
      await expect(graph.containerStatus(TOKEN, "c-1")).resolves.toEqual({
        statusCode: "FINISHED",
        subcode: null,
      });
    }
    server.use(
      http.get(`${BASE}/c-2`, () =>
        HttpResponse.json({ status_code: "ERROR", status: "Error: 2207026" }),
      ),
    );
    await expect(graph.containerStatus(TOKEN, "c-2")).resolves.toEqual({
      statusCode: "ERROR",
      subcode: 2207026,
    });
    expect(requests[0]?.url.searchParams.get("fields")).toBe("status_code,status");
  });

  it("createContainer acepta el id dentro de la envoltura data", async () => {
    server.use(
      http.post(`${BASE}/${IG_USER}/media`, () => HttpResponse.json({ data: [{ id: 42 }] })),
    );
    await expect(
      graph.createContainer(TOKEN, IG_USER, {
        kind: "carousel_item",
        imageUrl: "https://r2.test/a.jpg",
      }),
    ).resolves.toBe("42");
  });

  it("un estado que Meta agregue y no conocemos llega como UNKNOWN, no como error", async () => {
    server.use(
      http.get(`${BASE}/c-3`, () => HttpResponse.json({ status_code: "SCHEDULED", status: "x" })),
    );
    await expect(graph.containerStatus(TOKEN, "c-3")).resolves.toEqual({
      statusCode: "UNKNOWN",
      subcode: null,
    });
  });

  it("publishContainer manda creation_id y devuelve el id del medio", async () => {
    for (const body of shapes({ id: 9001 })) {
      server.use(http.post(`${BASE}/${IG_USER}/media_publish`, () => HttpResponse.json(body)));
      await expect(graph.publishContainer(TOKEN, IG_USER, "c-9")).resolves.toBe("9001");
    }
    expect(requests.map((request) => request.form?.get("creation_id"))).toEqual(["c-9", "c-9"]);
  });

  it("media: enlace, fecha y caption; lo que falta queda en null", async () => {
    server.use(
      http.get(`${BASE}/m-1`, () =>
        HttpResponse.json({
          id: "m-1",
          permalink: "https://www.instagram.com/p/abc/",
          timestamp: "2026-10-05T15:00:00+0000",
          caption: "Hola",
          media_type: "CAROUSEL_ALBUM",
          media_product_type: "FEED",
        }),
      ),
      http.get(`${BASE}/m-2`, () => HttpResponse.json({ data: [{ id: "m-2" }] })),
    );
    await expect(graph.media(TOKEN, "m-1")).resolves.toEqual({
      id: "m-1",
      permalink: "https://www.instagram.com/p/abc/",
      timestamp: new Date("2026-10-05T15:00:00Z"),
      caption: "Hola",
      mediaType: "CAROUSEL_ALBUM",
      productType: "FEED",
    });
    await expect(graph.media(TOKEN, "m-2")).resolves.toEqual({
      id: "m-2",
      permalink: null,
      timestamp: null,
      caption: null,
      mediaType: null,
      productType: null,
    });
    expect(requests[0]?.url.searchParams.get("fields")).toBe(
      "id,permalink,timestamp,caption,media_type,media_product_type",
    );
  });

  it("recentMedia lee la lista de data con su límite", async () => {
    server.use(
      http.get(`${BASE}/${IG_USER}/media`, () =>
        HttpResponse.json({
          data: [
            { id: "m-2", caption: "Nuevo", timestamp: "2026-10-05T15:00:00+0000" },
            { id: "m-1", caption: null },
          ],
          paging: { cursors: { before: "a", after: "b" } },
        }),
      ),
    );
    const media = await graph.recentMedia(TOKEN, IG_USER, { limit: 5 });
    expect(media.map((item) => item.id)).toEqual(["m-2", "m-1"]);
    expect(requests[0]?.url.searchParams.get("limit")).toBe("5");
  });

  it("recentMedia acepta la lista como arreglo suelto", async () => {
    server.use(http.get(`${BASE}/${IG_USER}/media`, () => HttpResponse.json([{ id: "m-1" }])));
    await expect(graph.recentMedia(TOKEN, IG_USER)).resolves.toMatchObject([{ id: "m-1" }]);
  });

  it("publishingLimit: el uso y el total de config; sin config el total es null", async () => {
    server.use(
      http.get(`${BASE}/${IG_USER}/content_publishing_limit`, () =>
        HttpResponse.json({
          data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }],
        }),
      ),
    );
    await expect(graph.publishingLimit(TOKEN, IG_USER)).resolves.toEqual({
      quotaUsage: 3,
      quotaTotal: 100,
    });
    server.use(
      http.get(`${BASE}/${IG_USER}/content_publishing_limit`, () =>
        HttpResponse.json({ quota_usage: 0 }),
      ),
    );
    await expect(graph.publishingLimit(TOKEN, IG_USER)).resolves.toEqual({
      quotaUsage: 0,
      quotaTotal: null,
    });
  });
});

describe("errores del cliente", () => {
  it("un error de Graph se clasifica, sin el token ni el mensaje de Meta", async () => {
    server.use(
      http.get(`${BASE}/me`, () =>
        HttpResponse.json(
          {
            error: {
              message: `Error validating access token ${TOKEN}`,
              type: "OAuthException",
              code: 190,
              error_subcode: 463,
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await graph.me(TOKEN).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "IG_AUTH_INVALID", retriable: false });
    expect(errorText(error)).not.toContain(TOKEN);
    expect(errorText(error)).not.toContain("validating");
  });

  it("un límite de llamadas lee la espera de la cabecera", async () => {
    server.use(
      http.get(`${BASE}/me`, () =>
        HttpResponse.json(
          { error: { code: 17, message: "User request limit reached" } },
          {
            status: 400,
            headers: {
              "X-Business-Use-Case-Usage": JSON.stringify({
                [IG_USER]: [{ type: "instagram", estimated_time_to_regain_access: 7 }],
              }),
            },
          },
        ),
      ),
    );
    await expect(graph.me(TOKEN)).rejects.toMatchObject({
      code: "IG_RATE_LIMITED",
      message: expect.stringContaining("7 minutos"),
    });
  });

  it("los errores de crear, consultar y publicar un contenedor se clasifican igual", async () => {
    const graphError = (code: number, subcode: number) =>
      HttpResponse.json(
        { error: { code, error_subcode: subcode, message: TOKEN } },
        { status: 400 },
      );
    server.use(
      http.post(`${BASE}/${IG_USER}/media`, () => graphError(9004, 2207052)),
      http.get(`${BASE}/c-1`, () => graphError(100, 2207026)),
      http.post(`${BASE}/${IG_USER}/media_publish`, () => graphError(9, 2207042)),
    );
    const results = await Promise.all([
      graph
        .createContainer(TOKEN, IG_USER, {
          kind: "carousel_item",
          imageUrl: "https://r2.test/a.jpg",
        })
        .catch((caught: unknown) => caught),
      graph.containerStatus(TOKEN, "c-1").catch((caught: unknown) => caught),
      graph.publishContainer(TOKEN, IG_USER, "c-1").catch((caught: unknown) => caught),
    ]);
    expect(results).toMatchObject([
      { code: "IG_MEDIA_FETCH_FAILED", retriable: true },
      { code: "IG_MEDIA_REJECTED", retriable: false },
      { code: "IG_PUBLISH_LIMIT", retriable: false },
    ]);
    for (const result of results) expect(errorText(result)).not.toContain(TOKEN);
  });

  it("un 4xx que no es JSON (una página de un proxy) se clasifica por su status", async () => {
    for (const [status, code] of [
      [401, "IG_AUTH_INVALID"],
      [403, "IG_PERMISSION_DENIED"],
      [429, "IG_RATE_LIMITED"],
      [400, "IG_REQUEST_REJECTED"],
    ] as const) {
      server.use(http.get(`${BASE}/me`, () => new HttpResponse("<html>No</html>", { status })));
      await expect(graph.me(TOKEN)).rejects.toMatchObject({ code, retriable: false });
    }
  });

  it("una cabecera de espera ilegible deja la hora por defecto", async () => {
    server.use(
      http.get(`${BASE}/me`, () =>
        HttpResponse.json(
          { error: { code: 4 } },
          { status: 400, headers: { "X-Business-Use-Case-Usage": "{basura" } },
        ),
      ),
    );
    await expect(graph.me(TOKEN)).rejects.toMatchObject({
      code: "IG_RATE_LIMITED",
      message: expect.stringContaining("60 minutos"),
    });
  });

  it("un corte al leer la respuesta es IG_UNAVAILABLE", async () => {
    server.use(
      http.get(
        `${BASE}/me`,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"user_id":'));
                controller.error(new Error("se cortó"));
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(graph.me(TOKEN)).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
    });
  });

  it("un token que no cabe en una cabecera es IG_AUTH_INVALID, sin llamar", async () => {
    for (const bad of ["", "con espacio", "linea\nnueva", "tíldé"]) {
      await expect(graph.me(bad)).rejects.toMatchObject({
        code: "IG_AUTH_INVALID",
        retriable: false,
      });
    }
    expect(requests).toEqual([]);
  });

  it("un 5xx que no es JSON es IG_UNAVAILABLE, reintentable", async () => {
    server.use(
      http.get(`${BASE}/me`, () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })),
    );
    await expect(graph.me(TOKEN)).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
    });
  });

  it("una respuesta con otra forma es IG_UNEXPECTED_RESPONSE, no reintentable", async () => {
    for (const reply of [
      () => HttpResponse.json({ username: "sin user_id" }),
      () => new HttpResponse("no es json", { status: 200 }),
      () => new HttpResponse(null, { status: 200 }),
      () => HttpResponse.json({ data: [{ user_id: "1" }, { user_id: "2" }] }),
    ]) {
      server.use(http.get(`${BASE}/me`, reply));
      await expect(graph.me(TOKEN)).rejects.toMatchObject({
        code: "IG_UNEXPECTED_RESPONSE",
        retriable: false,
      });
    }
  });

  it("sin conexión es IG_UNAVAILABLE, sin la URL", async () => {
    server.use(http.get(`${BASE}/me`, () => HttpResponse.error()));
    const error = await graph.me(TOKEN).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
      details: { reason: "network" },
    });
    expect(errorText(error)).not.toContain("graph.instagram.com");
  });

  it("pasado el tope de tiempo es IG_UNAVAILABLE (timeout)", async () => {
    const slow = createInstagramGraph({ timeoutMs: 30 });
    server.use(
      http.get(`${BASE}/me`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    await expect(slow.me(TOKEN)).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
      details: { reason: "timeout" },
    });
  });

  it("la señal corta la llamada en curso (IG_ABORTED) y una ya disparada no llama", async () => {
    server.use(
      http.get(`${BASE}/me`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    const pending = graph.me(TOKEN, { signal: controller.signal });
    await delay(10);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "IG_ABORTED", retriable: true });
    const before = requests.length;
    await expect(graph.me(TOKEN, { signal: controller.signal })).rejects.toMatchObject({
      code: "IG_ABORTED",
    });
    expect(requests).toHaveLength(before);
  });
});

describe("la señal no deja listeners colgando", () => {
  /** Una señal que cuenta cuántos listeners quedan puestos. */
  function countingSignal() {
    const controller = new AbortController();
    let active = 0;
    const signal: AbortSignalLike = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener(type, listener, options) {
        active += 1;
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        active -= 1;
        controller.signal.removeEventListener(type, listener);
      },
    };
    return { signal, controller, active: () => active };
  }

  it("tras éxito, error de Meta, sin red, tope de tiempo y corte", async () => {
    const slow = createInstagramGraph({ timeoutMs: 30 });
    const replies = [
      () => HttpResponse.json({ user_id: "1", username: "c", account_type: "BUSINESS" }),
      () => HttpResponse.json({ error: { code: 190 } }, { status: 400 }),
      () => HttpResponse.error(),
      async () => {
        await delay("infinite");
        return HttpResponse.json({});
      },
    ];
    for (const reply of replies) {
      server.use(http.get(`${BASE}/me`, reply));
      const counted = countingSignal();
      await slow.me(TOKEN, { signal: counted.signal }).catch(() => undefined);
      expect(counted.active()).toBe(0);
    }
    server.use(
      http.get(`${BASE}/me`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const counted = countingSignal();
    const pending = graph.me(TOKEN, { signal: counted.signal }).catch(() => undefined);
    await delay(10);
    counted.controller.abort();
    await pending;
    expect(counted.active()).toBe(0);
  });
});

describe("subcodeOfStatus", () => {
  it("saca el subcódigo del texto del estado", () => {
    expect(subcodeOfStatus("Error: 2207026")).toBe(2207026);
    expect(subcodeOfStatus("Error code 2207052: media fetch failed")).toBe(2207052);
    expect(subcodeOfStatus("Error: unknown")).toBeNull();
    expect(subcodeOfStatus(null)).toBeNull();
  });
});
