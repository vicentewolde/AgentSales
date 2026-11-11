import type { ContentView, PostPublicationView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { summaryRows } from "./PostSummary.js";

// «Qué se publica»: cada texto (red e idioma) dice si sale, cuándo y en qué punto va.

const text = (
  platform: "x" | "instagram",
  language: "es" | "en",
  status: ContentView["status"],
): ContentView =>
  ({
    id: `${platform}-${language}`,
    platform,
    language,
    status,
    body: "Hola",
    hashtags: [],
    checks: [],
  }) as unknown as ContentView;

const publication = (
  contentId: string,
  status: PostPublicationView["status"],
  extra: Partial<PostPublicationView> = {},
): PostPublicationView =>
  ({
    id: `pub-${contentId}`,
    contentId,
    platform: contentId.startsWith("x") ? "x" : "instagram",
    language: contentId.endsWith("en") ? "en" : "es",
    status,
    dryRun: true,
    scheduledAt: null,
    publishedAt: null,
    media: [],
    ...extra,
  }) as unknown as PostPublicationView;

const now = new Date("2026-11-10T22:00:00Z");

describe("summaryRows", () => {
  it("lo aprobado y programado sale con su día y hora; lo sin aprobar, no sale y va al final", () => {
    const rows = summaryRows(
      { platforms: null },
      [
        text("x", "es", "generated"),
        text("x", "en", "approved"),
        text("instagram", "en", "approved"),
      ],
      [publication("x-en", "scheduled", { scheduledAt: new Date("2026-11-12T15:00:00Z") })],
      now,
    );
    expect(rows.map((row) => [row.key, row.publishes, row.state, row.detail])).toEqual([
      ["x:en", true, "Programado", "jue 12 nov · 12:00 (simulación)"],
      ["instagram:en", true, "Aprobado, falta programarlo", "usa «Programar…» a la derecha"],
      ["x:es", false, "No se publica", "falta aprobar este texto"],
    ]);
  });

  it("una red que ya no es del post no se publica aunque el texto esté aprobado", () => {
    const rows = summaryRows({ platforms: ["x"] }, [text("instagram", "en", "approved")], [], now);
    expect(rows).toMatchObject([
      { publishes: false, state: "No se publica", detail: "esta red no está entre las del post" },
    ]);
  });

  it("a mano: dice que te toca; una cancelada no cuenta", () => {
    const rows = summaryRows(
      { platforms: null },
      [text("x", "en", "approved"), text("instagram", "en", "approved")],
      [publication("x-en", "awaiting_manual_confirm"), publication("instagram-en", "cancelled")],
      now,
    );
    expect(rows.map((row) => row.state)).toEqual([
      "Te toca publicarlo a mano",
      "Aprobado, falta programarlo",
    ]);
  });
});
