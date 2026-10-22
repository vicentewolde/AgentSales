import {
  type AccessTokenProvider,
  AppError,
  isAppError,
  OUTCOME_UNKNOWN,
  type PlatformAccount,
  type PublishContext,
  type PublishInput,
  type PublishMediaItem,
  withDryRun,
} from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createXApi } from "./api.js";
import {
  createXPublisher,
  openXMedia,
  validateXInput,
  type XPublishNote,
  xCostNote,
} from "./publisher.js";

// F9-T16: contratos del publisher de X con msw. Ninguna petición sale a X ni a R2: una sin handler
// falla el test (`usePlatformServer`). Los cuerpos de error imitan los de `x.md` §7 (los textos
// exactos de X son NO VERIFICADO hasta la prueba S4).

const API = "https://api.x.com";
const R2 = "https://r2.test";
const TOKEN = "tokenDeAccesoDeX-1234567890";
const NEW_TOKEN = "tokenNuevoDeX-0987654321";

const { server, recorded } = usePlatformServer();

const account: PlatformAccount = {
  id: "cuenta-x",
  brokerId: "marca",
  platform: "x",
  externalAccountId: "12345",
  displayName: "@agentpey",
  status: "connected",
  tokenExpiresAt: null,
  meta: {
    userId: "12345",
    username: "agentpey",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    connectedAt: "2026-10-20T12:00:00.000Z",
    tokenRefreshedAt: null,
    accessTokenExpiresAt: "2026-10-20T14:00:00.000Z",
  },
  hasCredentials: true,
  createdAt: new Date("2026-10-20T12:00:00Z"),
  updatedAt: new Date("2026-10-20T12:00:00Z"),
};

const image = (n: number, bytes = 2048): PublishMediaItem => ({
  mediaId: `img-${n}`,
  kind: "image",
  mime: "image/jpeg",
  storagePath: `posts/p1/ig_4x5/foto-${n}.jpg`,
  url: `${R2}/posts/p1/ig_4x5/foto-${n}.jpg?X-Amz-Signature=firma-${n}`,
  bytes,
  width: 1080,
  height: 1350,
  durationS: null,
});

const video = (bytes = 9 * 1024 * 1024): PublishMediaItem => ({
  mediaId: "vid-1",
  kind: "video",
  mime: "video/mp4",
  storagePath: "posts/p1/x_video/video.mp4",
  url: `${R2}/posts/p1/x_video/video.mp4?X-Amz-Signature=firma-video`,
  bytes,
  width: 720,
  height: 1280,
  durationS: 30,
});

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  publicationId: "pub-1",
  platform: "x",
  format: "post",
  title: null,
  caption: "Hoy en AgentPey: lo que aprendimos esta semana #agentpey",
  language: "es",
  media: [],
  ...overrides,
});

/** Un proveedor de token como el de core: entrega uno y, tras un rechazo, otro. */
function tokens(next: string | Error = NEW_TOKEN) {
  const calls: Array<{ rejectedToken?: string }> = [];
  const provider: AccessTokenProvider = async (options = {}) => {
    calls.push({
      ...(options.rejectedToken === undefined ? {} : { rejectedToken: options.rejectedToken }),
    });
    if (options.rejectedToken === undefined) return TOKEN;
    if (next instanceof Error) throw next;
    return next;
  };
  return { provider, calls };
}

/** Un contexto en memoria: el progreso que guarda el intento, como lo haría el repositorio. */
function context(progress: unknown = null, overrides: Partial<PublishContext> = {}) {
  const saved: unknown[] = [];
  const ctx: PublishContext & { saved: unknown[] } = {
    account,
    credentials: { accessToken: TOKEN },
    accessToken: tokens().provider,
    progress,
    saved,
    async saveProgress(next) {
      saved.push(structuredClone(next));
      ctx.progress = next;
    },
    ...overrides,
  };
  return ctx;
}

/** R2 simulado: devuelve unos bytes por cada medio. */
function fakeR2(size = 1024) {
  server.use(
    http.get(
      `${R2}/*`,
      () =>
        new HttpResponse(new Uint8Array(size).fill(7), {
          status: 200,
          headers: { "content-length": String(size) },
        }),
    ),
  );
}

