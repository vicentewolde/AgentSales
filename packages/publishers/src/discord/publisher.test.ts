import {
  DISCORD_VIDEO_MAX_BYTES,
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
import { DISCORD_LIMITS } from "./constants.js";
import {
  createDiscordPublisher,
  DISCORD_VIDEO_NOT_ATTACHED_NOTE,
  type DiscordPublishNote,
  neutralizeMassMentions,
  validateDiscordInput,
} from "./publisher.js";

// F9-T14: contratos del publisher de Discord con msw. Ninguna petición sale a Discord ni a R2: una
// sin handler falla el test (`usePlatformServer`).

const TOKEN = "tokenSecretoDelWebhook-123_abc";
const WEBHOOK_URL = `https://discord.com/api/webhooks/987654321/${TOKEN}`;
const EXECUTE = `https://discord.com/api/v10/webhooks/987654321/${TOKEN}`;
const R2 = "https://r2.test";
const MIB = 1024 * 1024;

const { server, recorded } = usePlatformServer();

const account: PlatformAccount = {
  id: "cuenta-discord",
  brokerId: "marca",
  platform: "discord",
  externalAccountId: "987654321",
  displayName: "AgentSales",
  status: "connected",
  tokenExpiresAt: null,
  meta: {
    webhookName: "AgentSales",
    guildId: "111",
    channelId: "222",
    connectedAt: "2026-10-20T12:00:00.000Z",
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

const video = (bytes: number): PublishMediaItem => ({
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
  platform: "discord",
  format: "post",
  title: null,
  caption: "Hola desde AgentPey",
  language: "es",
  media: [],
  ...overrides,
});

/** Un contexto en memoria: el progreso que guarda el intento, como lo haría el repositorio. */
function context(progress: unknown = null, overrides: Partial<PublishContext> = {}) {
  const saved: unknown[] = [];
  const ctx: PublishContext & { saved: unknown[] } = {
    account,
    credentials: { webhookUrl: WEBHOOK_URL },
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

/** Discord simulado: responde el mensaje creado, o lo que diga `respond`. */
function fakeDiscord(
  respond: (request: Request) => Response | Promise<Response> = () =>
    HttpResponse.json({ id: "555", channel_id: "222" }),
) {
  const bodies: Array<{ contentType: string | null; payload: unknown; files: File[] }> = [];
  server.use(
    http.post(EXECUTE, async ({ request }) => {
      const contentType = request.headers.get("content-type");
      if (contentType?.startsWith("multipart/form-data")) {
        const form = await request.clone().formData();
        const files = [...form.entries()]
          .filter(([name]) => name.startsWith("files["))
          .map(([, value]) => value as File);
        bodies.push({
          contentType,
          payload: JSON.parse(String(form.get("payload_json"))),
          files,
        });
      } else {
        bodies.push({ contentType, payload: await request.clone().json(), files: [] });
      }
      return respond(request);
    }),
    http.get(`${R2}/*`, ({ request }) => {
      const name = new URL(request.url).pathname.split("/").pop() ?? "";
      return new HttpResponse(new TextEncoder().encode(`bytes de ${name}`), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );
  return bodies;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("se esperaba un error");
}

const noSleep = async () => {};

describe("createDiscordPublisher: publicar", () => {
  it("texto e imágenes: multipart con payload_json, menciones apagadas, ?wait=true y v10; devuelve el id y el enlace", async () => {
    const bodies = fakeDiscord();
    const publisher = createDiscordPublisher();
    const ctx = context();

    const result = await publisher.publish(input({ media: [image(1), image(2)] }), ctx);

    expect(result).toEqual({
      externalId: "555",
      externalUrl: "https://discord.com/channels/111/222/555",
      simulated: false,
    });
    const [body] = bodies;
    expect(body?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(body?.payload).toEqual({
      content: "Hola desde AgentPey",
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: "imagen-1.jpg" },
        { id: 1, filename: "imagen-2.jpg" },
      ],
    });
    expect(body?.files.map((file) => [file.name, file.type])).toEqual([
      ["imagen-1.jpg", "image/jpeg"],
      ["imagen-2.jpg", "image/jpeg"],
    ]);
    expect(await body?.files[0]?.text()).toBe("bytes de foto-1.jpg");
    const discord = (await recorded()).filter((request) => request.url.host === "discord.com");
    expect(discord).toHaveLength(1);
    expect(discord[0]?.url.searchParams.get("wait")).toBe("true");
    expect(discord[0]?.url.pathname).toBe(`/api/v10/webhooks/987654321/${TOKEN}`);
    // "Enviando" antes de llamar y el resultado después (ADR-0029 punto 8).
    expect(ctx.saved).toEqual([
      { send: { startedAt: expect.any(String) } },
      {
        send: {
          startedAt: expect.any(String),
          result: { externalId: "555", externalUrl: "https://discord.com/channels/111/222/555" },
        },
      },
    ]);
    expect(JSON.stringify({ result, saved: ctx.saved })).not.toContain(TOKEN);
  });

  it("solo texto va como JSON; el servidor de la respuesta manda sobre el guardado, y sin ninguno no hay enlace", async () => {
    const bodies = fakeDiscord(() =>
      HttpResponse.json({ id: "556", channel_id: "333", guild_id: "999" }),
    );
    const publisher = createDiscordPublisher();

    const withGuild = await publisher.publish(input(), context());
    expect(bodies[0]?.contentType).toBe("application/json");
    expect(bodies[0]?.payload).toEqual({
      content: "Hola desde AgentPey",
      allowed_mentions: { parse: [] },
    });
    expect(withGuild.externalUrl).toBe("https://discord.com/channels/999/333/556");

    fakeDiscord(() => HttpResponse.json({ id: "557", channel_id: "333" }));
    const noGuild = await publisher.publish(
      input(),
      context(null, { account: { ...account, meta: { ...account.meta, guildId: null } } }),
    );
    expect(noGuild).toMatchObject({ externalId: "557", externalUrl: null });
  });

  it("@everyone y @here quedan neutralizados en el texto (también pegados a otra palabra) y allowed_mentions va vacío", async () => {
    const bodies = fakeDiscord();
    await createDiscordPublisher().publish(
      input({ caption: "Hola @everyone y @Here; correo a@everyone.cl" }),
      context(),
    );
    const payload = bodies[0]?.payload as { content: string; allowed_mentions: unknown };
    expect(payload.content).toBe("Hola @​everyone y @​Here; correo a@​everyone.cl");
    expect(payload.content).not.toMatch(/@(everyone|here)/i);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(neutralizeMassMentions("@here")).toBe("@​here");
  });

  it("un progreso con el resultado guardado lo devuelve sin llamar ni bajar medios", async () => {
    fakeDiscord();
    const stored = { externalId: "444", externalUrl: "https://discord.com/channels/111/222/444" };
    const ctx = context({ send: { startedAt: "2026-10-20T12:00:00.000Z", result: stored } });

    const result = await createDiscordPublisher().publish(input({ media: [image(1)] }), ctx);

    expect(result).toEqual({ ...stored, simulated: false });
    expect(await recorded()).toEqual([]);
  });

  it("sin la URL del webhook en las credenciales, o con una que no es de un webhook, es CREDENTIALS_INVALID sin llamar ni dejar 'enviando'", async () => {
    fakeDiscord();
    for (const credentials of [
      { accessToken: "no-es-un-webhook" },
      { webhookUrl: "https://example.com/api/webhooks/1/secretoGuardado" },
      { webhookUrl: "no es un webhook" },
    ]) {
      const ctx = context(null, { credentials: credentials as PublishContext["credentials"] });
      const error = await caught(createDiscordPublisher().publish(input(), ctx));
      expect(error).toMatchObject({ code: "CREDENTIALS_INVALID", retriable: false });
      expect(errorText(error)).not.toContain("secretoGuardado");
      expect(ctx.saved).toEqual([]);
    }
    expect(await recorded()).toEqual([]);
  });
});

describe("createDiscordPublisher: errores y resultado dudoso", () => {
  it("un 429 corto se espera (retry_after) y se repite en el mismo envío: un solo mensaje", async () => {
    let calls = 0;
    fakeDiscord(() => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json(
            { message: "You are being rate limited.", retry_after: 1.5, global: false },
            { status: 429, headers: { "Retry-After": "2" } },
          )
        : HttpResponse.json({ id: "558", channel_id: "222" });
    });
    const waits: number[] = [];
    const notes: DiscordPublishNote[] = [];
    const publisher = createDiscordPublisher({
      sleep: async (ms) => {
        waits.push(ms);
      },
      onNote: (note) => notes.push(note),
    });

    const result = await publisher.publish(input(), context());

    expect(result.externalId).toBe("558");
    expect(calls).toBe(2);
    expect(waits).toEqual([1500]);
    expect(notes).toEqual([
      { publicationId: "pub-1", kind: "rate_limited_wait", retryAfterS: 1.5, attempt: 1 },
    ]);
  });

  it("un 429 largo es DISCORD_RATE_LIMITED reintentable con waitMinutes, y quita el 'enviando'", async () => {
    fakeDiscord(() =>
      HttpResponse.json({ message: "límite", retry_after: 125.2, global: false }, { status: 429 }),
    );
    const ctx = context();
    const error = await caught(createDiscordPublisher({ sleep: noSleep }).publish(input(), ctx));

    expect(error).toMatchObject({
      code: "DISCORD_RATE_LIMITED",
      retriable: true,
      details: { httpStatus: 429, retryAfterS: 125.2, waitMinutes: 3 },
    });
    expect(ctx.saved).toEqual([{ send: { startedAt: expect.any(String) } }, null]);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("un 404 del webhook es DISCORD_WEBHOOK_NOT_FOUND, no reintentable, con el consejo de reconectar y sin repetir", async () => {
    fakeDiscord(() =>
      HttpResponse.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 }),
    );
    const ctx = context();
    const error = await caught(createDiscordPublisher({ sleep: noSleep }).publish(input(), ctx));

    expect(error).toMatchObject({
      code: "DISCORD_WEBHOOK_NOT_FOUND",
      retriable: false,
      details: { httpStatus: 404, discordCode: 10015 },
    });
    expect((error as Error).message).toContain("vuelve a conectar");
    expect(ctx.saved.at(-1)).toBeNull();
    expect((await recorded()).filter((r) => r.url.host === "discord.com")).toHaveLength(1);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("401 y 403 no se reintentan ni se repiten (muchos bloquean la IP)", async () => {
    for (const [status, code, expected] of [
      [401, 50027, "DISCORD_WEBHOOK_INVALID"],
      [403, 50013, "DISCORD_FORBIDDEN"],
    ] as const) {
      let calls = 0;
      fakeDiscord(() => {
        calls += 1;
        return HttpResponse.json({ message: "no", code }, { status });
      });
      const error = await caught(
        createDiscordPublisher({ sleep: noSleep }).publish(input(), context()),
      );
      expect(error).toMatchObject({ code: expected, retriable: false });
      expect(calls).toBe(1);
      expect(errorText(error)).not.toContain(TOKEN);
    }
  });

  it("un corte después de 'enviando' es OUTCOME_UNKNOWN; el reintento no reenvía ni baja medios", async () => {
    let calls = 0;
    fakeDiscord(() => {
      calls += 1;
      return HttpResponse.error();
    });
    const ctx = context();
    const publisher = createDiscordPublisher({ sleep: noSleep });

    const first = await caught(publisher.publish(input({ media: [image(1)] }), ctx));
    expect(first).toMatchObject({ code: OUTCOME_UNKNOWN, retriable: false });
    expect(isAppError(first) && first.details).toEqual({ reason: "send_failed" });
    // Quedó "enviando" sin resultado.
    expect(ctx.progress).toEqual({ send: { startedAt: expect.any(String) } });
    const before = (await recorded()).length;

    const second = await caught(publisher.publish(input({ media: [image(1)] }), ctx));
    expect(second).toMatchObject({ code: OUTCOME_UNKNOWN, details: { reason: "interrupted" } });
    expect(calls).toBe(1);
    expect((await recorded()).length).toBe(before);
    expect(errorText(first)).not.toContain(TOKEN);
  });

  it("un 5xx o un 2xx sin el mensaje también son dudosos (el mensaje pudo crearse)", async () => {
    for (const respond of [
      () => HttpResponse.json({ message: "error" }, { status: 502 }),
      () => HttpResponse.json({ ok: true }),
      () => new HttpResponse("no es json", { status: 200 }),
    ]) {
      fakeDiscord(respond);
      const ctx = context();
      const error = await caught(createDiscordPublisher({ sleep: noSleep }).publish(input(), ctx));
      expect(error).toMatchObject({ code: OUTCOME_UNKNOWN });
      expect(ctx.progress).toEqual({ send: { startedAt: expect.any(String) } });
    }
  });

  it("un 400 de Discord (filtro de enlaces, archivo grande) no es dudoso: no salió", async () => {
    for (const [body, expected] of [
      [{ message: "blocked", code: 240000 }, "DISCORD_REQUEST_REJECTED"],
      [{ message: "too large", code: 40005 }, "DISCORD_FILE_TOO_LARGE"],
    ] as const) {
      fakeDiscord(() => HttpResponse.json(body, { status: 400 }));
      const ctx = context();
      const error = await caught(createDiscordPublisher({ sleep: noSleep }).publish(input(), ctx));
      expect(error).toMatchObject({ code: expected, retriable: false });
      expect(ctx.saved.at(-1)).toBeNull();
    }
  });

  it("un medio que no se puede bajar es DISCORD_MEDIA_UNAVAILABLE reintentable, sin 'enviando' ni llamar a Discord", async () => {
    fakeDiscord();
    server.use(http.get(`${R2}/*`, () => new HttpResponse(null, { status: 503 })));
    const ctx = context();
    const error = await caught(createDiscordPublisher().publish(input({ media: [image(1)] }), ctx));
    expect(error).toMatchObject({ code: "DISCORD_MEDIA_UNAVAILABLE", retriable: true });
    expect(ctx.saved).toEqual([]);
    expect((await recorded()).filter((r) => r.url.host === "discord.com")).toEqual([]);
    expect(errorText(error)).not.toContain("X-Amz-Signature");
  });
});

describe("createDiscordPublisher: video (D8)", () => {
  it("un video que cabe (hasta 20 MiB) se adjunta", async () => {
    const bodies = fakeDiscord();
    const result = await createDiscordPublisher().publish(
      input({ media: [video(5 * MIB)] }),
      context(),
    );
    expect(result.notes).toBeUndefined();
    expect(bodies[0]?.files.map((file) => [file.name, file.type])).toEqual([
      ["video-1.mp4", "video/mp4"],
    ]);
  });

  it("el video liviano para Discord (discord_video, F9.5 D8) de hasta 19 MiB se baja de su ruta y se adjunta", async () => {
    const bodies = fakeDiscord();
    const light: PublishMediaItem = {
      ...video(DISCORD_VIDEO_MAX_BYTES),
      mediaId: "vid-discord",
      storagePath: "posts/p1/processed/discord_video/video.mp4",
      url: `${R2}/posts/p1/processed/discord_video/video.mp4?X-Amz-Signature=firma-discord`,
    };
    const result = await createDiscordPublisher().publish(input({ media: [light] }), context());
    expect(result.notes).toBeUndefined();
    expect(bodies[0]?.files.map((file) => [file.name, file.type])).toEqual([
      ["video-1.mp4", "video/mp4"],
    ]);
    expect(
      (await recorded())
        .filter((r) => r.url.host === "r2.test")
        .map((r) => r.url.pathname.split("/").at(-2)),
    ).toEqual(["discord_video"]);
  });

  it("un video que no cabe no se baja ni se adjunta: sale el texto con la nota en la bitácora", async () => {
    const bodies = fakeDiscord();
    const notes: DiscordPublishNote[] = [];
    const big = video(DISCORD_LIMITS.fileBytes + 1);
    const result = await createDiscordPublisher({ onNote: (note) => notes.push(note) }).publish(
      input({ media: [big] }),
      context(),
    );

    expect(result.notes).toEqual([DISCORD_VIDEO_NOT_ATTACHED_NOTE]);
    expect(bodies[0]?.contentType).toBe("application/json");
    expect((await recorded()).filter((r) => r.url.host === "r2.test")).toEqual([]);
    expect(notes).toEqual([
      { publicationId: "pub-1", kind: "video_not_attached", mediaId: "vid-1", bytes: big.bytes },
    ]);
    // En `dry-run`, la misma nota sale de preflight, sin llamar a nada.
    const simulated = await withDryRun(createDiscordPublisher()).publish(
      input({ media: [big] }),
      context(),
    );
    expect(simulated).toMatchObject({ simulated: true, notes: [DISCORD_VIDEO_NOT_ATTACHED_NOTE] });
  });

  it("validate: sin texto y con un video que no cabe, el mensaje quedaría vacío", () => {
    expect(
      validateDiscordInput(input({ caption: " ", media: [video(DISCORD_LIMITS.fileBytes + 1)] })),
    ).toMatchObject({ ok: false, issues: [{ code: "DISCORD_EMPTY_MESSAGE" }] });
    expect(validateDiscordInput(input({ caption: "", media: [video(MIB)] }))).toEqual({
      ok: true,
    });
  });
});

describe("validateDiscordInput", () => {
  it("rechaza más de 2.000 caracteres (contados ya neutralizados), más de 10 archivos o una imagen de más de 20 MiB", () => {
    expect(validateDiscordInput(input({ caption: "a".repeat(2000) }))).toEqual({ ok: true });
    const issues = (value: PublishInput) => {
      const validation = validateDiscordInput(value);
      return validation.ok ? [] : validation.issues.map((issue) => issue.code);
    };
    expect(issues(input({ caption: "a".repeat(2001) }))).toEqual(["DISCORD_TEXT_TOO_LONG"]);
    expect(issues(input({ caption: `${"a".repeat(1991)}@everyone` }))).toEqual([
      "DISCORD_TEXT_TOO_LONG",
    ]);
    expect(issues(input({ media: Array.from({ length: 11 }, (_, n) => image(n)) }))).toEqual([
      "DISCORD_TOO_MANY_FILES",
    ]);
    expect(issues(input({ media: [image(1, DISCORD_LIMITS.fileBytes + 1)] }))).toEqual([
      "DISCORD_FILE_TOO_LARGE",
    ]);
  });

  it("publish revisa el input antes de nada (PUBLISH_INPUT_INVALID)", async () => {
    fakeDiscord();
    const ctx = context();
    const error = await caught(
      createDiscordPublisher().publish(input({ caption: "a".repeat(2001) }), ctx),
    );
    expect(error).toMatchObject({ code: "PUBLISH_INPUT_INVALID" });
    expect(ctx.saved).toEqual([]);
  });
});
