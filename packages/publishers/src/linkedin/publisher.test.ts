import {
  isAppError,
  LINKEDIN_RESERVED_CHARACTERS,
  OUTCOME_UNKNOWN,
  type PlatformAccount,
  type PublishContext,
  type PublishInput,
  type PublishMediaItem,
  withDryRun,
} from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createLinkedInApi, isLinkedInUploadUrl } from "./api.js";
import {
  LINKEDIN_API_VERSION,
  LINKEDIN_API_VERSION_SUNSET,
  LINKEDIN_LIMITS,
  LINKEDIN_VIDEO_PART_BYTES,
} from "./constants.js";
import {
  createLinkedInPublisher,
  deleteLinkedInPost,
  type LinkedInPublishNote,
  type MediaRange,
  readMediaFromUrl,
  validateLinkedInInput,
} from "./publisher.js";

// F9-T15: contratos del publisher de LinkedIn con msw. Ninguna petición sale a LinkedIn ni a R2:
// una sin handler falla el test (`usePlatformServer`).

const TOKEN = "AQV-token-secreto-de-linkedin";
const API = "https://api.linkedin.com/rest";
const UPLOAD = "https://www.linkedin.com/dms-uploads/sp/subida";
const R2 = "https://r2.test";
const POST_URN = "urn:li:share:7380000000000000001";
const MEMBER = "abc-DEF_123";

const { server, recorded } = usePlatformServer();

const account: PlatformAccount = {
  id: "cuenta-linkedin",
  brokerId: "marca",
  platform: "linkedin",
  externalAccountId: MEMBER,
  displayName: "Vicente Wolde",
  status: "connected",
  tokenExpiresAt: new Date("2026-12-19T12:00:00Z"),
  meta: { mode: "api", scopes: null, connectedAt: "2026-10-20T12:00:00.000Z" },
  hasCredentials: true,
  createdAt: new Date("2026-10-20T12:00:00Z"),
  updatedAt: new Date("2026-10-20T12:00:00Z"),
};

const image = (n: number, overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
  mediaId: `img-${n}`,
  kind: "image",
  mime: "image/jpeg",
  storagePath: `posts/p1/ig_4x5/foto-${n}.jpg`,
  url: `${R2}/posts/p1/ig_4x5/foto-${n}.jpg?X-Amz-Signature=firma-${n}`,
  bytes: 2048,
  width: 1080,
  height: 1350,
  durationS: null,
  ...overrides,
});

const VIDEO_BYTES = LINKEDIN_VIDEO_PART_BYTES + 100_000;
const video = (overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
  mediaId: "vid-1",
  kind: "video",
  mime: "video/mp4",
  storagePath: "posts/p1/ig_reel/video.mp4",
  url: `${R2}/posts/p1/ig_reel/video.mp4?X-Amz-Signature=firma-video`,
  bytes: VIDEO_BYTES,
  width: 1080,
  height: 1920,
  durationS: 30,
  ...overrides,
});

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  publicationId: "pub-1",
  platform: "linkedin",
  format: "post",
  title: null,
  caption: "Hola desde AgentPey #ia",
  language: "es",
  media: [],
  ...overrides,
});

