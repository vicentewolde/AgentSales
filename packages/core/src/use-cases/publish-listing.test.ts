import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  createInMemoryListingLock,
  createPublicationScenario,
  type PublicationScenario,
} from "../testing/index.js";
import { approveContent } from "./approve-content.js";
import { cancelPublication } from "./cancel-publication.js";
import { publishListing } from "./publish-listing.js";
import { retirePublication } from "./retire-publication.js";
import { startPublication } from "./start-publication.js";

const setup = createPublicationScenario;

type Setup = PublicationScenario;

/** Lleva una publicación a `published` como lo haría el intento (T11). */
async function markPublished(t: Setup, id: string, dryRun: boolean) {
  await t.publications.transition(
    id,
    { from: "approved", to: "publishing", changes: { dryRun } },
    { actor: "system" },
  );
  return t.publications.transition(
    id,
    { from: "publishing", to: "published", changes: { externalId: `ig-${id}` } },
    { actor: "system" },
  );
}

const publish = (t: Setup, dryRun = true) =>
  publishListing(t.deps, {
    listingId: t.listingId,
    platform: "instagram",
    dryRun,
    actor: "operator",
  });

describe("publishListing", () => {
  it("pasa carrusel y reel a publishing con el modo de la API, su evento, y encola después de confirmar", async () => {
    const t = await setup();
    const result = await publish(t, false);

    expect(result.started.map((p) => [p.format, p.status, p.dryRun, p.attempts])).toEqual([
      ["post", "publishing", false, 1],
      ["reel", "publishing", false, 1],
    ]);
    expect(result.created).toEqual([]);
    expect(t.queue.jobs).toEqual(
      result.started.map((p) => ({
        name: "publication.publish",
        data: { publicationId: p.id },
        options: { singletonKey: p.id },
      })),
    );
    const events = await t.publications.listEvents(result.started[0]?.id ?? "");
    expect(events.at(-1)).toMatchObject({
      type: "status_changed",
      fromStatus: "approved",
      toStatus: "publishing",
      actor: "operator",
      payload: { mode: "live", attempt: 1 },
    });
    expect(result.publications.map((p) => p.status)).toEqual(["publishing", "publishing"]);
  });

  it("en dry-run fija dry_run y lo anota en la bitácora", async () => {
    const t = await setup();
    const result = await publish(t, true);
    expect(result.started.every((p) => p.dryRun)).toBe(true);
    const events = await t.publications.listEvents(result.started[0]?.id ?? "");
    expect(events.at(-1)?.payload).toEqual({ mode: "dry-run", attempt: 1 });
  });

  it("abre las que faltan si la cuenta se conectó después de aprobar", async () => {
    const t = await setup({ account: false });
    expect(t.approved?.created).toEqual([]);
    await t.connect();
    const result = await publish(t);
    expect(result.created.map((p) => p.format)).toEqual(["post", "reel"]);
    expect(result.started.map((p) => p.status)).toEqual(["publishing", "publishing"]);
    expect(t.queue.jobs).toHaveLength(2);
  });

  it("reintenta las fallidas conservando el progreso y borrando el error anterior", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await t.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    const progress = {
      attemptStartedAt: "2026-10-05T12:00:00.000Z",
      childIds: [],
      containerId: "c-1",
    };
    await t.publications.saveProgress(post?.id ?? "", progress);
    await t.publications.transition(
      post?.id ?? "",
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "IG_UNAVAILABLE", message: "x", retriable: true } },
      },
      { actor: "system" },
    );
    await markPublished(t, reel?.id ?? "", true);

    const result = await publish(t);
    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toMatchObject({
      id: post?.id,
      status: "publishing",
      attempts: 2,
      lastError: null,
      progress,
    });
  });

  it("las que ya están en publishing se reencolan (por si su job se perdió), sin cambiarlas", async () => {
    const t = await setup();
    await markPublished(t, t.byFormat("post")?.id ?? "", true);
    const first = await publish(t);
    const again = await publish(t, false);
    expect(again.started).toEqual([]);
    expect(again.requeued.map((p) => [p.id, p.dryRun, p.attempts])).toEqual([
      [first.started[0]?.id, true, 1],
    ]);
    expect(t.queue.jobs.map((job) => job.data)).toEqual([
      { publicationId: first.started[0]?.id },
      { publicationId: first.started[0]?.id },
    ]);
  });

  it("con todo publicado es NOTHING_TO_PUBLISH, sin encolar", async () => {
    const t = await setup();
    await markPublished(t, t.byFormat("post")?.id ?? "", true);
    await markPublished(t, t.byFormat("reel")?.id ?? "", true);
    await expect(publish(t)).rejects.toMatchObject({
      code: "NOTHING_TO_PUBLISH",
      message: expect.stringContaining("todo está publicado"),
    });
    expect(t.queue.jobs).toEqual([]);
  });

  it("si un formato está ocupado por la publicación de un texto anterior, NOTHING_TO_PUBLISH dice que se retire o descarte", async () => {
    const t = await setup();
    await markPublished(t, t.byFormat("post")?.id ?? "", true);
    await markPublished(t, t.byFormat("reel")?.id ?? "", true);
    // Un texto nuevo, aprobado: sus dos formatos están ocupados por las publicadas del anterior.
    await t.prepare();
    await approveContent(t.approveDeps, { contentId: await t.instagramId(), actor: "operator" });
    await expect(publish(t)).rejects.toMatchObject({
      code: "NOTHING_TO_PUBLISH",
      message: expect.stringContaining("retírala o descártala"),
      details: { skipped: [{ format: "post" }, { format: "reel" }] },
    });
  });

  it("el carrusel de un texto anterior publicado se informa en skipped; el reel nuevo se publica", async () => {
    const t = await setup();
    const oldPost = t.byFormat("post");
    await markPublished(t, oldPost?.id ?? "", true);
    await cancelPublication(t.deps, {
      publicationId: t.byFormat("reel")?.id ?? "",
      actor: "operator",
    });
    await t.prepare();
    await approveContent(t.approveDeps, { contentId: await t.instagramId(), actor: "operator" });

    const result = await publish(t);
    expect(result.started.map((p) => p.format)).toEqual(["reel"]);
    expect(result.skipped).toEqual([
      { platformAccountId: t.account?.id, format: "post", publicationId: oldPost?.id },
    ]);
  });

  it("sin texto aprobado es CONTENT_NOT_APPROVED", async () => {
    const t = await setup({ approve: false });
    await expect(publish(t)).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(t.publications.all()).toEqual([]);
  });

  it("sin cuenta conectada es ACCOUNT_NOT_CONNECTED; con las pendientes en una cuenta desconectada, también", async () => {
    const none = await setup({ account: false });
    await expect(publish(none)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });

    const t = await setup();
    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await expect(publish(t)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    expect(t.publications.all().map((p) => p.status)).toEqual(["approved", "approved"]);
    expect(t.queue.jobs).toEqual([]);
  });

  it("un aviso que no está listo ni publicado es LISTING_NOT_READY; uno que no existe, LISTING_NOT_FOUND", async () => {
    const t = await setup();
    await t.listings.changeStatus(t.listingId, "ready", "paused");
    await expect(publish(t)).rejects.toMatchObject({ code: "LISTING_NOT_READY" });
    await expect(
      publishListing(t.deps, {
        listingId: "no-existe",
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    expect(t.queue.jobs).toEqual([]);
  });

  it("un aviso active (ya publicado en otro formato) sí publica", async () => {
    const t = await setup();
    await t.listings.changeStatus(t.listingId, "ready", "active");
    await expect(publish(t)).resolves.toMatchObject({ started: [{}, {}] });
  });

  it("con una corrida activa es CONTENT_RUN_ACTIVE", async () => {
    const t = await setup();
    await t.contentRuns.create({ listingId: t.listingId, texts: false });
    await expect(publish(t)).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });
  });

  it("si la cola no está, quedan en publishing (el worker las reencola) y se informa el error", async () => {
    const t = await setup({
      queueFails: () =>
        new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true }),
    });
    await expect(publish(t)).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    expect(t.publications.all().map((p) => p.status)).toEqual(["publishing", "publishing"]);
  });
});

