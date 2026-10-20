import {
  isAppError,
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
import { chunkPlan, chunkRanges } from "./content.js";
import {
  createTikTokPublisher,
  TIKTOK_INBOX_NOTE,
  type TikTokPublishNote,
  validateTikTokInput,
} from "./publisher.js";

// F9-T26: contratos del publisher de TikTok en modo *Upload* con msw. Ninguna petición sale a
// TikTok ni a R2: una sin handler falla el test (`usePlatformServer`).

const API = "https://open.tiktokapis.com";
const INIT = `${API}/v2/post/publish/inbox/video/init/`;
const STATUS = `${API}/v2/post/publish/status/fetch/`;
const UPLOAD = "https://open-upload.tiktokapis.com/upload/?upload_id=subida-secreta-123";
const R2 = "https://r2.test";
const TOKEN = "act.token-de-prueba";
const NEW_TOKEN = "act.token-renovado";
/** Trozos de 10 bytes en los tests (los reales son de 10 MiB). */
const CHUNK = 10;

const { server, recorded } = usePlatformServer();

const account: PlatformAccount = {
  id: "cuenta-tiktok",
  brokerId: "marca",
  platform: "tiktok",
  externalAccountId: "open-id-1",
  displayName: "AgentPey",
  status: "connected",
  tokenExpiresAt: null,
  meta: { openId: "open-id-1", scopes: ["video.upload"] },
  hasCredentials: true,
  createdAt: new Date("2026-10-20T12:00:00Z"),
  updatedAt: new Date("2026-10-20T12:00:00Z"),
};

/** Los bytes del video: `n` bytes con su posición (para revisar qué trozo llegó). */
const videoBytes = (n: number) => Uint8Array.from({ length: n }, (_, index) => index % 256);

const video = (bytes: number, overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
  mediaId: "vid-1",
  kind: "video",
  mime: "video/mp4",
  storagePath: "posts/p1/ig_reel/video.mp4",
  url: `${R2}/posts/p1/ig_reel/video.mp4?X-Amz-Signature=firma-r2`,
  bytes,
  width: 1080,
  height: 1920,
  durationS: 30,
  ...overrides,
});

const input = (media: PublishMediaItem[] = [video(25)]): PublishInput => ({
  publicationId: "pub-1",
  platform: "tiktok",
  format: "post",
  title: null,
  caption: "Un día en la oficina #agentpey",
  language: "es",
  media,
});

/** Un contexto en memoria con un proveedor de token que registra lo que se le pide. */
function context(progress: unknown = null) {
  const saved: unknown[] = [];
  const tokenCalls: Array<{ rejectedToken?: string }> = [];
  const ctx: PublishContext & { saved: unknown[]; tokenCalls: typeof tokenCalls } = {
    account,
    credentials: { accessToken: TOKEN, refreshToken: "rft.refresco" },
    accessToken: async (options) => {
      tokenCalls.push({
        ...(options?.rejectedToken === undefined ? {} : { rejectedToken: options.rejectedToken }),
      });
      return options?.rejectedToken === undefined ? TOKEN : NEW_TOKEN;
    },
    progress,
    saved,
    tokenCalls,
    async saveProgress(next) {
      saved.push(structuredClone(next));
      ctx.progress = next;
    },
  };
  return ctx;
}

/** R2 simulado: responde el trozo pedido con `Range` (206). */
function fakeR2(total: number, respond?: (range: string | null) => Response | undefined) {
  const bytes = videoBytes(total);
  server.use(
    http.get(`${R2}/posts/p1/ig_reel/video.mp4`, ({ request }) => {
      const range = request.headers.get("range");
      const custom = respond?.(range);
      if (custom !== undefined) return custom;
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "") ?? [];
      if (first === undefined || last === undefined)
        return new HttpResponse(bytes, { status: 200 });
      return new HttpResponse(bytes.slice(Number(first), Number(last) + 1), {
        status: 206,
        headers: { "content-range": `bytes ${first}-${last}/${total}` },
      });
    }),
  );
}

type TikTokFake = {
  init?: (request: Request, call: number) => Response | Promise<Response>;
  upload?: (request: Request, call: number) => Response | Promise<Response>;
  statuses?: string[];
  failReason?: string;
};

