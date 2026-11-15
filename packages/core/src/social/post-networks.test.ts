import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import {
  addedPlatformsToDraft,
  ideaNeedsDraft,
  postKindIssues,
  postNetworkGaps,
  postPublishesOn,
  requirePostPlatform,
  rescheduleSuggestion,
} from "./post-networks.js";

// F9-T21: la regla de las redes de un post (`posts.platforms`) y lo que muestran la CLI y el panel.

const run = (status: "queued" | "running" | "succeeded" | "failed") => ({ status });
const texts = (...platforms: ("discord" | "x" | "instagram" | "linkedin")[]) =>
  platforms.map((platform) => ({ platform }));

describe("postPublishesOn y requirePostPlatform", () => {
  it("sin redes propias publica en todas las de posts; con lista, solo en esas", () => {
    expect(postPublishesOn({ platforms: null }, "x")).toBe(true);
    expect(postPublishesOn({ platforms: ["x"] }, "x")).toBe(true);
    expect(postPublishesOn({ platforms: ["x"] }, "discord")).toBe(false);
    // Una red de avisos nunca es de un post.
    expect(postPublishesOn({ platforms: null }, "portal_inmobiliario")).toBe(false);
  });

  it("requirePostPlatform: nada si está; si no, POST_PLATFORM_EXCLUDED con el post y la red", () => {
    expect(() => requirePostPlatform({ id: "p1", platforms: ["x"] }, "x")).not.toThrow();
    try {
      requirePostPlatform({ id: "p1", platforms: ["x"] }, "discord");
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("POST_PLATFORM_EXCLUDED");
      expect(isAppError(error) && error.details).toEqual({ postId: "p1", platform: "discord" });
      expect(isAppError(error) && error.message).toContain("Discord no está entre las redes");
    }
  });
});

describe("postNetworkGaps", () => {
  it("una red agregada sin texto falta; un texto de una red quitada sobra", () => {
    expect(
      postNetworkGaps({
        post: { platforms: ["x", "linkedin"], kind: "text" },
        contents: texts("discord", "x"),
        latestRun: run("succeeded"),
      }),
    ).toEqual({ missing: ["linkedin"], excluded: ["discord"] });
  });

  it("Instagram en un post de solo texto no falta: no sirve a ese tipo (kindProblem)", () => {
    expect(
      postNetworkGaps({
        post: { platforms: ["instagram", "x"], kind: "text" },
        contents: texts("x"),
        latestRun: run("succeeded"),
      }).missing,
    ).toEqual([]);
    expect(
      postNetworkGaps({
        post: { platforms: ["instagram", "x"], kind: "image" },
        contents: texts("x"),
        latestRun: run("succeeded"),
      }).missing,
    ).toEqual(["instagram"]);
  });

  it("mientras la IA redacta no falta nada; sin redactar todavía, tampoco", () => {
    for (const status of ["queued", "running"] as const) {
      expect(
        postNetworkGaps({
          post: { platforms: ["x"], kind: "text" },
          contents: [],
          latestRun: run(status),
        }).missing,
      ).toEqual([]);
    }
    expect(
      postNetworkGaps({ post: { platforms: ["x"], kind: "text" }, contents: [], latestRun: null })
        .missing,
    ).toEqual([]);
  });

  it("una corrida terminada bien sin textos: faltan todas las redes del post", () => {
    expect(
      postNetworkGaps({
        post: { platforms: ["x", "discord"], kind: "text" },
        contents: [],
        latestRun: run("succeeded"),
      }),
    ).toEqual({ missing: ["x", "discord"], excluded: [] });
  });

  it("sin redes propias no falta ni sobra nada (son las de la marca)", () => {
    expect(
      postNetworkGaps({
        post: { platforms: null, kind: "text" },
        contents: texts("discord"),
        latestRun: run("succeeded"),
      }),
    ).toEqual({ missing: [], excluded: [] });
  });
});

describe("ideaNeedsDraft", () => {
  const idea = (
    latestRun: { status: "queued" | "running" | "succeeded" | "failed" } | null,
    overrides: { status?: "idea" | "draft" | "ready" | "archived"; texts?: number } = {},
  ) => ({ status: overrides.status ?? "draft", texts: overrides.texts ?? 0, latestRun });

  it("aceptada sin textos y sin corrida en curso: sí (sin corrida, terminada bien o mal)", () => {
    expect(ideaNeedsDraft(idea(null))).toBe(true);
    expect(ideaNeedsDraft(idea(run("succeeded")))).toBe(true);
    expect(ideaNeedsDraft(idea(run("failed")))).toBe(true);
  });

  it("con la corrida en cola o corriendo, con textos, o sin aceptar: no", () => {
    expect(ideaNeedsDraft(idea(run("queued")))).toBe(false);
    expect(ideaNeedsDraft(idea(run("running")))).toBe(false);
    expect(ideaNeedsDraft(idea(run("succeeded"), { texts: 2 }))).toBe(false);
    expect(ideaNeedsDraft(idea(null, { status: "idea" }))).toBe(false);
    expect(ideaNeedsDraft(idea(null, { status: "archived" }))).toBe(false);
  });
});

