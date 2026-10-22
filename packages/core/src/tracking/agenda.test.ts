import { describe, expect, it } from "vitest";
import type { Publication } from "../publication.js";
import { GENERIC_ERROR_ADVICE } from "../publish/error-advice.js";
import { AGENDA_KINDS, type AgendaAccount, agendaItems, pendingReviewsOf } from "./agenda.js";
import { trackingPostRow, trackingRow } from "./row.js";

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

/** Una publicación de un post (F9-T08): sin aviso y con el post como sujeto. */
function postPublication(postId: string, extra: Partial<Publication> = {}): Publication {
  return {
    ...publication({ listingSourceHash: null, ...extra }),
    listingId: null,
    subject: { kind: "post", id: postId },
  };
}

const post = (id: string, brokerId = "b1") => ({ id, brokerId, topic: `Tema ${id}` });

const account = (extra: Partial<AgendaAccount> = {}): AgendaAccount => ({
  id: "acc-li",
  brokerId: "b1",
  brokerSlug: "marca",
  platform: "linkedin",
  displayName: "Vinny en LinkedIn",
  status: "connected",
  tokenExpiresAt: days(7),
  meta: { mode: "manual" },
  ...extra,
});

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
        publication({ status: "outcome_unknown" }), // outcome_unknown (F9)
      ],
      {
        pendingReviews: [{ listingId: "l1", platform: "portal_inmobiliario" }],
        accounts: [account()], // token_expiring (F9)
        backup: null,
      },
    );

    expect(items.map((item) => [item.kind, item.action])).toEqual([
      ["overdue", "publish"],
      ["your_turn", "publish"],
      ["outcome_unknown", "resolve"],
      ["stuck", "requeue"],
      ["failed", "retry"],
      ["manual_task", "retire"],
      ["needs_review", "review"],
      ["token_expiring", "reconnect"],
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
    // Es el orden declarado (sin el estado del worker no hay `worker_off`).
    expect([...new Set(items.map((item) => item.kind))]).toEqual(
      AGENDA_KINDS.filter((kind) => kind !== "approved_waiting" && kind !== "worker_off"),
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
    expect(run([{ ...expired, listingId: "l2", subject: { kind: "listing", id: "l2" } }])).toEqual(
      [],
    );
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

describe("agendaItems con el worker apagado (F9.5-T24)", () => {
  // NOW es 2026-10-15 12:00 en Chile: la próxima revisión del horario es a las 12:50.
  const scheduled = (at: Date, extra: Partial<Publication> = {}) =>
    publication({ status: "scheduled", scheduledAt: at, ...extra });

  it("el worker está apagado y hay algo por vencer: la vencida y la que vence antes de la próxima revisión, con encenderlo", () => {
    const due = scheduled(minutes(-5));
    const beforeWindow = scheduled(minutes(30));
    const items = run([due, beforeWindow], { worker: { running: false } });

    expect(items.map((item) => [item.kind, item.action, item.publicationId])).toEqual([
      ["worker_off", "start_worker", due.id],
      ["worker_off", "start_worker", beforeWindow.id],
    ]);
    expect(items[0]).toMatchObject({ at: due.scheduledAt, title: "L1", platform: "instagram" });
    // Va primero: explica por qué lo demás no sale.
    expect(AGENDA_KINDS[0]).toBe("worker_off");
  });

  it("también un post, y una de LinkedIn a mano (el worker la deja lista)", () => {
    const linkedin = postPublication("p1", {
      status: "scheduled",
      platform: "linkedin",
      scheduledAt: minutes(30),
    });
    const items = run([linkedin], { posts: [post("p1")], worker: { running: false } });

    expect(items.map((item) => [item.kind, item.postId])).toEqual([["worker_off", "p1"]]);
  });

  it("lo que vence después de la próxima revisión sigue como próxima; una atrasada, atrasada; Marketplace, te toca", () => {
    const items = run(
      [
        scheduled(minutes(60)), // 13:00, después de la revisión de las 12:50: esa lo enciende
        scheduled(minutes(-13 * 60)), // atrasada: ya no sale sola
        scheduled(minutes(-30), { platform: "fb_marketplace" }), // recordatorio: lo aprieta el operador
        scheduled(minutes(60), { platform: "fb_marketplace" }),
      ],
      { worker: { running: false } },
    );

    expect(items.map((item) => item.kind)).toEqual([
      "overdue",
      "your_turn",
      "upcoming",
      "upcoming",
    ]);
  });

  it("de noche, lo de la madrugada espera a la primera revisión de la mañana (06:50)", () => {
    // 2026-10-15 23:30 en Chile; la próxima revisión es la de las 06:50 del 16.
    const night = new Date("2026-10-16T02:30:00.000Z");
    const at = (hours: number) => new Date(night.getTime() + hours * 60 * 60_000);
    const items = run([scheduled(at(2.5)), scheduled(at(8))], {
      worker: { running: false },
      now: night,
    });

    // 02:00 espera al worker; 07:30, después de la revisión de las 06:50, es una próxima.
    expect(items.map((item) => item.kind)).toEqual(["worker_off", "upcoming"]);
  });

  it("con el worker encendido, o sin saber su estado, no hay aviso", () => {
    const publications = [scheduled(minutes(-5)), scheduled(minutes(30))];

    for (const worker of [{ running: true }, null, undefined]) {
      expect(
        run(publications, worker === undefined ? {} : { worker }).map((item) => item.kind),
      ).toEqual(["upcoming"]);
    }
  });
});

describe("agendaItems con posts (F9-T08)", () => {
  const withPosts = (
    publications: Publication[],
    extra: Partial<Parameters<typeof agendaItems>[0]> = {},
  ) => run(publications, { posts: [post("p1"), post("p2", "b2")], ...extra });

  it("ordena posts y avisos juntos, con el tema del post como título", () => {
    const later = publication({ status: "scheduled", scheduledAt: minutes(120) });
    const sooner = postPublication("p1", { status: "scheduled", scheduledAt: minutes(60) });
    const postFailed = postPublication("p2", {
      platform: "x",
      status: "failed",
      lastError: { code: "RARO", message: "x", retriable: false },
    });
    const items = withPosts([later, sooner, postFailed]);

    expect(items.map((item) => [item.kind, item.publicationId])).toEqual([
      ["failed", postFailed.id],
      ["upcoming", sooner.id],
      ["upcoming", later.id],
    ]);
    expect(items[1]).toMatchObject({
      postId: "p1",
      listingId: null,
      externalRef: null,
      title: "Tema p1",
      platform: "instagram",
    });
    expect(items[2]).toMatchObject({ listingId: "l1", postId: null, title: "L1" });
    // Con la misma hora, por título.
    const tie = withPosts([
      publication({ status: "scheduled", scheduledAt: minutes(60) }),
      postPublication("p1", { status: "scheduled", scheduledAt: minutes(60) }),
    ]);
    expect(tie.map((item) => item.title)).toEqual(["L1", "Tema p1"]);
  });

  it("un post que no está entre los del alcance no aparece", () => {
    const ajena = postPublication("otro", { status: "failed" });
    expect(withPosts([ajena])).toEqual([]);
    expect(run([postPublication("p1", { status: "failed" })])).toEqual([]);
  });

  it("un aviso de Instagram o Portal con resultado dudoso (F9.5-T04a) pide resolverlo, con el consejo de su red", () => {
    const instagram = publication({
      status: "outcome_unknown",
      dryRun: false,
      lastError: { code: "IG_PUBLISH_OUTCOME_UNKNOWN", message: "x", retriable: false },
    });
    const portal = publication({
      platform: "portal_inmobiliario",
      status: "outcome_unknown",
      dryRun: false,
      lastError: { code: "ML_PUBLISH_OUTCOME_UNKNOWN", message: "x", retriable: false },
    });
    const items = run([instagram, portal]);
    expect(items).toMatchObject([
      {
        kind: "outcome_unknown",
        action: "resolve",
        listingId: "l1",
        publicationId: instagram.id,
        code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      },
      {
        kind: "outcome_unknown",
        action: "resolve",
        listingId: "l1",
        publicationId: portal.id,
        code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      },
    ]);
    for (const item of items) {
      expect(item.advice).toContain("«Salió»");
      expect(item.advice).not.toBe(GENERIC_ERROR_ADVICE);
    }
  });

  it("outcome_unknown pide resolverla, con su código y consejo", () => {
    const unknown = postPublication("p1", {
      platform: "discord",
      status: "outcome_unknown",
      updatedAt: minutes(-5),
      lastError: { code: "OUTCOME_UNKNOWN", message: "x", retriable: false },
    });
    expect(withPosts([unknown])).toMatchObject([
      {
        kind: "outcome_unknown",
        action: "resolve",
        postId: "p1",
        publicationId: unknown.id,
        at: minutes(-5),
        code: "OUTCOME_UNKNOWN",
      },
    ]);
    expect(withPosts([unknown])[0]?.advice).not.toBeNull();
  });

  it("un LinkedIn a mano listo para publicar es una tarea a mano; la de Marketplace sigue su flujo", () => {
    const readyAt = minutes(-30);
    const linkedin = postPublication("p1", {
      platform: "linkedin",
      status: "awaiting_manual_confirm",
      progress: {
        manual: { attempt: 1, simulated: true, readyAt: readyAt.toISOString(), media: 1 },
      },
    });
    const marketplace = publication({
      platform: "fb_marketplace",
      status: "awaiting_manual_confirm",
    });
    expect(withPosts([linkedin, marketplace])).toMatchObject([
      {
        kind: "manual_task",
        action: "confirm",
        postId: "p1",
        platform: "linkedin",
        publicationId: linkedin.id,
        at: readyAt,
      },
    ]);
  });

  it("lo que depende de la propiedad no aplica a un post", () => {
    expect(
      withPosts(
        [
          postPublication("p1", { status: "approved" }),
          postPublication("p1", { status: "published", dryRun: false, publishedAt: minutes(-9) }),
        ],
        { autoPublishBrokerIds: new Set(["b1"]) },
      ),
    ).toEqual([]);
  });

  it("token por vencer: LinkedIn a 7 días o vencido, con su cuenta; no lo que se renueva solo", () => {
    const items = run([], {
      accounts: [
        account(),
        account({ id: "acc-8", tokenExpiresAt: days(8) }),
        account({ id: "acc-vencida", status: "expired", tokenExpiresAt: days(-1) }),
        account({ id: "acc-nunca", tokenExpiresAt: null, meta: { tokenNeverExpires: true } }),
        account({ id: "acc-sin-fecha", tokenExpiresAt: null }),
        account({ id: "acc-revocada", status: "revoked" }),
        account({ id: "acc-ig", platform: "instagram", tokenExpiresAt: days(2) }),
        account({ id: "acc-x", platform: "x", tokenExpiresAt: days(1) }),
      ],
    });
    expect(items.map((item) => [item.accountId, item.daysLeft, item.expired])).toEqual([
      ["acc-vencida", -1, true],
      ["acc-li", 7, false],
    ]);
    expect(items[1]).toMatchObject({
      kind: "token_expiring",
      action: "reconnect",
      title: "Vinny en LinkedIn",
      brokerSlug: "marca",
      platform: "linkedin",
      at: days(7),
      publicationId: null,
      listingId: null,
      postId: null,
    });
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

describe("trackingPostRow", () => {
  it("por red, la más reciente de cada formato e idioma del post; ignora otros posts y avisos", () => {
    const row = trackingPostRow(
      {
        id: "p1",
        brokerId: "b1",
        topic: "Bastidores",
        status: "ready",
        kind: "image",
        plannedAt: null,
      },
      [
        postPublication("p1", { platform: "x", status: "failed", createdAt: minutes(-900) }),
        postPublication("p1", { platform: "x", status: "scheduled", createdAt: minutes(-100) }),
        postPublication("p1", { platform: "linkedin", language: "en", status: "published" }),
        postPublication("p1", { platform: "linkedin", status: "awaiting_manual_confirm" }),
        postPublication("p2", { platform: "discord" }),
        publication({ platform: "instagram" }),
      ],
      NOW,
    );
    expect(row.post).toMatchObject({ id: "p1", topic: "Bastidores" });
    expect(row.cells.x.map((p) => p.status)).toEqual(["scheduled"]);
    expect(row.cells.linkedin.map((p) => [p.language, p.status, p.manualTask])).toEqual([
      ["es", "awaiting_manual_confirm", false],
      ["en", "published", false],
    ]);
    expect(row.cells.discord).toEqual([]);
    expect(row.cells.instagram).toEqual([]);
    expect(row.cells.tiktok).toEqual([]);
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