/**
 * R2 simulado que entrega el video como flujo, en trozos de 1 MB, anotando cada trozo en `log`.
 * Pasados los primeros 5 MB, no entrega más hasta que X recibió la primera parte (`firstAppend`):
 * si el publisher juntara el archivo entero antes de subirlo, el flujo se corta con un error a los
 * 3 s. Sin `declared`, no manda `content-length`.
 */
function streamingR2(
  size: number,
  log: string[],
  { declared = size, firstAppend }: { declared?: number | null; firstAppend?: Promise<void> } = {},
) {
  server.use(
    http.get(`${R2}/*`, () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= size) {
            controller.close();
            return;
          }
          if (firstAppend !== undefined && sent >= 5 * 1024 * 1024) {
            const waited = await Promise.race([
              firstAppend.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
            ]);
            if (!waited) {
              controller.error(new Error("el video no se subió a medida que llegaba"));
              return;
            }
          }
          const chunk = new Uint8Array(Math.min(1024 * 1024, size - sent)).fill(7);
          sent += chunk.byteLength;
          log.push(`r2:${sent}`);
          controller.enqueue(chunk);
        },
      });
      return new HttpResponse(body, {
        status: 200,
        headers: declared === null ? {} : { "content-length": String(declared) },
      });
    }),
  );
}

/** X simulado para subir un video por partes (id 777), anotando cada APPEND en `log`. */
function fakeVideoUpload(log: string[], totalBytes?: number, onAppend?: () => void) {
  server.use(
    http.post(`${API}/2/media/upload/initialize`, async ({ request }) => {
      const body = (await request.json()) as { total_bytes: number };
      if (totalBytes !== undefined) expect(body.total_bytes).toBe(totalBytes);
      log.push("x:init");
      return HttpResponse.json({ data: { id: "777", expires_after_secs: 86400 } });
    }),
    http.post(`${API}/2/media/upload/777/append`, async ({ request }) => {
      const form = await request.formData();
      const media = form.get("media") as Blob;
      log.push(`x:append:${String(form.get("segment_index"))}:${media.size}`);
      onAppend?.();
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/2/media/upload/777/finalize`, () => {
      log.push("x:finalize");
      return HttpResponse.json({ data: { id: "777" } });
    }),
  );
}

/** X simulado para crear el post: responde el post creado, o lo que diga `respond`. */
function fakeCreate(
  respond: (request: Request) => Response | Promise<Response> = () =>
    HttpResponse.json({ data: { id: "1850000000000000001", text: "…" } }, { status: 201 }),
) {
  server.use(http.post(`${API}/2/tweets`, ({ request }) => respond(request)));
}

/** La API de X sin esperas reales al consultar el estado de un medio. */
const api = () => createXApi({ sleep: async () => undefined });

const problem = (status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json(
    { title: "Problem", type: "about:blank", status, detail: "detalle", ...extra },
    { status, headers: { "content-type": "application/problem+json" } },
  );

const codeOf = (error: unknown) => (isAppError(error) ? error.code : String(error));

describe("validateXInput", () => {
  it("cuenta los 280 ponderados: una URL pesa 23 y un emoji 2", () => {
    expect(validateXInput(input({ caption: "a".repeat(280) })).ok).toBe(true);
    const long = validateXInput(input({ caption: "a".repeat(281) }));
    expect(long.ok).toBe(false);
    // 257 letras + un enlace largo (23) = 280.
    const withLink = `${"a".repeat(256)} https://agentpey.com/${"x".repeat(80)}`;
    expect(validateXInput(input({ caption: withLink })).ok).toBe(true);
    expect(validateXInput(input({ caption: `${"a".repeat(279)}🙂` })).ok).toBe(false);
  });

  it("hasta 4 imágenes o 1 video, sin mezclar, y nunca vacío", () => {
    const codes = (media: PublishMediaItem[], caption = "Hola") => {
      const result = validateXInput(input({ media, caption }));
      return result.ok ? [] : result.issues.map((issue) => issue.code);
    };
    expect(codes([image(1), image(2), image(3), image(4)])).toEqual([]);
    expect(codes([image(1), image(2), image(3), image(4), image(5)])).toEqual([
      "X_TOO_MANY_IMAGES",
    ]);
    expect(codes([image(1), video()])).toEqual(["X_MEDIA_MIXED"]);
    expect(codes([image(1, 6 * 1024 * 1024)])).toEqual(["X_IMAGE_TOO_LARGE"]);
    expect(codes([{ ...video(), durationS: 1300 }])).toEqual(["X_VIDEO_DURATION"]);
    expect(codes([], "  ")).toEqual(["X_EMPTY_POST"]);
  });

  it("en dry-run no llama a X y deja el costo estimado en la bitácora", async () => {
    const publisher = withDryRun(createXPublisher({ api: api() }));
    const result = await publisher.publish(input({ caption: "Más en agentpey.com" }), context());
    expect(result).toMatchObject({ simulated: true });
    expect("notes" in result ? result.notes : []).toContain(xCostNote("Más en agentpey.com"));
    expect(xCostNote("Más en agentpey.com")).toContain("US$0,2");
    expect(xCostNote("Sin enlace")).toContain("US$0,015");
    expect(await recorded()).toEqual([]);
  });
});

