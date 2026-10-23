import { describe, expect, it } from "vitest";
import { parseChileTime } from "../chile-time.js";
import type { Language, Platform, PostKind, PostStatus } from "../enums.js";
import { isAppError } from "../errors.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { postSubject } from "../subject.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import {
  approvePostWeek,
  defaultWeekDay,
  getPostWeek,
  postWeekRange,
  weekProblemKind,
} from "./approve-week.js";
import { schedulePublication, unschedulePublication } from "./schedule-publications.js";

// «Aprobar la semana» (F9.5-T27): aprueba y programa de una vez las ideas aceptadas de una semana,
// cada una a su fecha, y dice lo que no se pudo. Nunca publica en el momento.

const ADMIN = { id: "admin", role: "admin" as const, brokerId: null };
/** Jueves 22 de octubre de 2026 al mediodía de Chile: la semana siguiente empieza el lunes 26. */
const NOW = parseChileTime("2026-10-22 12:00");
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (isAppError(error) ? error.code : error),
  );

type PostSetup = {
  topic: string;
  at: string | null;
  kind?: PostKind;
  status?: PostStatus;
  /** Los textos que deja la corrida; por defecto, uno de LinkedIn en español. */
  texts?: { platform: Platform; language?: Language; body?: string }[];
  /** Con una foto procesada (por defecto, sin medios). */
  image?: boolean;
  platforms?: Platform[];
};

async function setup({ accounts = ["linkedin", "x"] as Platform[] } = {}) {
  const broker = contentBrokerFixture({ kind: "brand" });
  const other = contentBrokerFixture({ id: "otra-marca", slug: "otra", kind: "brand" });
  const brokers = createInMemoryBrokerRepository([broker, other]);
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const { contents, contentRuns } = createInMemoryContentRepositories();
  const publications = createInMemoryPublicationRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const listings = createInMemoryListingRepository();
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  const repos: PostLockedRepositories = {
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const postLock = createInMemoryPostLock(repos);
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  });
  for (const platform of accounts) {
    await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform,
      externalAccountId: `cuenta-${platform}`,
      displayName: `@agentpey-${platform}`,
      tokenExpiresAt: null,
      meta: {},
      credentials:
        platform === "discord"
          ? { webhookUrl: "https://discord.com/api/webhooks/123456/token-webhook-prueba" }
          : platform === "x" || platform === "tiktok"
            ? { accessToken: "token-prueba", refreshToken: "refresh-prueba" }
            : { accessToken: "token-prueba" },
    });
  }

  const addPost = async (options: PostSetup) => {
    const post = await posts.create({
      brokerId: broker.id,
      topic: options.topic,
      kind: options.kind ?? "text",
      status: options.status ?? "draft",
      plannedAt: options.at === null ? null : parseChileTime(options.at),
      ...(options.platforms === undefined ? {} : { platforms: options.platforms as never }),
    });
    if (options.image === true) {
      const original = await media.create({
        listingId: null,
        postId: post.id,
        brokerId: broker.id,
        kind: "image",
        storagePath: `posts/${post.id}/original/foto.jpg`,
        mime: "image/jpeg",
        bytes: 10,
        checksum: `sha-${post.id}`,
        sortOrder: 0,
        isCover: false,
      });
      await media.upsertDerivative({
        role: "processed",
        variant: "ig_4x5",
        parentMediaId: original.id,
        postId: post.id,
        brokerId: broker.id,
        kind: "image",
        storagePath: `posts/${post.id}/ig_4x5/foto.jpg`,
        mime: "image/jpeg",
        bytes: 8,
        checksum: `sha-${post.id}-4x5`,
        width: 1080,
        height: 1350,
        durationS: null,
      });
    }
    const texts = options.texts ?? [{ platform: "linkedin" }];
    if (texts.length > 0) {
      const run = await contentRuns.create({ postId: post.id, texts: true });
      await contentRuns.markRunning(run.id);
      await contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: texts.map((text) => ({
          platform: text.platform,
          language: text.language ?? "es",
          title: null,
          body: text.body ?? `Texto en ${text.language ?? "es"} para ${text.platform}`,
          hashtags: ["#agentpey"],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "social-v1",
          rawOutput: null,
        })),
      });
    }
    return post;
  };

  const deps = {
    brokers,
    posts,
    contents,
    contentRuns,
    media,
    publications,
    editorialProfiles,
    listings,
    fieldDefinitions: createInMemoryFieldDefinitionRepository([]),
    postReview: { posts, editorialProfiles },
    lock,
    postLock,
    now: () => NOW,
  };
  const ofPost = (postId: string) =>
    publications.all().filter(({ subject }) => subject.kind === "post" && subject.id === postId);
  return { broker, other, deps, addPost, publications, ofPost, contents, posts };
}