/** Un contexto en memoria: el progreso que guarda el intento, como lo haría el repositorio. */
function context(progress: unknown = null, overrides: Partial<PublishContext> = {}) {
  const saved: unknown[] = [];
  const ctx: PublishContext & { saved: unknown[] } = {
    account,
    credentials: { accessToken: TOKEN },
    accessToken: async () => TOKEN,
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

/** R2 en memoria: lo que se pidió (medio y tramo) y bytes de ese largo. */
function fakeMedia() {
  const reads: Array<{ mediaId: string; range: MediaRange }> = [];
  const readMedia = async (item: PublishMediaItem, range: MediaRange) => {
    reads.push({ mediaId: item.mediaId, range });
    const size = range === null ? 16 : range.last - range.first + 1;
    return new Uint8Array(size).fill(7);
  };
  return { reads, readMedia };
}

type Handlers = {
  post?: (request: Request) => Response | Promise<Response>;
  videoStatus?: () => Response;
};

/** LinkedIn simulado: inicializa imágenes y videos, recibe las subidas y crea el post. */
function fakeLinkedIn(handlers: Handlers = {}) {
  const posts: unknown[] = [];
  const uploads: Array<{ url: string; bytes: number; contentType: string | null }> = [];
  let images = 0;
  const finalized: unknown[] = [];
  server.use(
    http.post(`${API}/images`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("action")).toBe("initializeUpload");
      images += 1;
      return HttpResponse.json({
        value: {
          uploadUrlExpiresAt: 1_790_000_000_000,
          uploadUrl: `${UPLOAD}/imagen-${images}?firma=secreta`,
          image: `urn:li:image:C4E10AQ${images}`,
        },
      });
    }),
    http.post(`${API}/videos`, async ({ request }) => {
      const action = new URL(request.url).searchParams.get("action");
      const body = (await request.json()) as Record<string, Record<string, unknown>>;
      if (action === "finalizeUpload") {
        finalized.push(body.finalizeUploadRequest);
        return new HttpResponse(null, { status: 200 });
      }
      const size = Number(body.initializeUploadRequest?.fileSizeBytes);
      return HttpResponse.json({
        value: {
          video: "urn:li:video:C5F10AQ1",
          uploadToken: "token-de-subida",
          uploadUrlsExpireAt: 1_790_000_000_000,
          uploadInstructions: [
            { firstByte: 0, lastByte: LINKEDIN_VIDEO_PART_BYTES - 1, uploadUrl: `${UPLOAD}/v1` },
            { firstByte: LINKEDIN_VIDEO_PART_BYTES, lastByte: size - 1, uploadUrl: `${UPLOAD}/v2` },
          ],
        },
      });
    }),
    http.put(`${UPLOAD}/*`, async ({ request }) => {
      const bytes = (await request.arrayBuffer()).byteLength;
      uploads.push({ url: request.url, bytes, contentType: request.headers.get("content-type") });
      const part = new URL(request.url).pathname.split("/").pop();
      return new HttpResponse(null, { status: 201, headers: { ETag: `"etag-${part}"` } });
    }),
    http.get(`${API}/videos/*`, () =>
      handlers.videoStatus === undefined
        ? HttpResponse.json({ status: "AVAILABLE", id: "urn:li:video:C5F10AQ1" })
        : handlers.videoStatus(),
    ),
    http.post(`${API}/posts`, async ({ request }) => {
      posts.push(await request.clone().json());
      return handlers.post === undefined
        ? new HttpResponse(null, { status: 201, headers: { "x-restli-id": POST_URN } })
        : handlers.post(request);
    }),
  );
  return { posts, uploads, finalized };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("se esperaba un error");
}

