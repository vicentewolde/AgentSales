import { describe, expect, it } from "vitest";
import type { Publication } from "../publication.js";
import { GENERIC_ERROR_ADVICE } from "../publish/error-advice.js";
import { AGENDA_KINDS, agendaItems, pendingReviewsOf } from "./agenda.js";
import { trackingRow } from "./row.js";

// Spec F6 §4.9: la agenda y la matriz, puras.

// 2026-10-15 12:00 en Chile.
const NOW = new Date("2026-10-15T15:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const days = (n: number) => minutes(n * 24 * 60);

let next = 0;
function publication(extra: Partial<Publication> = {}): Publication {
  next += 1;
  return {
    id: `pub-${next}`,
    listingId: "l1",
    platformAccountId: "acc",
    platform: "instagram",
    format: "post",
    language: "es",
    contentId: "c",
    mediaIds: [],
    status: "approved",
    scheduledAt: null,
    publishedAt: null,
    externalId: null,
    externalUrl: null,
    attempts: 0,
    lastError: null,
    dryRun: true,
    progress: null,
    remoteState: null,
    listingSourceHash: "h",
    relistedFrom: null,
    costUsd: null,
    createdAt: minutes(-600),
    updatedAt: minutes(-60),
    ...extra,
    // El sujeto sigue al aviso del caso (`listingId` es su atajo).
    subject: { kind: "listing", id: extra.listingId ?? "l1" },
  };
}

const remote = (stopTime: Date, status = "active", subStatus: string[] = []) => ({
  status,
  subStatus,
  stopTime: stopTime.toISOString(),
  expirationTime: null,
  checkedAt: NOW.toISOString(),
});

const listing = (
  id: string,
  status: "ready" | "active" | "closed" = "active",
  brokerId = "b1",
) => ({
  id,
  brokerId,
  externalRef: id.toUpperCase(),
  status,
});

const run = (publications: Publication[], extra: Partial<Parameters<typeof agendaItems>[0]> = {}) =>
  agendaItems({
    listings: [listing("l1"), listing("l2", "closed")],
    publications,
    autoPublishBrokerIds: new Set(),
    pendingReviews: [],
    now: NOW,
    ...extra,
  });

describe("agendaItems", () => {
  it("cada clase con su acción, en el orden de la agenda", () => {
    const items = run(
      [
        publication({ status: "scheduled", scheduledAt: minutes(60) }), // upcoming
        publication({ status: "scheduled", scheduledAt: minutes(-13 * 60) }), // overdue
        publication({
          status: "scheduled",
          platform: "fb_marketplace",
          scheduledAt: minutes(-20 * 60),
        }), // your_turn (nunca atrasada)
        publication({ status: "publishing", updatedAt: minutes(-71) }), // stuck
        publication({
          status: "failed",
          lastError: { code: "RARO", message: "x", retriable: false },
        }), // failed
        publication({
          listingId: "l2",
          status: "published",
          dryRun: false,
          publishedAt: minutes(-100),
        }), // manual_task
        publication({
          platform: "portal_inmobiliario",
          status: "published",
          dryRun: false,
          remoteState: remote(days(3)),
        }), // expiring
      ],
      {
        pendingReviews: [{ listingId: "l1", platform: "portal_inmobiliario" }],
        backup: null,
      },
    );

    expect(items.map((item) => [item.kind, item.action])).toEqual([
      ["overdue", "publish"],
      ["your_turn", "publish"],
      ["stuck", "requeue"],
      ["failed", "retry"],
      ["manual_task", "retire"],
      ["needs_review", "review"],
      ["expiring", "none"],
      ["upcoming", "none"],
      ["backup", "backup"],
    ]);
    expect(items.find((item) => item.kind === "failed")).toMatchObject({
      code: "RARO",
      advice: GENERIC_ERROR_ADVICE,
    });
    expect(items.find((item) => item.kind === "expiring")).toMatchObject({
      daysLeft: 3,
      expired: false,
    });
    expect(items.find((item) => item.kind === "manual_task")?.externalRef).toBe("L2");
    // Es el orden declarado.
    expect([...new Set(items.map((item) => item.kind))]).toEqual(
      AGENDA_KINDS.filter((kind) => kind !== "approved_waiting"),
    );
  });

  it("lo que no va: una programada a más de 7 días, una que publica hace poco, una debida que sale en el próximo minuto", () => {
    expect(
      run([
        publication({ status: "scheduled", scheduledAt: days(8) }),
        publication({ status: "publishing", updatedAt: minutes(-30) }),
        publication({ status: "scheduled", scheduledAt: minutes(-5) }),
        publication({ status: "published" }),
      ]),
    ).toEqual([]);
  });

  it("aprobada sin publicar solo para corredores con auto_publish y propiedades listas o activas", () => {
    const approved = publication({ status: "approved" });
    expect(run([approved])).toEqual([]);
    expect(run([approved], { autoPublishBrokerIds: new Set(["b1"]) })).toMatchObject([
      { kind: "approved_waiting", action: "publish", publicationId: approved.id },
    ]);
  });

  it("Portal vencido sin republicar pide republicar; si ya se republicó o la propiedad cerró, no", () => {
    const expired = publication({
      platform: "portal_inmobiliario",
      status: "unpublished",
      dryRun: false,
      remoteState: remote(days(-1), "closed", ["expired"]),
    });
    expect(run([expired])).toMatchObject([{ kind: "expiring", action: "relist", expired: true }]);
    expect(
      run([
        expired,
        publication({
          platform: "portal_inmobiliario",
          relistedFrom: expired.id,
          status: "publishing",
        }),
      ]),
    ).toEqual([]);
    expect(run([{ ...expired, listingId: "l2" }])).toEqual([]);
    // Vencida pero todavía publicada: primero un sync (republicar exige `unpublished`).
    expect(run([{ ...expired, status: "published", remoteState: remote(days(-1)) }])).toMatchObject(
      [{ kind: "expiring", action: "sync", expired: true }],
    );
  });

  it("el respaldo: al día sin acción, atrasado o con una falla pide respaldar", () => {
    const ok = {
      lastSuccessAt: minutes(-60).toISOString(),
      lastFile: "f",
      lastFailureAt: null,
      lastFailureCode: null,
    };
    expect(run([], { backup: ok })).toMatchObject([{ kind: "backup", action: "none" }]);
    expect(run([], { backup: { ...ok, lastSuccessAt: days(-3).toISOString() } })).toMatchObject([
      { kind: "backup", action: "backup", stale: true },
    ]);
    expect(run([], { backup: { ...ok, lastFailureCode: "BACKUP_FAILED" } })).toMatchObject([
      { kind: "backup", action: "backup", code: "BACKUP_FAILED" },
    ]);
    expect(run([])).toEqual([]);
  });
});

describe("trackingRow", () => {
  it("por plataforma, la más reciente de cada formato, con su estado, enlace https, error con consejo y vencimiento", () => {
    const row = trackingRow(
      {
        id: "l1",
        brokerId: "b1",
        externalRef: "P1",
        status: "closed",
        closeReason: "sold",
        operation: "sale",
        propertyType: "Casa",
        comuna: "Ñuñoa",
      },
      [
        publication({ format: "post", status: "unpublished", createdAt: minutes(-900) }),
        publication({
          format: "post",
          status: "published",
          dryRun: false,
          externalUrl: "https://instagram.com/p/x",
          createdAt: minutes(-100),
        }),
        publication({
          format: "reel",
          status: "failed",
          externalUrl: "http://inseguro",
          lastError: { code: "IG_AUTH_INVALID", message: "m", retriable: false },
        }),
        publication({
          platform: "portal_inmobiliario",
          status: "published",
          remoteState: remote(days(2)),
        }),
        publication({ listingId: "otra", platform: "fb_marketplace" }),
      ],
      NOW,
    );

    expect(row.listing).toMatchObject({ externalRef: "P1", closeReason: "sold" });
    expect(row.cells.instagram.map((p) => [p.format, p.status, p.manualTask])).toEqual([
      ["post", "published", true],
      ["reel", "failed", false],
    ]);
    expect(row.cells.instagram[0]?.externalUrl).toBe("https://instagram.com/p/x");
    expect(row.cells.instagram[1]?.externalUrl).toBeNull();
    expect(row.cells.instagram[1]?.errorAdvice).not.toBe(GENERIC_ERROR_ADVICE);
    expect(row.cells.portal_inmobiliario[0]?.expiry).toMatchObject({ daysLeft: 2, soon: true });
    expect(row.cells.fb_marketplace).toEqual([]);
  });
});

describe("pendingReviewsOf", () => {
  it("solo corredores con auto_publish, propiedades listas o activas y canales conectados sin aprobar", () => {
    const reviews = pendingReviewsOf({
      listings: [
        { id: "a", brokerId: "auto", status: "ready" },
        { id: "b", brokerId: "auto", status: "paused" },
        { id: "c", brokerId: "manual", status: "active" },
      ],
      brokers: new Map([
        ["auto", { autoPublish: true }],
        ["manual", { autoPublish: false }],
      ]),
      connectedByBroker: new Map([
        ["auto", new Set(["instagram", "portal_inmobiliario"] as const)],
        ["manual", new Set(["instagram"] as const)],
      ]),
      contentsByListing: new Map([
        [
          "a",
          [
            { platform: "instagram" as const, status: "approved" as const },
            { platform: "portal_inmobiliario" as const, status: "draft" as const },
            { platform: "fb_marketplace" as const, status: "edited" as const },
          ],
        ],
        ["b", [{ platform: "instagram" as const, status: "draft" as const }]],
        ["c", [{ platform: "instagram" as const, status: "draft" as const }]],
      ]),
    });
    expect(reviews).toEqual([{ listingId: "a", platform: "portal_inmobiliario" }]);
  });
});