describe("postWeekRange", () => {
  it("da el lunes y el domingo de la semana de cualquier día, en hora de Chile", () => {
    const range = postWeekRange("2026-10-29");
    expect(range.week).toBe("2026-10-26");
    expect(range.lastDay).toBe("2026-11-01");
    expect(range.from).toEqual(parseChileTime("2026-10-26 00:00"));
    expect(range.to).toEqual(parseChileTime("2026-11-02 00:00"));
  });

  it("un día mal escrito o que no existe es WEEK_INVALID", () => {
    for (const day of ["2026-13-01", "2026-02-30", "26-10-2026", ""]) {
      expect(() => postWeekRange(day)).toThrowError(
        expect.objectContaining({ code: "WEEK_INVALID" }),
      );
    }
  });
});

describe("defaultWeekDay", () => {
  it("sin día, la semana de mañana: un domingo da la semana que empieza", () => {
    expect(postWeekRange(defaultWeekDay(NOW)).week).toBe("2026-10-19");
    expect(postWeekRange(defaultWeekDay(parseChileTime("2026-10-25 20:00"))).week).toBe(
      "2026-10-26",
    );
  });
});

describe("approvePostWeek", () => {
  it("aprueba y programa cada post aceptado de la semana a su fecha, sin publicar nada ahora", async () => {
    const s = await setup();
    const first = await s.addPost({ topic: "Lunes", at: "2026-10-26 10:00" });
    const second = await s.addPost({
      topic: "Miércoles",
      at: "2026-10-28 18:30",
      texts: [{ platform: "linkedin" }, { platform: "x" }],
    });
    const result = await approvePostWeek(s.deps, ADMIN, {
      brokerId: s.broker.id,
      day: "2026-10-27",
      dryRun: true,
      by: "operator",
    });

    expect(result.week).toBe("2026-10-26");
    expect(result.posts.map((post) => post.topic)).toEqual(["Lunes", "Miércoles"]);
    expect(result.posts.every((post) => post.problems.length === 0)).toBe(true);
    expect(result.posts[1]?.scheduled.map((row) => row.platform)).toEqual(["x", "linkedin"]);
    for (const [post, at] of [
      [first, "2026-10-26 10:00"],
      [second, "2026-10-28 18:30"],
    ] as const) {
      const own = s.ofPost(post.id);
      expect(own.length).toBeGreaterThan(0);
      for (const publication of own) {
        expect(publication.status).toBe("scheduled");
        expect(publication.scheduledAt).toEqual(parseChileTime(at));
        expect(publication.dryRun).toBe(true);
      }
    }
    // Nada en `publishing` ni publicado: programar no encola ni publica.
    expect(
      s.publications.all().some((p) => p.status === "publishing" || p.status === "published"),
    ).toBe(false);
    expect((await s.posts.get(first.id))?.status).toBe("ready");
  });

  it("en vivo programa en vivo: el modo es el que pone quien llama (el de la marca)", async () => {
    const s = await setup();
    const post = await s.addPost({ topic: "Lunes", at: "2026-10-26 10:00" });
    const r = await approvePostWeek(s.deps, ADMIN, {
      brokerId: s.broker.id,
      day: "2026-10-26",
      dryRun: false,
      by: "operator",
    });
    expect(r.posts[0]?.problems).toEqual([]);
    expect(s.ofPost(post.id).map((p) => [p.status, p.dryRun])).toEqual([["scheduled", false]]);
  });

  it("dice lo que no pudo, post por post y red por red, sin cortar el resto", async () => {
    const s = await setup();
    const tooLong = "a".repeat(400);
    const mixed = await s.addPost({
      topic: "Texto largo en X",
      at: "2026-10-26 10:00",
      texts: [{ platform: "linkedin" }, { platform: "x", body: tooLong }],
    });
    const noImage = await s.addPost({ topic: "Sin imagen", at: "2026-10-27 10:00", kind: "image" });
    const noAccount = await s.addPost({
      topic: "Discord sin cuenta",
      at: "2026-10-28 10:00",
      texts: [{ platform: "discord" }],
    });
    const noTexts = await s.addPost({ topic: "Sin textos", at: "2026-10-29 10:00", texts: [] });
    await s.addPost({ topic: "Idea sin decidir", at: "2026-10-30 10:00", status: "idea" });
    const nextWeek = await s.addPost({ topic: "Otra semana", at: "2026-11-03 10:00" });

    const result = await approvePostWeek(s.deps, ADMIN, {
      brokerId: s.broker.id,
      day: "2026-10-26",
      dryRun: true,
      by: "operator",
    });
    const of = (postId: string) => result.posts.find((post) => post.postId === postId);

    // X con errores no se aprueba, LinkedIn sí y queda programado.
    expect(of(mixed.id)?.problems).toEqual([
      expect.objectContaining({ platform: "x", language: "es", kind: "text_errors" }),
    ]);
    expect(of(mixed.id)?.scheduled.map((row) => row.platform)).toEqual(["linkedin"]);
    // Sin la imagen: el texto queda aprobado (T21) y no se programa.
    expect(of(noImage.id)?.approved).toEqual([{ platform: "linkedin", language: "es" }]);
    expect(of(noImage.id)?.problems.map((p) => [p.platform, p.kind])).toEqual([
      ["linkedin", "media_missing"],
    ]);
    expect(s.ofPost(noImage.id)).toEqual([]);
    // Sin la cuenta: aprobado, sin programar.
    expect(of(noAccount.id)?.problems.map((p) => [p.platform, p.kind])).toEqual([
      ["discord", "account_missing"],
    ]);
    expect(of(noTexts.id)?.problems.map((p) => p.kind)).toEqual(["no_texts"]);
    // La idea sin aceptar se cuenta, pero no se toca; la otra semana tampoco.
    expect(result.ideas).toBe(1);
    expect(result.posts.map((post) => post.topic)).not.toContain("Idea sin decidir");
    expect(result.posts.map((post) => post.postId)).not.toContain(nextWeek.id);
    expect(s.ofPost(nextWeek.id)).toEqual([]);
  });

  it("un post cuya fecha ya pasó no se programa (date), y nada se publica en el momento", async () => {
    const s = await setup();
    const past = await s.addPost({ topic: "Ayer", at: "2026-10-21 10:00" });
    const soon = await s.addPost({ topic: "En un minuto", at: "2026-10-22 12:01" });
    const later = await s.addPost({ topic: "El sábado", at: "2026-10-24 10:00" });
    const result = await approvePostWeek(s.deps, ADMIN, {
      brokerId: s.broker.id,
      day: "2026-10-22",
      dryRun: false,
      by: "operator",
    });
    const kinds = (postId: string) =>
      result.posts.find((post) => post.postId === postId)?.problems.map((p) => p.code);
    expect(kinds(past.id)).toEqual(["SCHEDULE_TOO_SOON"]);
    expect(kinds(soon.id)).toEqual(["SCHEDULE_TOO_SOON"]);
    expect(kinds(later.id)).toEqual([]);
    // Las dos de esta semana que ya pasaron quedan aprobadas y sin publicaciones en curso.
    for (const id of [past.id, soon.id]) {
      expect(s.ofPost(id).every((p) => p.status === "approved" && p.scheduledAt === null)).toBe(
        true,
      );
    }
  });

  it("repetirlo no cambia nada: lo programado sigue a la misma hora, sin duplicar", async () => {
    const s = await setup();
    const post = await s.addPost({
      topic: "Lunes",
      at: "2026-10-26 10:00",
      texts: [{ platform: "linkedin" }, { platform: "x" }],
    });
    const params = {
      brokerId: s.broker.id,
      day: "2026-10-26",
      dryRun: true,
      by: "operator" as const,
    };
    await approvePostWeek(s.deps, ADMIN, params);
    const before = s.ofPost(post.id).map((p) => [p.id, p.status, p.scheduledAt?.toISOString()]);
    const again = await approvePostWeek(s.deps, ADMIN, params);
    expect(again.posts[0]?.problems).toEqual([]);
    expect(again.posts[0]?.kept.map((kept) => [kept.platform, kept.status])).toEqual([
      ["x", "scheduled"],
      ["linkedin", "scheduled"],
    ]);
    expect(s.ofPost(post.id).map((p) => [p.id, p.status, p.scheduledAt?.toISOString()])).toEqual(
      before,
    );
  });

  it("no pisa lo que hizo el operador: la hora movida, la fallida y la desprogramada quedan igual", async () => {
    const s = await setup({ accounts: ["linkedin", "x", "discord"] });
    const post = await s.addPost({
      topic: "Lunes",
      at: "2026-10-26 10:00",
      texts: [{ platform: "x" }, { platform: "linkedin" }, { platform: "discord" }],
    });
    const params = {
      brokerId: s.broker.id,
      day: "2026-10-26",
      dryRun: true,
      by: "operator" as const,
    };
    await approvePostWeek(s.deps, ADMIN, params);
    const of = (platform: Platform) => {
      const found = s.ofPost(post.id).find((publication) => publication.platform === platform);
      if (found === undefined) throw new Error(`sin publicación de ${platform}`);
      return found;
    };
    // X: el operador la movió a las 18:00. LinkedIn: la desprogramó. Discord: falló.
    const moved = parseChileTime("2026-10-26 18:00");
    await schedulePublication(s.deps, {
      publicationId: of("x").id,
      at: moved,
      dryRun: true,
      actor: "operator",
    });
    await unschedulePublication(s.deps, { publicationId: of("linkedin").id, actor: "operator" });
    await s.deps.postLock.run(post.id, async ({ publications }) => {
      const id = of("discord").id;
      await publications.transition(
        id,
        { from: "scheduled", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
        { actor: "system" },
      );
      await publications.transition(id, { from: "publishing", to: "failed" }, { actor: "system" });
    });

    const again = await approvePostWeek(s.deps, ADMIN, params);
    const result = again.posts[0];
    expect(result?.scheduled).toEqual([]);
    expect(result?.problems).toEqual([]);
    expect(result?.kept.map((kept) => [kept.platform, kept.status, kept.at])).toEqual([
      ["x", "scheduled", moved],
      ["linkedin", "unscheduled", null],
      ["discord", "failed", null],
    ]);
    expect(result?.kept.find((kept) => kept.platform === "x")?.message).toContain(
      "2026-10-26 18:00",
    );
    expect(result?.kept.find((kept) => kept.platform === "discord")?.command).toBe(
      `pnpm -s cli publications retry ${of("discord").id}`,
    );
    expect(result?.kept.find((kept) => kept.platform === "linkedin")?.command).toContain(
      `schedule --publication ${of("linkedin").id}`,
    );
    expect([of("x").status, of("x").scheduledAt]).toEqual(["scheduled", moved]);
    expect([of("linkedin").status, of("linkedin").scheduledAt]).toEqual(["approved", null]);
    expect(of("discord").status).toBe("failed");
  });

  it("lo de otra marca no existe para un corredor, y sin la marca es BROKER_NOT_FOUND", async () => {
    const s = await setup();
    const broker = { id: "u1", role: "broker" as const, brokerId: s.other.id };
    const params = { day: "2026-10-26", dryRun: true, by: "operator" as const };
    expect(
      await caught(approvePostWeek(s.deps, broker, { ...params, brokerId: s.broker.id })),
    ).toBe("BROKER_NOT_FOUND");
    expect(await caught(approvePostWeek(s.deps, ADMIN, { ...params, brokerId: "no-existe" }))).toBe(
      "BROKER_NOT_FOUND",
    );
    expect(
      await caught(getPostWeek(s.deps, broker, { brokerId: s.broker.id, day: "2026-10-26" })),
    ).toBe("BROKER_NOT_FOUND");
  });
});

describe("getPostWeek", () => {
  it("trae los posts aceptados de la semana, por fecha, con sus textos y su revisión", async () => {
    const s = await setup();
    const later = await s.addPost({ topic: "Jueves", at: "2026-10-29 10:00" });
    const earlier = await s.addPost({
      topic: "Martes",
      at: "2026-10-27 10:00",
      texts: [{ platform: "x" }],
    });
    await s.addPost({ topic: "Idea", at: "2026-10-28 10:00", status: "idea" });
    await s.addPost({ topic: "Sin fecha", at: null });
    const week = await getPostWeek(s.deps, ADMIN, { brokerId: s.broker.id, day: "2026-10-30" });
    expect(week.posts.map((item) => item.post.id)).toEqual([earlier.id, later.id]);
    expect(week.posts[0]?.contents.map((item) => item.content.platform)).toEqual(["x"]);
    expect(week.ideas).toBe(1);
    // Solo lee: nada cambió.
    expect(s.publications.all()).toEqual([]);
    const current = await s.contents.listCurrent(postSubject(later.id));
    expect(current.every((content) => content.status === "draft")).toBe(true);
  });
});

describe("weekProblemKind", () => {
  it("agrupa los códigos en motivos simples; uno desconocido es other", () => {
    expect(weekProblemKind("CONTENT_HAS_ERRORS")).toBe("text_errors");
    expect(weekProblemKind("CONTENT_NOT_READY")).toBe("media_missing");
    expect(weekProblemKind("ACCOUNT_NOT_CONNECTED")).toBe("account_missing");
    expect(weekProblemKind("SCHEDULE_TOO_SOON")).toBe("date");
    expect(weekProblemKind("ALGO_RARO")).toBe("other");
  });
});