describe("addedPlatformsToDraft (la red agregada a un post ya redactado)", () => {
  const post = (
    platforms: ("x" | "linkedin" | "instagram")[] | null,
    status = "draft" as const,
  ) => ({
    platforms,
    kind: "text" as const,
    status,
  });
  it("solo las redes nuevas, sin texto y que sirven al tipo", () => {
    expect(
      addedPlatformsToDraft({
        before: ["x"],
        post: post(["x", "linkedin", "instagram"]),
        contents: texts("x"),
      }),
    ).toEqual(["linkedin"]);
  });
  it("nada sin textos, en una idea, con todas las redes o si la red ya tenía texto", () => {
    expect(
      addedPlatformsToDraft({ before: ["x"], post: post(["x", "linkedin"]), contents: [] }),
    ).toEqual([]);
    expect(
      addedPlatformsToDraft({
        before: ["x"],
        post: { ...post(["x", "linkedin"]), status: "idea" },
        contents: texts("x"),
      }),
    ).toEqual([]);
    expect(
      addedPlatformsToDraft({ before: ["x"], post: post(null), contents: texts("x") }),
    ).toEqual([]);
    expect(
      addedPlatformsToDraft({ before: null, post: post(["x", "linkedin"]), contents: texts("x") }),
    ).toEqual([]);
    expect(
      addedPlatformsToDraft({
        before: ["x"],
        post: post(["x", "linkedin"]),
        contents: texts("x", "linkedin"),
      }),
    ).toEqual([]);
  });
});

describe("postKindIssues (el tipo del post contra sus medios y redes)", () => {
  it("dice qué falta y qué redes no sirven", () => {
    expect(
      postKindIssues({
        post: { kind: "text", platforms: ["x", "instagram"] },
        contents: [],
        images: 0,
        videos: 0,
      }),
    ).toEqual({
      media: null,
      unfit: [{ platform: "instagram", message: "Instagram necesita una imagen o un video" }],
    });
    expect(
      postKindIssues({
        post: { kind: "image", platforms: null },
        contents: [],
        images: 0,
        videos: 0,
      }).media,
    ).toMatch(/^Falta la imagen/);
    expect(
      postKindIssues({
        post: { kind: "video", platforms: null },
        contents: [],
        images: 2,
        videos: 0,
      }).media,
    ).toMatch(/^Falta el video/);
    expect(
      postKindIssues({
        post: { kind: "carousel", platforms: null },
        contents: [],
        images: 1,
        videos: 0,
      }).media,
    ).toMatch(/otra imagen/);
  });
  it("con todas las redes de la marca, mira las que tienen texto", () => {
    expect(
      postKindIssues({
        post: { kind: "image", platforms: null },
        contents: [{ platform: "tiktok" }, { platform: "x" }],
        images: 1,
        videos: 0,
      }).unfit,
    ).toEqual([{ platform: "tiktok", message: "TikTok publica solo video" }]);
  });
});

describe("rescheduleSuggestion (mover lo programado a la fecha nueva)", () => {
  const at = (iso: string) => new Date(iso);
  const pub = (
    platform: "x" | "linkedin",
    language: "es" | "en",
    scheduledAt: string | null,
    status: "scheduled" | "approved" = "scheduled",
  ) => ({ platform, language, status, scheduledAt: scheduledAt === null ? null : at(scheduledAt) });

  it("cada red con sus idiomas y el mismo espacio entre ellos", () => {
    const suggestion = rescheduleSuggestion(
      [
        pub("x", "en", "2026-11-20T13:30:00Z"),
        pub("x", "es", "2026-11-20T13:00:00Z"),
        pub("linkedin", "es", "2026-11-20T13:00:00Z"),
        pub("linkedin", "en", null, "approved"),
      ],
      at("2026-11-21T15:00:00Z"),
    );
    expect(suggestion).toEqual({
      count: 3,
      times: [at("2026-11-20T13:00:00Z"), at("2026-11-20T13:30:00Z")],
      moves: [
        { platform: "x", languages: ["es", "en"], spacingMinutes: 30 },
        { platform: "linkedin", languages: ["es"], spacingMinutes: 0 },
      ],
    });
  });

  it("nada si no hay programadas o ya están a esa hora", () => {
    expect(
      rescheduleSuggestion([pub("x", "es", null, "approved")], at("2026-11-21T15:00:00Z")),
    ).toBeNull();
    expect(
      rescheduleSuggestion([pub("x", "es", "2026-11-21T15:00:00Z")], at("2026-11-21T15:00:00Z")),
    ).toBeNull();
  });
});