describe("publicar en LinkedIn (/rest/posts)", () => {
  it("texto: cabeceras de versión, autor del miembro, público y el URN como id", async () => {
    const { posts } = fakeLinkedIn();
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    const ctx = context();

    const result = await publisher.publish(input(), ctx);

    expect(result).toEqual({
      externalId: POST_URN,
      externalUrl: `https://www.linkedin.com/feed/update/${POST_URN}/`,
      simulated: false,
    });
    expect(posts).toEqual([
      {
        author: `urn:li:person:${MEMBER}`,
        commentary: "Hola desde AgentPey \\#ia",
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
    ]);
    const [request] = await recorded();
    expect(request?.authorization).toBe(`Bearer ${TOKEN}`);
    // El "enviando" y su resultado quedan en el progreso (ADR-0029 punto 8).
    expect(ctx.progress).toMatchObject({ send: { result: { externalId: POST_URN } } });
  });

  it("manda Linkedin-Version y X-Restli-Protocol-Version en cada llamada a /rest", async () => {
    const versions: Array<[string | null, string | null]> = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.url.startsWith(API)) {
        versions.push([
          request.headers.get("linkedin-version"),
          request.headers.get("x-restli-protocol-version"),
        ]);
      }
    };
    server.events.on("request:start", listener);
    fakeLinkedIn();
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    await publisher.publish(input({ media: [image(1)] }), context());
    server.events.removeListener("request:start", listener);
    expect(versions.length).toBe(2);
    for (const pair of versions) expect(pair).toEqual([LINKEDIN_API_VERSION, "2.0.0"]);
  });

  it("escapa los 15 caracteres reservados del commentary y deja los hashtags como texto", async () => {
    const { posts } = fakeLinkedIn();
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    const caption = `Todos: ${LINKEDIN_RESERVED_CHARACTERS.join(" ")}\nPrecio (UF) #arriendo @agentpey`;

    await publisher.publish(input({ caption }), context());

    const { commentary } = posts[0] as { commentary: string };
    expect(LINKEDIN_RESERVED_CHARACTERS).toHaveLength(15);
    expect(commentary).toBe(
      "Todos: \\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\# \\\\ \\* \\_ \\~\nPrecio \\(UF\\) \\#arriendo \\@agentpey",
    );
    // Cada reservado va precedido de una barra: quitar los pares escapados no deja ninguno suelto.
    expect(commentary.replace(/\\[|{}@[\]()<>#\\*_~]/g, "")).not.toMatch(/[|{}@[\]()<>#\\*_~]/);
  });

  it("imagen: initializeUpload, PUT de los bytes a la URL de LinkedIn y content.media", async () => {
    const { posts, uploads } = fakeLinkedIn();
    const media = fakeMedia();
    const publisher = createLinkedInPublisher({ readMedia: media.readMedia });
    const ctx = context();

    await publisher.publish(input({ media: [image(1)] }), ctx);

    expect(media.reads).toEqual([{ mediaId: "img-1", range: null }]);
    expect(uploads).toEqual([
      {
        url: `${UPLOAD}/imagen-1?firma=secreta`,
        bytes: 16,
        contentType: "application/octet-stream",
      },
    ]);
    expect(posts[0]).toMatchObject({ content: { media: { id: "urn:li:image:C4E10AQ1" } } });
    // Los URN subidos quedan en el progreso, al lado del envío.
    expect(ctx.saved[0]).toEqual({
      linkedin: { media: [{ mediaId: "img-1", urn: "urn:li:image:C4E10AQ1" }] },
    });
    const requests = await recorded();
    expect(requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("varias imágenes: una subida por imagen, en orden, y content.multiImage", async () => {
    const { posts, uploads } = fakeLinkedIn();
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });

    await publisher.publish(input({ media: [image(1), image(2), image(3)] }), context());

    expect(uploads.map((upload) => new URL(upload.url).pathname.split("/").pop())).toEqual([
      "imagen-1",
      "imagen-2",
      "imagen-3",
    ]);
    expect(posts[0]).toMatchObject({
      content: {
        multiImage: {
          images: [
            { id: "urn:li:image:C4E10AQ1" },
            { id: "urn:li:image:C4E10AQ2" },
            { id: "urn:li:image:C4E10AQ3" },
          ],
        },
      },
    });
  });

  it("video: partes de 4 MiB leídas por tramo, finalizeUpload con los ETag en orden, AVAILABLE y content.media", async () => {
    const { posts, uploads, finalized } = fakeLinkedIn();
    const media = fakeMedia();
    const publisher = createLinkedInPublisher({
      readMedia: media.readMedia,
      sleep: async () => {},
    });

    await publisher.publish(input({ media: [video()] }), context());

    expect(media.reads).toEqual([
      { mediaId: "vid-1", range: { first: 0, last: LINKEDIN_VIDEO_PART_BYTES - 1 } },
      { mediaId: "vid-1", range: { first: LINKEDIN_VIDEO_PART_BYTES, last: VIDEO_BYTES - 1 } },
    ]);
    expect(uploads.map((upload) => upload.bytes)).toEqual([
      LINKEDIN_VIDEO_PART_BYTES,
      VIDEO_BYTES - LINKEDIN_VIDEO_PART_BYTES,
    ]);
    expect(finalized).toEqual([
      {
        video: "urn:li:video:C5F10AQ1",
        uploadToken: "token-de-subida",
        uploadedPartIds: ['"etag-v1"', '"etag-v2"'],
      },
    ]);
    expect(posts[0]).toMatchObject({ content: { media: { id: "urn:li:video:C5F10AQ1" } } });
  });

  it("video: espera mientras procesa; si el token no puede leerlo (403), publica igual con una nota", async () => {
    const statuses = ["PROCESSING", "PROCESSING", "AVAILABLE"];
    fakeLinkedIn({ videoStatus: () => HttpResponse.json({ status: statuses.shift() }) });
    const sleeps: number[] = [];
    const publisher = createLinkedInPublisher({
      readMedia: fakeMedia().readMedia,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      videoPoll: { intervalMs: 5, attempts: 10 },
    });
    await publisher.publish(input({ media: [video()] }), context());
    expect(sleeps).toEqual([5, 5]);

    const notes: LinkedInPublishNote[] = [];
    const forbidden = fakeLinkedIn({
      videoStatus: () => HttpResponse.json({ status: 403 }, { status: 403 }),
    });
    const second = createLinkedInPublisher({
      readMedia: fakeMedia().readMedia,
      onNote: (note) => notes.push(note),
    });
    await second.publish(input({ media: [video()] }), context());
    expect(forbidden.posts).toHaveLength(1);
    expect(notes).toEqual([
      { publicationId: "pub-1", kind: "video_status_unreadable", mediaId: "vid-1" },
    ]);
  });

  it("video que falla al procesar: LINKEDIN_MEDIA_REJECTED sin publicar, y lo subido se olvida", async () => {
    const { posts } = fakeLinkedIn({
      videoStatus: () => HttpResponse.json({ status: "PROCESSING_FAILED" }),
    });
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    const ctx = context();

    const error = await caught(publisher.publish(input({ media: [video()] }), ctx));

    expect(error).toMatchObject({ code: "LINKEDIN_MEDIA_REJECTED", retriable: false });
    expect(posts).toEqual([]);
    expect(ctx.progress).toBeNull();
  });

  it("un reintento reutiliza los medios ya subidos (sin subirlos de nuevo)", async () => {
    const { posts, uploads } = fakeLinkedIn();
    const notes: LinkedInPublishNote[] = [];
    const publisher = createLinkedInPublisher({
      readMedia: fakeMedia().readMedia,
      onNote: (note) => notes.push(note),
    });
    const progress = {
      linkedin: {
        media: [
          { mediaId: "img-1", urn: "urn:li:image:YA1" },
          { mediaId: "img-2", urn: "urn:li:image:YA2" },
        ],
      },
    };

    await publisher.publish(input({ media: [image(1), image(2)] }), context(progress));

    expect(uploads).toEqual([]);
    expect(posts[0]).toMatchObject({
      content: { multiImage: { images: [{ id: "urn:li:image:YA1" }, { id: "urn:li:image:YA2" }] } },
    });
    expect(notes).toEqual([{ publicationId: "pub-1", kind: "media_reused", count: 2 }]);
  });

  it("una URL de subida que no es de LinkedIn no recibe el token: LINKEDIN_UNEXPECTED_RESPONSE", async () => {
    server.use(
      http.post(`${API}/images`, () =>
        HttpResponse.json({
          value: { uploadUrl: "https://evil.test/subida", image: "urn:li:image:X" },
        }),
      ),
    );
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    const error = await caught(publisher.publish(input({ media: [image(1)] }), context()));
    expect(error).toMatchObject({ code: "LINKEDIN_UNEXPECTED_RESPONSE" });
    const requests = await recorded();
    expect(requests.map((request) => request.url.host)).toEqual(["api.linkedin.com"]);
    expect(isLinkedInUploadUrl("https://www.linkedin.com/dms-uploads/x")).toBe(true);
    expect(isLinkedInUploadUrl("https://api.linkedin.com/mediaUpload/x")).toBe(true);
    expect(isLinkedInUploadUrl("http://www.linkedin.com/x")).toBe(false);
    expect(isLinkedInUploadUrl("https://linkedin.com.evil.test/x")).toBe(false);
    expect(isLinkedInUploadUrl("https://www.linkedin.com:8443/x")).toBe(false);
  });
});

describe("errores de LinkedIn al publicar", () => {
  it("401 (token vencido): LINKEDIN_AUTH_INVALID no reintentable; no salió, así que no queda dudoso", async () => {
    fakeLinkedIn({
      post: () => HttpResponse.json({ status: 401, serviceErrorCode: 65601 }, { status: 401 }),
    });
    const publisher = createLinkedInPublisher();
    const ctx = context();

    const error = await caught(publisher.publish(input(), ctx));

    expect(error).toMatchObject({
      code: "LINKEDIN_AUTH_INVALID",
      retriable: false,
      details: { httpStatus: 401, call: "createPost" },
    });
    // El "enviando" se quitó: el reintento (tras reconectar) publica sin quedar dudoso.
    expect(ctx.progress).toBeNull();
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("429: LINKEDIN_RATE_LIMITED reintentable con waitMinutes (core reprograma)", async () => {
    fakeLinkedIn({ post: () => HttpResponse.json({ status: 429 }, { status: 429 }) });
    const error = await caught(createLinkedInPublisher().publish(input(), context()));
    expect(error).toMatchObject({
      code: "LINKEDIN_RATE_LIMITED",
      retriable: true,
      details: { httpStatus: 429, waitMinutes: 60 },
    });

    fakeLinkedIn({
      post: () =>
        HttpResponse.json({ status: 429 }, { status: 429, headers: { "Retry-After": "120" } }),
    });
    const short = await caught(createLinkedInPublisher().publish(input(), context()));
    expect(short).toMatchObject({ details: { waitMinutes: 2 } });
  });

  it("422: LINKEDIN_REQUEST_REJECTED no reintentable, sin el mensaje de LinkedIn", async () => {
    fakeLinkedIn({
      post: () =>
        HttpResponse.json(
          { status: 422, message: "Texto con datos: Hola desde AgentPey" },
          { status: 422 },
        ),
    });
    const ctx = context();
    const error = await caught(createLinkedInPublisher().publish(input(), ctx));
    expect(error).toMatchObject({ code: "LINKEDIN_REQUEST_REJECTED", retriable: false });
    expect(errorText(error)).not.toContain("Hola desde AgentPey");
    expect(ctx.progress).toBeNull();
  });

  it("400 con su código: texto largo, medio aún no listo (reintentable, conserva lo subido) y medio inválido", async () => {
    fakeLinkedIn({
      post: () =>
        HttpResponse.json(
          { status: 400, code: "FIELD_LENGTH_TOO_LONG", message: "x" },
          { status: 400 },
        ),
    });
    expect(await caught(createLinkedInPublisher().publish(input(), context()))).toMatchObject({
      code: "LINKEDIN_TEXT_TOO_LONG",
    });

    fakeLinkedIn({
      post: () =>
        HttpResponse.json(
          { status: 400, message: "Error: MEDIA_ASSET_WAITING_UPLOAD for urn" },
          { status: 400 },
        ),
    });
    const ctx = context();
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    expect(await caught(publisher.publish(input({ media: [image(1)] }), ctx))).toMatchObject({
      code: "LINKEDIN_MEDIA_NOT_READY",
      retriable: true,
    });
    expect(ctx.progress).toEqual({
      linkedin: { media: [{ mediaId: "img-1", urn: "urn:li:image:C4E10AQ1" }] },
    });

    fakeLinkedIn({
      post: () => HttpResponse.json({ status: 400, code: "INVALID_IMAGE_ID" }, { status: 400 }),
    });
    const rejected = context(ctx.progress);
    expect(await caught(publisher.publish(input({ media: [image(1)] }), rejected))).toMatchObject({
      code: "LINKEDIN_MEDIA_REJECTED",
    });
    expect(rejected.progress).toBeNull();
  });

  it("426: LINKEDIN_VERSION_DEPRECATED (hay que subir la versión)", async () => {
    fakeLinkedIn({ post: () => new HttpResponse(null, { status: 426 }) });
    expect(await caught(createLinkedInPublisher().publish(input(), context()))).toMatchObject({
      code: "LINKEDIN_VERSION_DEPRECATED",
      retriable: false,
    });
  });

  it("un 500, un corte o un 201 sin URN dejan OUTCOME_UNKNOWN: el post pudo crearse", async () => {
    for (const post of [
      () => HttpResponse.json({ status: 500 }, { status: 500 }),
      () => HttpResponse.error(),
      () => new HttpResponse(null, { status: 201 }),
    ]) {
      fakeLinkedIn({ post });
      const ctx = context();
      const error = await caught(createLinkedInPublisher().publish(input(), ctx));
      expect(error).toMatchObject({ code: OUTCOME_UNKNOWN, retriable: false });
      expect(ctx.progress).toMatchObject({ send: { startedAt: expect.any(String) } });
      expect(errorText(error)).not.toContain(TOKEN);
    }
  });

  it("con un envío anterior sin resultado no llama (OUTCOME_UNKNOWN); con resultado, lo devuelve", async () => {
    const publisher = createLinkedInPublisher({ readMedia: fakeMedia().readMedia });
    const startedAt = "2026-10-20T12:00:00.000Z";
    expect(
      await caught(
        publisher.publish(input({ media: [image(1)] }), context({ send: { startedAt } })),
      ),
    ).toMatchObject({ code: OUTCOME_UNKNOWN });
    const result = {
      externalId: POST_URN,
      externalUrl: `https://www.linkedin.com/feed/update/${POST_URN}/`,
    };
    await expect(
      publisher.publish(input(), context({ send: { startedAt, result } })),
    ).resolves.toEqual({ ...result, simulated: false });
    expect(await recorded()).toEqual([]);
  });

  it("una cuenta sin forma de miembro es CREDENTIALS_INVALID sin llamar", async () => {
    const ctx = context(null, { account: { ...account, externalAccountId: "a b" } });
    expect(await caught(createLinkedInPublisher().publish(input(), ctx))).toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
    expect(await recorded()).toEqual([]);
  });
});

describe("validateLinkedInInput", () => {
  const codes = (value: PublishInput) => {
    const result = validateLinkedInInput(value);
    return result.ok ? [] : result.issues.map((issue) => issue.code);
  };

  it("acepta texto, hasta 20 imágenes o un video", () => {
    expect(codes(input())).toEqual([]);
    expect(codes(input({ media: Array.from({ length: 20 }, (_, n) => image(n)) }))).toEqual([]);
    expect(codes(input({ media: [video()] }))).toEqual([]);
  });

  it("rechaza lo que LinkedIn no acepta", () => {
    expect(codes(input({ caption: "  " }))).toEqual(["LINKEDIN_TEXT_EMPTY"]);
    // 3.000 visibles, pero con los escapes pasa del largo.
    expect(codes(input({ caption: `${"a".repeat(2999)}#` }))).toEqual(["LINKEDIN_TEXT_TOO_LONG"]);
    expect(codes(input({ caption: "a".repeat(LINKEDIN_LIMITS.commentaryChars) }))).toEqual([]);
    expect(codes(input({ media: Array.from({ length: 21 }, (_, n) => image(n)) }))).toEqual([
      "LINKEDIN_TOO_MANY_IMAGES",
    ]);
    expect(codes(input({ media: [image(1), video()] }))).toEqual(["LINKEDIN_MIXED_MEDIA"]);
    expect(codes(input({ media: [video(), video({ mediaId: "vid-2" })] }))).toEqual([
      "LINKEDIN_TOO_MANY_VIDEOS",
    ]);
    expect(codes(input({ media: [image(1, { mime: "image/webp" })] }))).toEqual([
      "LINKEDIN_IMAGE_TYPE",
    ]);
    expect(codes(input({ media: [image(1, { width: 8000, height: 8000 })] }))).toEqual([
      "LINKEDIN_IMAGE_TOO_LARGE",
    ]);
    expect(codes(input({ media: [video({ mime: "video/quicktime" })] }))).toEqual([
      "LINKEDIN_VIDEO_TYPE",
    ]);
    expect(codes(input({ media: [video({ bytes: 1000 })] }))).toEqual(["LINKEDIN_VIDEO_SIZE"]);
    expect(codes(input({ media: [video({ durationS: 2 })] }))).toEqual(["LINKEDIN_VIDEO_DURATION"]);
  });

  it("en dry-run no llama a LinkedIn", async () => {
    const result = await withDryRun(createLinkedInPublisher()).publish(
      input({ media: [image(1)] }),
      context(),
    );
    expect(result).toMatchObject({ simulated: true });
    expect(await recorded()).toEqual([]);
  });
});

describe("borrar un post (DELETE /rest/posts/{urn})", () => {
  it("DELETE con X-RestLi-Method y el URN codificado; un 404 cuenta como borrado", async () => {
    const seen: Array<{ path: string; method: string | null }> = [];
    server.use(
      http.delete(`${API}/posts/*`, ({ request }) => {
        seen.push({
          path: new URL(request.url).pathname,
          method: request.headers.get("x-restli-method"),
        });
        return new HttpResponse(null, { status: seen.length === 1 ? 204 : 404 });
      }),
    );
    await deleteLinkedInPost({ accessToken: TOKEN, urn: POST_URN });
    await deleteLinkedInPost({ accessToken: TOKEN, urn: POST_URN });
    expect(seen).toEqual([
      { path: "/rest/posts/urn%3Ali%3Ashare%3A7380000000000000001", method: "DELETE" },
      { path: "/rest/posts/urn%3Ali%3Ashare%3A7380000000000000001", method: "DELETE" },
    ]);
  });

  it("un URN activity (el del enlace pegado) se borra a mano: LINKEDIN_DELETE_UNSUPPORTED sin llamar", async () => {
    const error = await caught(
      deleteLinkedInPost({ accessToken: TOKEN, urn: "urn:li:activity:7380000000000000001" }),
    );
    expect(isAppError(error) && error.code).toBe("LINKEDIN_DELETE_UNSUPPORTED");
    expect(await recorded()).toEqual([]);
  });

  it("un 401 al borrar sube como LINKEDIN_AUTH_INVALID", async () => {
    server.use(http.delete(`${API}/posts/*`, () => new HttpResponse(null, { status: 401 })));
    const error = await caught(
      createLinkedInApi()
        .deletePost(TOKEN, POST_URN)
        .then(() => undefined),
    );
    expect(error).toMatchObject({ code: "LINKEDIN_AUTH_INVALID" });
  });
});

describe("leer un medio de R2", () => {
  it("entero, o un tramo con Range (206), comprobando el largo; sin la URL en los errores", async () => {
    const ranges: Array<string | null> = [];
    server.use(
      http.get(`${R2}/*`, ({ request }) => {
        const range = request.headers.get("range");
        ranges.push(range);
        if (range === null) return new HttpResponse(new Uint8Array(10));
        return new HttpResponse(new Uint8Array(5), { status: 206 });
      }),
    );
    expect((await readMediaFromUrl(image(1), null)).byteLength).toBe(10);
    expect((await readMediaFromUrl(video(), { first: 10, last: 14 })).byteLength).toBe(5);
    const error = await caught(readMediaFromUrl(video(), { first: 0, last: 99 }));
    expect(error).toMatchObject({ code: "LINKEDIN_MEDIA_UNAVAILABLE", retriable: true });
    expect(errorText(error)).not.toContain("firma");
    expect(ranges).toEqual([null, "bytes=10-14", "bytes=0-99"]);
  });
});

describe("la versión de la API", () => {
  it(`LINKEDIN_API_VERSION (${LINKEDIN_API_VERSION}) no está a menos de 60 días de su cierre`, () => {
    const sunset = new Date(`${LINKEDIN_API_VERSION_SUNSET}T00:00:00Z`).getTime();
    expect(sunset - Date.now()).toBeGreaterThan(60 * 24 * 60 * 60 * 1000);
  });
});
