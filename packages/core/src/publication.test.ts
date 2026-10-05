import { describe, expect, it } from "vitest";
import { publicationEventSchema, publicationSchema } from "./publication.js";

const base = {
  id: "p1",
  listingId: "l1",
  platformAccountId: "a1",
  platform: "instagram",
  format: "post",
  contentId: "c1",
  mediaIds: ["m1", "m2"],
  status: "approved",
  scheduledAt: null,
  publishedAt: null,
  externalId: null,
  externalUrl: null,
  attempts: 0,
  lastError: null,
  dryRun: true,
  progress: null,
  createdAt: new Date("2026-10-05T12:00:00Z"),
  updatedAt: new Date("2026-10-05T12:00:00Z"),
} as const;

const progress = {
  attemptStartedAt: "2026-10-05T12:01:00.000Z",
  childIds: ["c-1", "c-2"],
  containerId: "parent",
};

describe("publicationSchema", () => {
  it("acepta una publicación recién nacida, sin progreso", () => {
    expect(publicationSchema.parse(base)).toEqual(base);
  });

  it("acepta el progreso de Instagram con su forma", () => {
    expect(publicationSchema.parse({ ...base, progress }).progress).toEqual(progress);
    expect(
      publicationSchema.parse({
        ...base,
        progress: { ...progress, containerId: null, childIds: [] },
      }).progress,
    ).toMatchObject({ containerId: null });
  });

  it("rechaza un progreso que no calza con el de su plataforma", () => {
    expect(publicationSchema.safeParse({ ...base, progress: { containerId: 3 } }).success).toBe(
      false,
    );
    expect(
      publicationSchema.safeParse({ ...base, progress: { ...progress, attemptStartedAt: "ayer" } })
        .success,
    ).toBe(false);
  });

  it("rechaza progreso en una plataforma que aún no publica", () => {
    expect(
      publicationSchema.safeParse({ ...base, platform: "portal_inmobiliario", progress }).success,
    ).toBe(false);
  });

  it("rechaza los estados que se quitaron (ADR-0014) y formatos desconocidos", () => {
    expect(publicationSchema.safeParse({ ...base, status: "pending_approval" }).success).toBe(
      false,
    );
    expect(publicationSchema.safeParse({ ...base, status: "draft" }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...base, format: "story" }).success).toBe(false);
  });

  it("exige el motivo completo del último error", () => {
    const lastError = {
      code: "IG_UNAVAILABLE",
      message: "Instagram no respondió",
      retriable: true,
    };
    expect(publicationSchema.parse({ ...base, lastError }).lastError).toEqual(lastError);
    expect(
      publicationSchema.safeParse({ ...base, lastError: { code: "X", message: "y" } }).success,
    ).toBe(false);
  });
});

describe("publicationEventSchema", () => {
  const event = {
    id: "e1",
    publicationId: "p1",
    type: "status_changed",
    fromStatus: null,
    toStatus: "approved",
    actor: "operator",
    payload: {},
    createdAt: new Date("2026-10-05T12:00:00Z"),
  } as const;

  it("acepta el evento de nacimiento (sin estado anterior)", () => {
    expect(publicationEventSchema.parse(event)).toEqual(event);
  });

  it("rechaza tipos y actores desconocidos", () => {
    expect(publicationEventSchema.safeParse({ ...event, type: "otro" }).success).toBe(false);
    expect(publicationEventSchema.safeParse({ ...event, actor: "web" }).success).toBe(false);
  });
});