describe("startPublication", () => {
  it("publica una aprobada y encola solo esa", async () => {
    const t = await setup();
    const reel = t.byFormat("reel");
    const result = await startPublication(t.deps, {
      publicationId: reel?.id ?? "",
      dryRun: false,
      actor: "cli",
    });
    expect(result).toMatchObject({
      requeued: false,
      publication: { id: reel?.id, status: "publishing", dryRun: false, attempts: 1 },
    });
    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: reel?.id }]);
    expect(t.byFormat("post")?.status).toBe("approved");
  });

  it("una en publishing se reencola sin cambiarla (conserva su modo)", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" });
    const again = await startPublication(t.deps, {
      publicationId: post?.id ?? "",
      dryRun: false,
      actor: "cli",
    });
    expect(again).toMatchObject({
      requeued: true,
      publication: { status: "publishing", dryRun: true, attempts: 1 },
    });
    expect(t.queue.jobs).toHaveLength(2);
  });

  it("rechazos: no existe, publicada, descartada, cuenta desconectada y aviso no listo", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    const start = (publicationId: string) =>
      startPublication(t.deps, { publicationId, dryRun: true, actor: "cli" });

    await expect(start("no-existe")).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
    await markPublished(t, post?.id ?? "", true);
    await expect(start(post?.id ?? "")).rejects.toMatchObject({ code: "NOTHING_TO_PUBLISH" });

    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    await t.connect();
    await t.listings.changeStatus(t.listingId, "ready", "archived");
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "LISTING_NOT_READY" });

    await cancelPublication(t.deps, { publicationId: reel?.id ?? "", actor: "cli" });
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(t.queue.jobs).toEqual([]);
  });
});