describe("createXPublisher: publicar", () => {
  it("publica el texto con el token del contexto y devuelve el id y el enlace del post", async () => {
    fakeCreate();
    const ctx = context();
    const result = await createXPublisher({ api: api() }).publish(input(), ctx);
    expect(result).toEqual({
      externalId: "1850000000000000001",
      externalUrl: "https://x.com/agentpey/status/1850000000000000001",
      simulated: false,
    });
    const [request] = await recorded();
    expect(request?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.json).toEqual({ text: input().caption });
    // "enviando" antes y el resultado después, sin tokens en el progreso.
    expect(ctx.saved).toHaveLength(2);
    expect(ctx.saved[1]).toMatchObject({
      send: { result: { externalId: "1850000000000000001" } },
    });
    expect(JSON.stringify(ctx.saved)).not.toContain(TOKEN);
  });

  it("sube las imágenes, guarda sus ids en el progreso y las adjunta al post", async () => {
    fakeR2();
    let next = 900;
    server.use(
      http.post(`${API}/2/media/upload`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("media_category")).toBe("tweet_image");
        next += 1;
        return HttpResponse.json({ data: { id: String(next), expires_after_secs: 86400 } });
      }),
    );
    fakeCreate();
    const notes: XPublishNote[] = [];
    const ctx = context();
    await createXPublisher({ api: api(), onNote: (note) => notes.push(note) }).publish(
      input({ media: [image(1), image(2)] }),
      ctx,
    );
    const create = (await recorded()).find((request) => request.url.pathname === "/2/tweets");
    expect(create?.json).toMatchObject({ media: { media_ids: ["901", "902"] } });
    expect(ctx.saved[0]).toMatchObject({
      xMedia: {
        items: [
          { mediaId: "img-1", xMediaId: "901" },
          { mediaId: "img-2", xMediaId: "902" },
        ],
      },
    });
    // El "enviando" se suma a los medios guardados, no los pisa.
    expect(ctx.saved[1]).toMatchObject({ xMedia: { items: [{}, {}] }, send: {} });
    expect(notes).toContainEqual({
      publicationId: "pub-1",
      kind: "media_uploaded",
      count: 2,
      reused: false,
    });
  });

  it("sube el video por partes (INIT, APPEND, FINALIZE y el estado) antes de publicar", async () => {
    fakeR2(9 * 1024 * 1024);
    const appended: string[] = [];
    let statusCalls = 0;
    server.use(
      http.post(`${API}/2/media/upload/initialize`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          media_type: "video/mp4",
          total_bytes: 9 * 1024 * 1024,
          media_category: "tweet_video",
        });
        return HttpResponse.json({ data: { id: "777", expires_after_secs: 86400 } });
      }),
      http.post(`${API}/2/media/upload/777/append`, async ({ request }) => {
        const form = await request.formData();
        appended.push(String(form.get("segment_index")));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/2/media/upload/777/finalize`, () =>
        HttpResponse.json({
          data: { id: "777", processing_info: { state: "pending", check_after_secs: 1 } },
        }),
      ),
      http.get(`${API}/2/media/upload`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("command")).toBe("STATUS");
        expect(url.searchParams.get("media_id")).toBe("777");
        statusCalls += 1;
        return HttpResponse.json({
          data: {
            id: "777",
            processing_info:
              statusCalls < 2
                ? { state: "in_progress", check_after_secs: 1 }
                : { state: "succeeded" },
          },
        });
      }),
    );
    fakeCreate();
    await createXPublisher({ api: api() }).publish(
      input({ media: [video(9 * 1024 * 1024)] }),
      context(),
    );
    expect(appended).toEqual(["0", "1", "2"]);
    expect(statusCalls).toBe(2);
    const create = (await recorded()).find((request) => request.url.pathname === "/2/tweets");
    expect(create?.json).toMatchObject({ media: { media_ids: ["777"] } });
  });

  it("lee el video de R2 como flujo y sube cada parte de 4 MB a medida que llega, sin arrayBuffer (F9.5-T08)", async () => {
    const MB = 1024 * 1024;
    const size = 9 * MB + 123;
    const log: string[] = [];
    let appended: () => void = () => undefined;
    const firstAppend = new Promise<void>((resolve) => {
      appended = resolve;
    });
    streamingR2(size, log, { firstAppend });
    fakeVideoUpload(log, size, () => appended());
    fakeCreate();
    const arrayBuffer = vi.spyOn(Response.prototype, "arrayBuffer");
    try {
      await createXPublisher({ api: api() }).publish(input({ media: [video(size)] }), context());
      expect(arrayBuffer).not.toHaveBeenCalled();
    } finally {
      arrayBuffer.mockRestore();
    }
    const appends = log.filter((entry) => entry.startsWith("x:append"));
    expect(appends).toEqual([
      `x:append:0:${4 * MB}`,
      `x:append:1:${4 * MB}`,
      `x:append:2:${MB + 123}`,
    ]);
    // La primera parte sube antes de terminar de leer el video de R2.
    expect(log.indexOf(`x:append:0:${4 * MB}`)).toBeLessThan(log.indexOf(`r2:${size}`));
    expect(log.at(-1)).toBe("x:finalize");
  });

  it("un video sin content-length falla antes del INIT (X necesita el total)", async () => {
    const log: string[] = [];
    streamingR2(2 * 1024 * 1024, log, { declared: null });
    fakeVideoUpload(log);
    const error = await createXPublisher({ api: api() })
      .publish(input({ media: [video(2 * 1024 * 1024)] }), context())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "X_MEDIA_UNAVAILABLE",
      details: { reason: "no_length" },
    });
    expect(log.filter((entry) => entry.startsWith("x:"))).toEqual([]);
    // Ningún error lleva la URL firmada.
    expect(JSON.stringify(error)).not.toContain("Signature");
  });

  it("un reintento reutiliza los medios ya subidos si no vencen", async () => {
    fakeCreate();
    const progress = {
      xMedia: {
        items: [{ mediaId: "img-1", xMediaId: "901" }],
        expiresAt: new Date(Date.now() + 20 * 3600_000).toISOString(),
      },
    };
    await createXPublisher({ api: api() }).publish(input({ media: [image(1)] }), context(progress));
    const requests = await recorded();
    expect(requests.map((request) => request.url.pathname)).toEqual(["/2/tweets"]);
    expect(requests[0]?.json).toMatchObject({ media: { media_ids: ["901"] } });
  });
});

describe("createXPublisher: errores", () => {
  it("402 por saldo: no enviado, con el consejo de recargar, y sin el 'enviando'", async () => {
    fakeCreate(() =>
      problem(402, {
        title: "Payment Required",
        type: "https://api.x.com/2/problems/credits-depleted",
        detail: "credits depleted",
      }),
    );
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_PAYMENT_REQUIRED");
    expect(isAppError(error) && error.retriable).toBe(false);
    expect((error as Error).message).toContain("Recarga créditos");
    expect(ctx.progress).toBeNull();
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("429: no enviado, con la espera hasta x-rate-limit-reset (core lo reprograma)", async () => {
    const reset = Math.floor(Date.now() / 1000) + 5 * 60;
    fakeCreate(
      () =>
        new HttpResponse(JSON.stringify({ title: "Too Many Requests", status: 429 }), {
          status: 429,
          headers: { "x-rate-limit-reset": String(reset), "content-type": "application/json" },
        }),
    );
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_RATE_LIMITED");
    expect(isAppError(error) && error.retriable).toBe(true);
    const details = (error as { details?: { waitMinutes?: number } }).details;
    expect(details?.waitMinutes).toBeGreaterThanOrEqual(4);
    expect(details?.waitMinutes).toBeLessThanOrEqual(6);
    expect(ctx.progress).toBeNull();
  });

  it("403 por texto repetido: queda dudoso (OUTCOME_UNKNOWN), nunca 'no enviado'", async () => {
    fakeCreate(() =>
      problem(403, {
        title: "Forbidden",
        detail: "You are not allowed to create a Tweet with duplicate content.",
      }),
    );
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(OUTCOME_UNKNOWN);
    expect(codeOf((error as Error).cause)).toBe("X_DUPLICATE_CONTENT");
    // El "enviando" queda: un reintento no vuelve a llamar.
    expect(ctx.progress).toMatchObject({ send: { startedAt: expect.any(String) } });
    const again = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(again)).toBe(OUTCOME_UNKNOWN);
    expect(
      (await recorded()).filter((request) => request.url.pathname === "/2/tweets"),
    ).toHaveLength(1);
  });

  it("otro 403 (permisos de la app) es no enviado", async () => {
    fakeCreate(() => problem(403, { detail: "You are not permitted to perform this action." }));
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_FORBIDDEN");
    expect(ctx.progress).toBeNull();
  });

  it("un 5xx o un corte después de enviar es OUTCOME_UNKNOWN", async () => {
    fakeCreate(() => problem(503));
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(OUTCOME_UNKNOWN);
  });

  it("un 401 pide otro token (rejectedToken) y repite una sola vez", async () => {
    let calls = 0;
    fakeCreate(({ headers }) => {
      calls += 1;
      return headers.get("authorization") === `Bearer ${NEW_TOKEN}`
        ? HttpResponse.json({ data: { id: "42" } }, { status: 201 })
        : problem(401, { title: "Unauthorized" });
    });
    const provider = tokens();
    const result = await createXPublisher({ api: api() }).publish(
      input(),
      context(null, { accessToken: provider.provider }),
    );
    expect(result.externalId).toBe("42");
    expect(calls).toBe(2);
    expect(provider.calls).toEqual([{}, { rejectedToken: TOKEN }]);
  });

  it("tras un 401, un refresh token rechazado pide reconectar y no salió nada (no dudoso)", async () => {
    fakeCreate(() => problem(401, { title: "Unauthorized" }));
    const rejected = new AppError("TOKEN_REFRESH_REJECTED", "rechazado");
    const ctx = context(null, { accessToken: tokens(rejected).provider });
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_AUTH_INVALID");
    expect(isAppError(error) && error.retriable).toBe(false);
    expect(ctx.progress).toBeNull();
  });

  it("tras un 401, un fallo pasajero al renovar sube tal cual (reintentable) y no queda dudoso", async () => {
    fakeCreate(() => problem(401, { title: "Unauthorized" }));
    const busy = new AppError("ACCOUNT_LOCK_TIMEOUT", "ocupada", { retriable: true });
    const ctx = context(null, { accessToken: tokens(busy).provider });
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBe(busy);
    expect(isAppError(error) && error.retriable).toBe(true);
    expect(ctx.progress).toBeNull();
  });

  it("un segundo 401 seguido después de renovar no se repite: no enviado, sin dudas", async () => {
    let calls = 0;
    fakeCreate(() => {
      calls += 1;
      return problem(401, { title: "Unauthorized" });
    });
    const provider = tokens();
    const ctx = context(null, { accessToken: provider.provider });
    const error = await createXPublisher({ api: api() })
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_AUTH_INVALID");
    expect(calls).toBe(2);
    expect(provider.calls).toEqual([{}, { rejectedToken: TOKEN }]);
    expect(ctx.progress).toBeNull();
  });

  it("un 401 al subir un medio renueva el token y repite la subida una vez", async () => {
    fakeR2();
    let uploads = 0;
    server.use(
      http.post(`${API}/2/media/upload`, ({ request }) => {
        uploads += 1;
        return request.headers.get("authorization") === `Bearer ${NEW_TOKEN}`
          ? HttpResponse.json({ data: { id: "901", expires_after_secs: 86400 } })
          : problem(401, { title: "Unauthorized" });
      }),
    );
    fakeCreate();
    const provider = tokens();
    const notes: XPublishNote[] = [];
    await createXPublisher({ api: api(), onNote: (note) => notes.push(note) }).publish(
      input({ media: [image(1)] }),
      context(null, { accessToken: provider.provider }),
    );
    expect(uploads).toBe(2);
    expect(provider.calls).toEqual([{}, { rejectedToken: TOKEN }]);
    expect(notes).toContainEqual({
      publicationId: "pub-1",
      kind: "token_renewed_after_401",
      call: "mediaUpload",
    });
    const create = (await recorded()).find((request) => request.url.pathname === "/2/tweets");
    expect(create?.authorization).toBe(`Bearer ${NEW_TOKEN}`);
  });

  it.each([
    ["429", () => problem(429, { title: "Too Many Requests" })],
    ["402", () => problem(402, { title: "Payment Required" })],
  ])("tras un %s, el reintento conserva xMedia y no vuelve a subir los medios", async (_, fail) => {
    fakeR2();
    let uploads = 0;
    server.use(
      http.post(`${API}/2/media/upload`, () => {
        uploads += 1;
        return HttpResponse.json({ data: { id: "901", expires_after_secs: 86400 } });
      }),
    );
    let creates = 0;
    fakeCreate(() => {
      creates += 1;
      return creates === 1 ? fail() : HttpResponse.json({ data: { id: "77" } }, { status: 201 });
    });
    const ctx = context();
    const first = await createXPublisher({ api: api() })
      .publish(input({ media: [image(1)] }), ctx)
      .catch((caught: unknown) => caught);
    expect(isAppError(first)).toBe(true);
    // `sendOnce` quitó el "enviando" pero dejó los medios subidos.
    expect(ctx.progress).toEqual({
      xMedia: { items: [{ mediaId: "img-1", xMediaId: "901" }], expiresAt: expect.any(String) },
    });
    const result = await createXPublisher({ api: api() }).publish(
      input({ media: [image(1)] }),
      ctx,
    );
    expect(result.externalId).toBe("77");
    expect(uploads).toBe(1);
  });

  it("un medio que X rechaza al procesarlo falla antes de 'enviando'", async () => {
    fakeR2();
    server.use(
      http.post(`${API}/2/media/upload`, () =>
        HttpResponse.json({
          data: {
            id: "901",
            processing_info: { state: "failed", error: { name: "InvalidMedia" } },
          },
        }),
      ),
    );
    const ctx = context();
    const error = await createXPublisher({ api: api() })
      .publish(input({ media: [image(1)] }), ctx)
      .catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe("X_MEDIA_REJECTED");
    expect(ctx.saved).toEqual([]);
  });
});

describe("createXApi: uploadVideo con un flujo (F9.5-T08)", () => {
  /** Un flujo de `sizes` trozos que anota si se cerró antes de terminar. */
  function chunked(sizes: number[]) {
    const state = { closed: false };
    async function* generate() {
      try {
        for (const size of sizes) yield new Uint8Array(size).fill(1);
      } finally {
        state.closed = true;
      }
    }
    return { chunks: generate(), state };
  }

  it.each([
    ["llegan menos bytes que el total anunciado", [3 * 1024 * 1024], 5 * 1024 * 1024],
    [
      "llegan más bytes que el total anunciado",
      [3 * 1024 * 1024, 3 * 1024 * 1024],
      5 * 1024 * 1024,
    ],
  ])("un tamaño que no coincide falla sin FINALIZE: %s", async (_, sizes, totalBytes) => {
    const log: string[] = [];
    fakeVideoUpload(log, totalBytes);
    const { chunks, state } = chunked(sizes);
    const error = await api()
      .uploadVideo(TOKEN, { mediaId: "vid-1", mime: "video/mp4", totalBytes, chunks })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "X_MEDIA_UNAVAILABLE",
      retriable: true,
      details: { mediaId: "vid-1", reason: "size" },
    });
    expect(log).not.toContain("x:finalize");
    expect(state.closed).toBe(true);
  });

  it("si X falla a medio subir, cierra el flujo de R2", async () => {
    server.use(
      http.post(`${API}/2/media/upload/initialize`, () =>
        HttpResponse.json({ data: { id: "777" } }),
      ),
      http.post(`${API}/2/media/upload/777/append`, () => problem(400, { title: "Bad" })),
    );
    let pulled = 0;
    const state = { closed: false };
    async function* generate() {
      try {
        for (let index = 0; index < 4; index += 1) {
          pulled += 1;
          yield new Uint8Array(4 * 1024 * 1024);
        }
      } finally {
        state.closed = true;
      }
    }
    const error = await api()
      .uploadVideo(TOKEN, {
        mediaId: "vid-1",
        mime: "video/mp4",
        totalBytes: 16 * 1024 * 1024,
        chunks: generate(),
      })
      .catch((caught: unknown) => caught);
    expect(isAppError(error)).toBe(true);
    expect(state.closed).toBe(true);
    // Se dejó de leer en la primera parte rechazada.
    expect(pulled).toBe(1);
  });
});

describe("openXMedia y el video tras un 401 (F9.5-T08): cierre del flujo", () => {
  it("un 401 a medio subir el video vuelve a abrirlo de R2 y lo sube entero con el token nuevo", async () => {
    const MB = 1024 * 1024;
    let downloads = 0;
    server.use(
      http.get(`${R2}/*`, () => {
        downloads += 1;
        return new HttpResponse(new Uint8Array(9 * MB).fill(3), {
          status: 200,
          headers: { "content-length": String(9 * MB) },
        });
      }),
      http.post(`${API}/2/media/upload/initialize`, () =>
        HttpResponse.json({ data: { id: "777", expires_after_secs: 86400 } }),
      ),
    );
    const appends: string[] = [];
    server.use(
      http.post(`${API}/2/media/upload/777/append`, async ({ request }) => {
        const form = await request.formData();
        const fresh = request.headers.get("authorization") === `Bearer ${NEW_TOKEN}`;
        appends.push(`${fresh ? "nuevo" : "viejo"}:${String(form.get("segment_index"))}`);
        return fresh ? new HttpResponse(null, { status: 204 }) : problem(401);
      }),
      http.post(`${API}/2/media/upload/777/finalize`, () =>
        HttpResponse.json({ data: { id: "777" } }),
      ),
    );
    fakeCreate();
    const provider = tokens();
    const result = await createXPublisher({ api: api() }).publish(
      input({ media: [video(9 * MB)] }),
      context(null, { accessToken: provider.provider }),
    );
    expect(result.externalId).toBe("1850000000000000001");
    expect(downloads).toBe(2);
    expect(appends).toEqual(["viejo:0", "nuevo:0", "nuevo:1", "nuevo:2"]);
    expect(provider.calls).toEqual([{}, { rejectedToken: TOKEN }]);
  });

  it("si quien llama corta a mitad de la lectura, el siguiente trozo es X_ABORTED", async () => {
    server.use(
      http.get(`${R2}/*`, () => {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return new Promise<void>(() => undefined);
            sent = true;
            controller.enqueue(new Uint8Array(1024).fill(5));
            return undefined;
          },
        });
        return new HttpResponse(body, {
          status: 200,
          headers: { "content-length": String(4096) },
        });
      }),
    );
    const caller = new AbortController();
    const opened = await openXMedia(video(4096), { signal: caller.signal });
    expect(opened.totalBytes).toBe(4096);
    const iterator = opened.chunks[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.byteLength).toBe(1024);
    const pending = iterator.next();
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "X_ABORTED" });
    // Ya cerrado: no vuelve a leer.
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("una respuesta que no es 2xx falla sin leer el cuerpo y sin la URL en el error", async () => {
    server.use(http.get(`${R2}/*`, () => new HttpResponse("no está", { status: 404 })));
    const error = await openXMedia(video(4096)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "X_MEDIA_UNAVAILABLE",
      retriable: true,
      details: { mediaId: "vid-1", reason: "http_404" },
    });
    expect(JSON.stringify(error)).not.toContain("Signature");
  });

  it("un aborto antes de abrir no llama a R2", async () => {
    const caller = new AbortController();
    caller.abort();
    const error = await openXMedia(video(4096), { signal: caller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "X_ABORTED" });
    expect(await recorded()).toEqual([]);
  });
});