/** TikTok simulado: init, la subida (guarda cada trozo) y el estado (en el orden dado). */
function fakeTikTok(options: TikTokFake = {}) {
  const chunks: Array<{ range: string | null; type: string | null; bytes: number[] }> = [];
  const statuses = [...(options.statuses ?? ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"])];
  let inits = 0;
  let uploads = 0;
  let statusCalls = 0;
  server.use(
    http.post(INIT, async ({ request }) => {
      inits += 1;
      if (options.init !== undefined) return options.init(request, inits);
      return HttpResponse.json({
        data: { publish_id: "v_inbox_file~v2.123", upload_url: UPLOAD },
        error: { code: "ok", message: "", log_id: "log-1" },
      });
    }),
    http.put("https://open-upload.tiktokapis.com/upload/", async ({ request }) => {
      uploads += 1;
      if (options.upload !== undefined) {
        const custom = await options.upload(request.clone(), uploads);
        if (!custom.ok) return custom;
      }
      chunks.push({
        range: request.headers.get("content-range"),
        type: request.headers.get("content-type"),
        bytes: [...new Uint8Array(await request.arrayBuffer())],
      });
      return new HttpResponse(null, { status: 206 });
    }),
    http.post(STATUS, () => {
      statusCalls += 1;
      const status = statuses.length > 1 ? (statuses.shift() as string) : (statuses[0] as string);
      return HttpResponse.json({
        data: {
          status,
          ...(status === "FAILED"
            ? { fail_reason: options.failReason ?? "file_format_check_failed" }
            : {}),
          uploaded_bytes: 25,
        },
        error: { code: "ok", message: "", log_id: "log-2" },
      });
    }),
  );
  return {
    chunks,
    calls: () => ({ inits, uploads, statusCalls }),
  };
}

function publisherWith(notes: TikTokPublishNote[] = []) {
  return createTikTokPublisher({
    chunkBytes: CHUNK,
    pollDelaysMs: [0, 0, 0],
    sleep: async () => {},
    onNote: (note) => notes.push(note),
  });
}

const apiError = (code: string, status: number) =>
  HttpResponse.json(
    { data: {}, error: { code, message: "mensaje de TikTok", log_id: "log-err" } },
    { status },
  );

describe("chunkPlan", () => {
  it("hasta un trozo: uno solo del tamaño del video", () => {
    expect(chunkPlan(7, 10)).toEqual({ videoSize: 7, chunkSize: 7, totalChunks: 1 });
    expect(chunkPlan(10, 10)).toEqual({ videoSize: 10, chunkSize: 10, totalChunks: 1 });
  });

  it("de un trozo a menos de dos: uno solo, con chunk_size = el tamaño del video (el PUT lo lleva entero)", () => {
    expect(chunkPlan(15, 10)).toEqual({ videoSize: 15, chunkSize: 15, totalChunks: 1 });
    expect(chunkPlan(19, 10)).toEqual({ videoSize: 19, chunkSize: 19, totalChunks: 1 });
    expect(chunkRanges(chunkPlan(19, 10))).toEqual([{ index: 0, first: 0, last: 18 }]);
    const mib = 1024 * 1024;
    expect(chunkPlan(15 * mib)).toEqual({
      videoSize: 15 * mib,
      chunkSize: 15 * mib,
      totalChunks: 1,
    });
  });

  it("más grande: floor(tamaño / trozo) trozos, y el último se lleva el resto", () => {
    const plan = chunkPlan(25, 10);
    expect(plan).toEqual({ videoSize: 25, chunkSize: 10, totalChunks: 2 });
    expect(chunkRanges(plan)).toEqual([
      { index: 0, first: 0, last: 9 },
      { index: 1, first: 10, last: 24 },
    ]);
  });

  it("con los trozos reales (10 MiB), un reel de 95 MB va en 9 trozos dentro de los topes", () => {
    const size = 95 * 1024 * 1024;
    const plan = chunkPlan(size);
    const ranges = chunkRanges(plan);
    expect(plan.totalChunks).toBe(9);
    const last = ranges.at(-1);
    expect(last?.last).toBe(size - 1);
    expect((last?.last ?? 0) - (last?.first ?? 0) + 1).toBeLessThan(64 * 1024 * 1024);
  });
});

describe("validateTikTokInput", () => {
  it("acepta un video", () => {
    expect(validateTikTokInput(input())).toEqual({ ok: true });
  });

  it("sin video no va a TikTok (solo video, D16)", () => {
    const image: PublishMediaItem = { ...video(10), kind: "image", mime: "image/jpeg" };
    expect(validateTikTokInput(input([]))).toMatchObject({
      ok: false,
      issues: [{ code: "TIKTOK_VIDEO_REQUIRED" }],
    });
    expect(validateTikTokInput(input([image]))).toMatchObject({
      ok: false,
      issues: [{ code: "TIKTOK_VIDEO_REQUIRED" }],
    });
  });

  it("un video con imágenes, un formato raro, muy largo o un texto de más se rechazan", () => {
    const image: PublishMediaItem = { ...video(10), mediaId: "img", kind: "image" };
    expect(validateTikTokInput(input([video(10), image]))).toMatchObject({
      issues: [{ code: "TIKTOK_ONE_VIDEO_ONLY" }],
    });
    expect(validateTikTokInput(input([video(10, { mime: "video/x-msvideo" })]))).toMatchObject({
      issues: [{ code: "TIKTOK_VIDEO_FORMAT" }],
    });
    expect(validateTikTokInput(input([video(10, { durationS: 601 })]))).toMatchObject({
      issues: [{ code: "TIKTOK_VIDEO_TOO_LONG" }],
    });
    expect(validateTikTokInput({ ...input(), caption: "a".repeat(2201) })).toMatchObject({
      issues: [{ code: "TIKTOK_TEXT_TOO_LONG" }],
    });
  });
});

describe("createTikTokPublisher · publish (modo Upload, la bandeja)", () => {
  it("sube por trozos en orden y, al llegar a la bandeja, deja el traspaso a mano", async () => {
    fakeR2(25);
    const tiktok = fakeTikTok();
    const notes: TikTokPublishNote[] = [];
    const ctx = context();

    const outcome = await publisherWith(notes).publish(input(), ctx);

    expect(outcome).toEqual({
      handoff: "manual_confirm",
      simulated: false,
      notes: [TIKTOK_INBOX_NOTE],
    });
    // El init: FILE_UPLOAD con el plan, y el token del contexto (`ctx.accessToken`).
    const requests = await recorded();
    const init = requests.find((request) => request.url.href === INIT);
    expect(init?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init?.json).toEqual({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: 25,
        chunk_size: 10,
        total_chunk_count: 2,
      },
    });
    // Los trozos, en orden, con su Content-Range y los bytes leídos de R2 con Range.
    expect(tiktok.chunks).toEqual([
      { range: "bytes 0-9/25", type: "video/mp4", bytes: [...videoBytes(25).slice(0, 10)] },
      { range: "bytes 10-24/25", type: "video/mp4", bytes: [...videoBytes(25).slice(10, 25)] },
    ]);
    expect(
      requests.filter((request) => request.url.host === "r2.test").map((r) => r.method),
    ).toEqual(["GET", "GET"]);
    // PROCESSING_UPLOAD y después SEND_TO_USER_INBOX.
    expect(tiktok.calls()).toEqual({ inits: 1, uploads: 2, statusCalls: 2 });
    const status = requests.find((request) => request.url.href === STATUS);
    expect(status?.json).toEqual({ publish_id: "v_inbox_file~v2.123" });
    // El "enviando" antes de subir, y el publish_id como resultado.
    expect(ctx.saved).toEqual([
      { send: { startedAt: expect.any(String) } },
      {
        send: {
          startedAt: expect.any(String),
          result: { externalId: "v_inbox_file~v2.123", externalUrl: null },
        },
      },
    ]);
    expect(notes.map((note) => note.kind)).toEqual(["uploaded", "status"]);
    expect(JSON.stringify(notes)).not.toMatch(/subida-secreta|firma-r2|act\./);
  });

  it("un video de entre uno y dos trozos va en uno solo y el init lo anuncia con su tamaño", async () => {
    fakeR2(15);
    const tiktok = fakeTikTok({ statuses: ["SEND_TO_USER_INBOX"] });

    await publisherWith().publish(input([video(15)]), context());

    const init = (await recorded()).find((request) => request.url.href === INIT);
    expect(init?.json).toEqual({
      source_info: { source: "FILE_UPLOAD", video_size: 15, chunk_size: 15, total_chunk_count: 1 },
    });
    expect(tiktok.chunks.map((chunk) => chunk.range)).toEqual(["bytes 0-14/15"]);
  });

  it("un video chico va en un solo trozo", async () => {
    fakeR2(7);
    const tiktok = fakeTikTok({ statuses: ["SEND_TO_USER_INBOX"] });

    await publisherWith().publish(input([video(7)]), context());

    expect(tiktok.chunks).toEqual([
      { range: "bytes 0-6/7", type: "video/mp4", bytes: [...videoBytes(7)] },
    ]);
  });

  it("FAILED: borra el progreso (el reintento sube desde cero) y es TIKTOK_UPLOAD_FAILED", async () => {
    fakeR2(25);
    fakeTikTok({ statuses: ["FAILED"], failReason: "duration_check_failed" });
    const ctx = context();

    const error = await publisherWith()
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TIKTOK_UPLOAD_FAILED",
      retriable: false,
      details: { failReason: "duration_check_failed" },
    });
    expect(ctx.progress).toBeNull();
  });

  it("FAILED por un problema interno de TikTok es reintentable", async () => {
    fakeR2(25);
    fakeTikTok({ statuses: ["FAILED"], failReason: "internal" });

    await expect(publisherWith().publish(input(), context())).rejects.toMatchObject({
      code: "TIKTOK_UPLOAD_FAILED",
      retriable: true,
    });
  });

  it("si sigue en PROCESSING_UPLOAD: TIKTOK_STILL_PROCESSING con waitMinutes, y el reintento solo mira el estado", async () => {
    fakeR2(25);
    const first = fakeTikTok({ statuses: ["PROCESSING_UPLOAD"] });
    const ctx = context();

    const error = await publisherWith()
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TIKTOK_STILL_PROCESSING",
      retriable: true,
      details: { publishId: "v_inbox_file~v2.123", waitMinutes: 5 },
    });
    expect(first.calls()).toEqual({ inits: 1, uploads: 2, statusCalls: 3 });

    // El reintento, con el progreso guardado: no hace init ni sube; mira y llega a la bandeja.
    server.resetHandlers();
    const again = fakeTikTok({ statuses: ["SEND_TO_USER_INBOX"] });
    const retry = context(ctx.progress);
    await expect(publisherWith().publish(input(), retry)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });
    expect(again.calls()).toEqual({ inits: 0, uploads: 0, statusCalls: 1 });
  });

  it("el tope de 5 envíos pendientes por 24 h: TIKTOK_PENDING_LIMIT con waitMinutes, sin subir y sin dejar 'enviando'", async () => {
    fakeR2(25);
    const tiktok = fakeTikTok({
      init: () => apiError("spam_risk_too_many_pending_share", 403),
    });
    const ctx = context();

    const error = await publisherWith()
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TIKTOK_PENDING_LIMIT",
      retriable: false,
      details: { waitMinutes: 60, tiktokCode: "spam_risk_too_many_pending_share" },
    });
    expect(tiktok.calls()).toEqual({ inits: 1, uploads: 0, statusCalls: 0 });
    expect(ctx.progress).toBeNull();
    expect(errorText(error)).not.toContain("mensaje de TikTok");
  });

  it("un access_token_invalid en el init pide otro token (rejectedToken) y repite una vez", async () => {
    fakeR2(25);
    fakeTikTok({
      init: (_request, call) =>
        call === 1
          ? apiError("access_token_invalid", 401)
          : HttpResponse.json({
              data: { publish_id: "v_inbox_file~v2.123", upload_url: UPLOAD },
              error: { code: "ok" },
            }),
      statuses: ["SEND_TO_USER_INBOX"],
    });
    const ctx = context();

    await publisherWith().publish(input(), ctx);

    const inits = (await recorded()).filter((request) => request.url.href === INIT);
    expect(inits.map((request) => request.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${NEW_TOKEN}`,
    ]);
    expect(ctx.tokenCalls).toContainEqual({ rejectedToken: TOKEN });
  });

  it("si TikTok rechaza también el token renovado: TIKTOK_AUTH_INVALID, sin dejar 'enviando'", async () => {
    fakeR2(25);
    fakeTikTok({ init: () => apiError("access_token_invalid", 401) });
    const ctx = context();

    await expect(publisherWith().publish(input(), ctx)).rejects.toMatchObject({
      code: "TIKTOK_AUTH_INVALID",
    });
    expect(ctx.progress).toBeNull();
  });

  it("un corte en un trozo intermedio no deja dudoso: el video no quedó completo", async () => {
    fakeR2(25);
    const tiktok = fakeTikTok({
      upload: (_request, call) =>
        call === 1 ? new HttpResponse(null, { status: 503 }) : new HttpResponse(null),
    });
    const ctx = context();

    const error = await publisherWith()
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "TIKTOK_UNAVAILABLE", retriable: true });
    expect(tiktok.calls().uploads).toBe(1);
    expect(ctx.progress).toBeNull();
  });

  it("un 5xx en el último trozo es dudoso: OUTCOME_UNKNOWN, sin preguntar el estado", async () => {
    fakeR2(25);
    const tiktok = fakeTikTok({
      upload: (_request, call) =>
        call === 2 ? new HttpResponse(null, { status: 502 }) : new HttpResponse(null),
    });

    const error = await publisherWith()
      .publish(input(), context())
      .catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe(OUTCOME_UNKNOWN);
    expect(tiktok.calls()).toMatchObject({ uploads: 2, statusCalls: 0 });
  });

  it("un rechazo (4xx) del último trozo no es dudoso: TIKTOK_UPLOAD_REJECTED y sin 'enviando'", async () => {
    fakeR2(25);
    fakeTikTok({
      upload: (_request, call) =>
        call === 2 ? new HttpResponse(null, { status: 416 }) : new HttpResponse(null),
    });
    const ctx = context();

    await expect(publisherWith().publish(input(), ctx)).rejects.toMatchObject({
      code: "TIKTOK_UPLOAD_REJECTED",
      details: { httpStatus: 416, chunk: 1 },
    });
    expect(ctx.progress).toBeNull();
  });

  it("un 'enviando' sin resultado de un intento anterior es OUTCOME_UNKNOWN, sin llamar", async () => {
    const tiktok = fakeTikTok();

    const error = await publisherWith()
      .publish(input(), context({ send: { startedAt: "2026-10-20T12:00:00.000Z" } }))
      .catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe(OUTCOME_UNKNOWN);
    expect(tiktok.calls()).toEqual({ inits: 0, uploads: 0, statusCalls: 0 });
  });

  it("R2 que ignora Range no sube nada a medias: TIKTOK_MEDIA_UNAVAILABLE, sin la URL", async () => {
    fakeR2(25, () => new HttpResponse(videoBytes(25), { status: 200 }));
    const tiktok = fakeTikTok();
    const ctx = context();

    const error = await publisherWith()
      .publish(input(), ctx)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TIKTOK_MEDIA_UNAVAILABLE",
      details: { reason: "range_ignored" },
    });
    expect(tiktok.calls().uploads).toBe(0);
    expect(ctx.progress).toBeNull();
    expect(errorText(error)).not.toMatch(/firma-r2|subida-secreta|act\./);
  });

  it("una consulta del estado que TikTok rechaza deja dudoso lo que subió completo", async () => {
    fakeR2(25);
    fakeTikTok();
    server.use(http.post(STATUS, () => apiError("invalid_params", 400)));

    const error = await publisherWith()
      .publish(input(), context())
      .catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe(OUTCOME_UNKNOWN);
  });
});

describe("createTikTokPublisher · dry-run", () => {
  it("en dry-run no llama a TikTok ni a R2: traspaso simulado", async () => {
    const tiktok = fakeTikTok();
    const publisher = createTikTokPublisher();

    const outcome = await withDryRun(publisher).publish(input(), context());

    expect(outcome).toMatchObject({ handoff: "manual_confirm", simulated: true });
    expect(tiktok.calls()).toEqual({ inits: 0, uploads: 0, statusCalls: 0 });
    expect(await recorded()).toEqual([]);
  });

  it("es un publisher con paso manual, solo de posts", () => {
    const publisher = createTikTokPublisher();
    expect(publisher).toMatchObject({ platform: "tiktok", formats: ["post"], manualConfirm: true });
  });
});