describe("cancelPublication", () => {
  it("descarta una aprobada o fallida; el texto sigue aprobado y publicar abre otra", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const cancelled = await cancelPublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
    });
    expect(cancelled).toMatchObject({ id: post?.id, status: "cancelled" });
    const events = await t.publications.listEvents(post?.id ?? "");
    expect(events.at(-1)).toMatchObject({ fromStatus: "approved", toStatus: "cancelled" });
    const content = (await t.contents.listCurrent(t.listingId)).find(
      (item) => item.platform === "instagram",
    );
    expect(content?.status).toBe("approved");

    const result = await publish(t);
    expect(result.created.map((p) => p.format)).toEqual(["post"]);
  });

  it("una publicándose es PUBLICATION_IN_PROGRESS; una publicada, INVALID_TRANSITION (se retira)", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" });
    await expect(
      cancelPublication(t.deps, { publicationId: post?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_IN_PROGRESS" });
    await markPublished(t, reel?.id ?? "", true);
    await expect(
      cancelPublication(t.deps, { publicationId: reel?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: expect.stringContaining("retirada"),
    });
    await expect(
      cancelPublication(t.deps, { publicationId: "no-existe", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });
});

describe("retirePublication", () => {
  it("en live exige la confirmación de que se borró a mano, sin cambiar nada", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", false);
    await expect(
      retirePublication(t.deps, { publicationId: post?.id ?? "", actor: "operator" }),
    ).rejects.toMatchObject({ code: "REMOVAL_NOT_CONFIRMED" });
    expect(t.byFormat("post")?.status).toBe("published");
  });

  it("retirar la última publicada en live devuelve el aviso a ready; si queda otra, no", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await markPublished(t, post?.id ?? "", false);
    await markPublished(t, reel?.id ?? "", false);
    await t.listings.changeStatus(t.listingId, "ready", "active");

    const first = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(first).toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");

    const last = await retirePublication(t.deps, {
      publicationId: reel?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(last.listingBackToReady).toBe(true);
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
    const events = await t.publications.listEvents(reel?.id ?? "");
    expect(events.at(-1)).toMatchObject({
      fromStatus: "published",
      toStatus: "unpublished",
      payload: { mode: "live", removedByHand: true },
    });
  });

  it("en dry-run se retira sin confirmación y no toca el aviso", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", true);
    await t.listings.changeStatus(t.listingId, "ready", "active");
    const result = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
    });
    expect(result).toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("si el aviso ya no está active (lo cambiaron), no se toca", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", false);
    await t.listings.changeStatus(t.listingId, "ready", "archived");
    const result = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(result.listingBackToReady).toBe(false);
    expect((await t.listings.get(t.listingId))?.status).toBe("archived");
  });

  it("una que no está publicada es INVALID_TRANSITION; una que no existe, PUBLICATION_NOT_FOUND", async () => {
    const t = await setup();
    await expect(
      retirePublication(t.deps, { publicationId: t.byFormat("post")?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      retirePublication(t.deps, { publicationId: "no-existe", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });
});

describe("publishListing · cuentas, medios, cola y carreras", () => {
  it("solo mueve las de cuentas conectadas; las de una cuenta desconectada se informan en stranded", async () => {
    const t = await setup();
    const old = t.publications.all();
    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await t.platformAccounts.upsertConnected({
      brokerId: t.account?.brokerId ?? "",
      platform: "instagram",
      externalAccountId: "17841400000000002",
      displayName: "@otra",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "IGAA-otra" },
    });
    const result = await publish(t);
    expect(result.created.map((p) => p.format)).toEqual(["post", "reel"]);
    expect(result.started.map((p) => p.id)).toEqual(result.created.map((p) => p.id));
    expect(result.stranded.map((p) => [p.id, p.status])).toEqual(
      old.map((p) => [p.id, "approved"]),
    );
  });

  it("las nuevas quedan con su evento de nacimiento y el de publishing", async () => {
    const t = await setup({ account: false });
    await t.connect();
    const result = await publish(t);
    const events = await t.publications.listEvents(result.started[0]?.id ?? "");
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "approved"],
      ["approved", "publishing"],
    ]);
  });

  it("si la cola falla a mitad de camino, intenta todas y dice cuáles quedaron sin job; publicar otra vez las reencola", async () => {
    let calls = 0;
    const t = await setup({
      queueFails: () =>
        ++calls === 2
          ? new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true })
          : undefined,
    });
    const [post, reel] = [t.byFormat("post"), t.byFormat("reel")];
    await expect(publish(t)).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      details: { publicationIds: [reel?.id] },
    });
    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: post?.id }]);
    expect(t.publications.all().map((p) => p.status)).toEqual(["publishing", "publishing"]);

    const again = await publish(t);
    expect(again.requeued.map((p) => p.id)).toEqual([post?.id, reel?.id]);
  });

  it("una fallida que empezó en live no se reintenta en dry-run (PUBLISH_MODE_LOCKED); en live sí", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, t.byFormat("reel")?.id ?? "", true);
    await t.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "system" },
    );
    await t.publications.saveProgress(post?.id ?? "", {
      attemptStartedAt: "2026-10-05T12:00:00.000Z",
      childIds: [],
      containerId: "c-1",
    });
    await t.publications.transition(
      post?.id ?? "",
      {
        from: "publishing",
        to: "failed",
        changes: {
          lastError: { code: "IG_PUBLISH_OUTCOME_UNKNOWN", message: "x", retriable: false },
        },
      },
      { actor: "system" },
    );
    await expect(publish(t, true)).rejects.toMatchObject({ code: "PUBLISH_MODE_LOCKED" });
    await expect(
      startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLISH_MODE_LOCKED" });
    expect(t.byFormat("post")?.status).toBe("failed");
    await expect(publish(t, false)).resolves.toMatchObject({ started: [{ id: post?.id }] });
  });

  it("dos publicar a la vez: el segundo espera al candado y solo reencola lo que el primero inició", async () => {
    const t = await setup();
    const plain = { ...t.deps, lock: createInMemoryListingLock(t.locked) };
    const [first, second] = await Promise.all([
      publishListing(plain, {
        listingId: t.listingId,
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      }),
      publishListing(plain, {
        listingId: t.listingId,
        platform: "instagram",
        dryRun: false,
        actor: "cli",
      }),
    ]);
    expect(first.started).toHaveLength(2);
    expect(second.started).toEqual([]);
    expect(second.requeued.map((p) => p.dryRun)).toEqual([true, true]);
    expect(t.publications.all().map((p) => p.attempts)).toEqual([1, 1]);
  });

  it("publicar y descartar a la vez quedan en orden: o se descarta antes, o se publica y descartar espera", async () => {
    const t = await setup();
    const plain = { ...t.deps, lock: createInMemoryListingLock(t.locked) };
    const reel = t.byFormat("reel");
    const [cancelled, published] = await Promise.allSettled([
      cancelPublication(plain, { publicationId: reel?.id ?? "", actor: "operator" }),
      publishListing(plain, {
        listingId: t.listingId,
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      }),
    ]);
    const formats =
      published.status === "fulfilled" ? published.value.started.map((p) => p.format) : [];
    if (cancelled.status === "fulfilled") {
      expect(formats).toEqual(["post"]);
      expect(t.byFormat("reel")?.status).toBe("cancelled");
    } else {
      expect(cancelled.reason).toMatchObject({ code: "PUBLICATION_IN_PROGRESS" });
      expect(formats).toEqual(["post", "reel"]);
    }
  });
});

describe("startPublication · revisiones", () => {
  it("reintenta una fallida conservando el progreso", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const progress = {
      attemptStartedAt: "2026-10-05T12:00:00.000Z",
      childIds: [],
      containerId: "c-1",
    };
    await t.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    await t.publications.saveProgress(post?.id ?? "", progress);
    await t.publications.transition(
      post?.id ?? "",
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "X", message: "x", retriable: true } },
      },
      { actor: "system" },
    );
    const result = await startPublication(t.deps, {
      publicationId: post?.id ?? "",
      dryRun: true,
      actor: "cli",
    });
    expect(result.publication).toMatchObject({ attempts: 2, progress, lastError: null });
  });

  it("con una corrida activa es CONTENT_RUN_ACTIVE; con su texto ya no aprobado, CONTENT_NOT_APPROVED", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const run = await t.contentRuns.create({ listingId: t.listingId, texts: false });
    await expect(
      startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });
    await t.contentRuns.markRunning(run.id);
    await t.contentRuns.markFailed(run.id, { code: "X", message: "x" });
    await t.contents.update(post?.contentId ?? "", { status: "edited" });
    await expect(
      startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(t.queue.jobs).toEqual([]);
  });
});
