import { describe, expect, it } from "vitest";
import { canPublishListing } from "./listing.js";
import {
  checkPublicationProgress,
  checkRemoteState,
  hasStartedLive,
  publicationEventSchema,
  publicationSchema,
  publishAttemptPayloadSchema,
  remoteStateSchema,
  syncPayloadSchema,
} from "./publication.js";

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
  remoteState: null,
  listingSourceHash: null,
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

describe("checkPublicationProgress (Instagram)", () => {
  const progress = {
    attemptStartedAt: "2026-10-05T12:00:00.000Z",
    childIds: ["c-1", "c-2"],
    containerId: "c-3",
  };

  it("acepta el progreso con y sin la hora del pedido de media_publish", () => {
    expect(checkPublicationProgress("instagram", progress)).toEqual(progress);
    const requested = { ...progress, publishRequestedAt: "2026-10-05T12:01:00.000Z" };
    expect(checkPublicationProgress("instagram", requested)).toEqual(requested);
  });

  it("una hora del pedido que no es una fecha es PUBLICATION_PROGRESS_INVALID", () => {
    expect(() =>
      checkPublicationProgress("instagram", { ...progress, publishRequestedAt: "ayer" }),
    ).toThrow(expect.objectContaining({ code: "PUBLICATION_PROGRESS_INVALID" }));
  });
});

describe("hasStartedLive y canPublishListing", () => {
  it("empezó en vivo solo si no es simulación y tiene progreso guardado", () => {
    expect(hasStartedLive({ dryRun: false, progress: { containerId: "c" } })).toBe(true);
    expect(hasStartedLive({ dryRun: false, progress: null })).toBe(false);
    expect(hasStartedLive({ dryRun: true, progress: { containerId: "c" } })).toBe(false);
  });

  it("se publica un aviso listo o ya publicado", () => {
    expect(canPublishListing("ready")).toBe(true);
    expect(canPublishListing("active")).toBe(true);
    for (const status of ["draft", "paused", "closed", "archived"] as const) {
      expect(canPublishListing(status)).toBe(false);
    }
  });
});

describe("estado remoto (F4, ADR-0015)", () => {
  const remote = {
    status: "active",
    subStatus: [],
    stopTime: "2026-11-20T04:00:00.000-03:00",
    expirationTime: "2026-12-01T00:00:00.000Z",
    checkedAt: "2026-10-06T12:00:00.000Z",
  };

  it("acepta lo que informa Mercado Libre, con zona horaria", () => {
    expect(remoteStateSchema.parse(remote)).toEqual(remote);
    expect(syncPayloadSchema.parse({ remote })).toEqual({ remote });
  });

  it("el motivo de una pausa por moderación es opcional: código y texto propio", () => {
    const paused = {
      ...remote,
      status: "paused",
      reason: { code: "ABANDONED_ITEM_REX_DEN", message: "La reportaron como no disponible" },
    };
    expect(remoteStateSchema.parse(paused)).toEqual(paused);
    for (const reason of [
      { code: "con espacios", message: "x" },
      { code: "X", message: "" },
      { code: "X" },
    ]) {
      expect(remoteStateSchema.safeParse({ ...remote, reason }).success).toBe(false);
    }
  });

  it("checkRemoteState deja pasar null y rechaza lo que no calza", () => {
    expect(checkRemoteState(null)).toBeNull();
    expect(checkRemoteState(remote)).toEqual(remote);
    for (const invalid of [
      { ...remote, status: "" },
      { ...remote, checkedAt: "ayer" },
      { ...remote, subStatus: "paused" },
      "active",
    ]) {
      expect(() => checkRemoteState(invalid)).toThrow(
        expect.objectContaining({ code: "PUBLICATION_REMOTE_STATE_INVALID" }),
      );
    }
  });

  it("la publicación lleva el estado remoto y la versión del aviso", () => {
    const publication = { ...base, remoteState: remote, listingSourceHash: "hash" };
    expect(publicationSchema.parse(publication)).toMatchObject({
      remoteState: remote,
      listingSourceHash: "hash",
    });
    expect(
      publicationSchema.safeParse({ ...base, remoteState: { status: "active" } }).success,
    ).toBe(false);
  });

  it("el progreso de Portal se valida con su esquema", () => {
    const portal = { pictureIds: ["f1"], itemId: "MLC1" };
    expect(checkPublicationProgress("portal_inmobiliario", portal)).toEqual(portal);
    expect(() => checkPublicationProgress("portal_inmobiliario", { itemId: "MLC1" })).toThrow(
      expect.objectContaining({ code: "PUBLICATION_PROGRESS_INVALID" }),
    );
    // Marketplace aún no publica: no tiene esquema.
    expect(() => checkPublicationProgress("fb_marketplace", portal)).toThrow(
      expect.objectContaining({ code: "PUBLICATION_PROGRESS_INVALID" }),
    );
  });
});

describe("publishAttemptPayloadSchema (F4-T13)", () => {
  it("lee un intento guardado antes de F4-T13 (sin notes, listing ni brokerContact)", () => {
    const old = {
      mode: "live",
      attempt: 1,
      retry: 0,
      result: "published",
      sent: {
        platform: "instagram",
        format: "post",
        title: null,
        caption: "Hola",
        media: [],
        account: { id: "account-1", displayName: "@corredora" },
      },
    };
    expect(publishAttemptPayloadSchema.parse(old)).toEqual(old);
  });
});
