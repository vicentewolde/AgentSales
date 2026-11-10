import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { isHandTask, recentPublications } from "./agenda.js";

// LinkedIn a mano (F9.5): qué tarea de la agenda lleva el botón de un clic y cómo se marca lo
// confirmado sin enlace en lo publicado hace poco.

type Item = AgendaResponse["items"][number];
const item = (extra: Partial<Item>): Item => ({
  kind: "manual_task",
  action: "confirm",
  listingId: null,
  postId: "post-1",
  externalRef: null,
  title: "Tema",
  accountId: null,
  brokerSlug: null,
  platform: "linkedin",
  format: "post",
  publicationId: "pub-1",
  at: new Date(),
  dryRun: false,
  modeFixed: true,
  mediaCount: 0,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
  ...extra,
});

describe("isHandTask", () => {
  it("la tarea a mano de LinkedIn, X o Instagram de un post con su publicación", () => {
    expect(isHandTask(item({}))).toBe(true);
    expect(isHandTask(item({ platform: "x" }))).toBe(true);
    expect(isHandTask(item({ platform: "instagram" }))).toBe(true);
    expect(isHandTask(item({ platform: "tiktok" }))).toBe(false);
    expect(isHandTask(item({ platform: "discord" }))).toBe(false);
    expect(isHandTask(item({ kind: "upcoming", action: "none" }))).toBe(false);
    expect(isHandTask(item({ action: "retire" }))).toBe(false);
    expect(isHandTask(item({ postId: null, listingId: "l1" }))).toBe(false);
    expect(isHandTask(item({ publicationId: null }))).toBe(false);
  });
});

describe("recentPublications: sin enlace", () => {
  const cell = (extra: Record<string, unknown>) =>
    ({
      id: "c",
      format: "post",
      language: "es",
      status: "published",
      dryRun: false,
      modeFixed: true,
      mediaCount: 0,
      externalUrl: null,
      scheduledAt: null,
      schedule: null,
      expiry: null,
      lastError: null,
      errorAdvice: null,
      manualTask: false,
      publishedAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    }) as TrackingResponse["posts"][number]["cells"]["linkedin"][number];

  it("una de LinkedIn en vivo sin enlace se marca; con enlace o en simulación, no", () => {
    const tracking = {
      rows: [],
      posts: [
        {
          post: {
            id: "p",
            brokerId: "b",
            topic: "Tema",
            status: "ready",
            kind: "text",
            plannedAt: null,
          },
          cells: {
            instagram: [],
            x: [],
            discord: [],
            tiktok: [],
            linkedin: [
              cell({ id: "sin" }),
              cell({
                id: "con",
                externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/",
              }),
              cell({ id: "sim", dryRun: true }),
            ],
          },
        },
      ],
    } as unknown as TrackingResponse;
    const recent = recentPublications(tracking, new Date());
    expect(Object.fromEntries(recent.map((row) => [row.id, row.withoutLink]))).toEqual({
      sin: true,
      con: false,
      sim: false,
    });
  });
});
