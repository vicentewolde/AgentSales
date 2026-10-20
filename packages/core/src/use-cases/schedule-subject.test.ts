import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { OUTCOME_UNKNOWN } from "../publish/outcome.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import {
  createPostPublicationScenario,
  createPublicationScenario,
  createSendOncePublisher,
  type PostPublicationScenario,
} from "../testing/index.js";
import { cancelPublication } from "./cancel-publication.js";
import { publishPost } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";
import { retirePublication } from "./retire-publication.js";
import {
  scheduleListings,
  schedulePost,
  schedulePublication,
  unschedulePublication,
} from "./schedule-publications.js";
import { startDuePublications } from "./start-due-publications.js";
import { startPublication } from "./start-publication.js";
import { STALE_PUBLISHING_MS, watchPublications } from "./watch-publications.js";

// F9-T07 (ADR-0029 punto 4): programar, el reloj de cada minuto, la vigilancia, descartar y
// retirar sobre un post, con los mismos casos de uso que un aviso.

const NOW = new Date("2026-10-20T15:00:00.000Z");
const AT = new Date("2026-10-20T16:00:00.000Z");
const AFTER = new Date("2026-10-20T16:00:30.000Z");

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return isAppError(error) ? error.code : error;
};

const schedule = (t: PostPublicationScenario, publication: Publication, at = AT, dryRun = false) =>
  schedulePublication(
    { ...t.deps, now: () => NOW },
    { publicationId: publication.id, at, dryRun, actor: "operator" },
  );

const due = (t: PostPublicationScenario, now: Date) =>
  startDuePublications({ ...t.deps, now: () => now });

const twoLanguages = () =>
  createPostPublicationScenario({
    texts: [
      { platform: "discord", language: "es" },
      { platform: "x", language: "es" },
      { platform: "x", language: "en" },
    ],
  });

describe("un post de punta a punta", () => {
  it("aprobar → programar → el reloj lo empieza → falla y se reintenta → published", async () => {
    const t = await createPostPublicationScenario();
    const approved = t.publicationOf("discord");
    expect(approved.status).toBe("approved");

    await expect(schedule(t, approved)).resolves.toMatchObject({
      status: "scheduled",
      scheduledAt: AT,
      dryRun: false,
    });
    // Antes de la hora no sale.
    expect((await due(t, NOW)).started).toEqual([]);

    expect(await due(t, AFTER)).toEqual({
      started: [approved.id],
      notQueued: [],
      failed: [],
      skipped: [],
      errors: [],
    });
    expect(t.current(approved.id)).toMatchObject({ status: "publishing", attempts: 1 });
    expect(t.queue.jobs).toEqual([
      {
        name: "publication.publish",
        data: { publicationId: approved.id },
        options: { singletonKey: approved.id },
      },
    ]);
    expect((await t.publications.listEvents(approved.id)).at(-1)).toMatchObject({
      fromStatus: "scheduled",
      toStatus: "publishing",
      actor: "system",
    });

    // Un error pasajero que prueba que no salió: la cola reintenta y el reintento publica.
    const transient = new AppError("DISCORD_UNAVAILABLE", "Discord no respondió", {
      retriable: true,
    });
    const discord = createSendOncePublisher("discord", { steps: [{ notSent: transient }] });
    const deps = t.publishDeps({ discord }, { now: () => AFTER });
    await expect(
      publishPublication(deps, { publicationId: approved.id, isLastAttempt: false }),
    ).rejects.toBe(transient);
    expect(t.current(approved.id)?.status).toBe("publishing");

    await expect(
      publishPublication(deps, { publicationId: approved.id, isLastAttempt: false, retryCount: 1 }),
    ).resolves.toMatchObject({
      outcome: "published",
      publication: { status: "published", externalId: "msg-2" },
    });
    expect(discord.sends).toHaveLength(2);
    // Un post nunca pasa a `active`: el post sigue `ready` y no hay aviso que tocar.
    expect((await t.posts.get(t.post.id))?.status).toBe("ready");
  });

  it("publicar ahora adelanta lo programado de un post, en su candado", async () => {
    const t = await createPostPublicationScenario();
    const scheduled = await schedule(t, t.publicationOf("discord"));

    const { publication, requeued } = await startPublication(t.deps, {
      publicationId: scheduled.id,
      dryRun: true,
      actor: "operator",
    });

    expect(requeued).toBe(false);
    expect(publication).toMatchObject({ status: "publishing", dryRun: true, scheduledAt: null });
    expect(t.queue.jobs).toHaveLength(1);
  });
});

describe("el reloj con posts", () => {
  it("una de un post atrasada más de 12 h no sale sola: espera al operador", async () => {
    const t = await createPostPublicationScenario();
    const publication = await schedule(t, t.publicationOf("discord"));

    const late = new Date(AT.getTime() + SCHEDULE_OVERDUE_MS + 60_000);
    expect((await due(t, late)).started).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("scheduled");
  });

  it("si el post ya no se puede publicar, queda failed con el motivo", async () => {
    const t = await createPostPublicationScenario();
    const publication = await schedule(t, t.publicationOf("discord"));
    await t.platformAccounts.changeStatus(t.accounts.get("discord") ?? "", "connected", "expired");

    const result = await due(t, AFTER);

    expect(result.failed).toEqual([
      { publicationId: publication.id, code: "ACCOUNT_NOT_CONNECTED" },
    ]);
    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      lastError: { code: "ACCOUNT_NOT_CONNECTED" },
    });
    expect(t.queue.jobs).toEqual([]);
  });

  it("una cuenta en modo manual: a la hora queda lista para publicar a mano, sin llamar a la red", async () => {
    const t = await createPostPublicationScenario({
      texts: [{ platform: "linkedin", language: "es" }],
      accounts: [{ platform: "linkedin", meta: { mode: "manual" } }],
    });
    const publication = await schedule(t, t.publicationOf("linkedin"));

    expect((await due(t, AFTER)).started).toEqual([publication.id]);
    await expect(
      publishPublication(t.publishDeps({}), {
        publicationId: publication.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({
      outcome: "awaiting_manual_confirm",
      publication: { status: "awaiting_manual_confirm" },
    });
  });

  it("sin el candado del post, la de un post queda en errores y sigue programada", async () => {
    const t = await createPostPublicationScenario();
    const publication = await schedule(t, t.publicationOf("discord"));
    const { postLock: _postLock, ...onlyListings } = t.deps;

    const result = await startDuePublications({ ...onlyListings, now: () => AFTER });

    expect(result.errors).toEqual([{ publicationId: publication.id, code: "SUBJECT_NOT_LISTING" }]);
    expect(t.current(publication.id)?.status).toBe("scheduled");
  });
});

describe("programar un post", () => {
  it("revisa lo mismo que publicar: resultado dudoso, en curso y cuenta desconectada", async () => {
    const t = await twoLanguages();
    const discord = t.publicationOf("discord");
    const xEs = t.publicationOf("x", "es");
    const xEn = t.publicationOf("x", "en");

    await t.toPublishing(discord);
    expect(await codeOf(schedule(t, discord))).toBe("PUBLICATION_IN_PROGRESS");
    await t.publications.transition(
      discord.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    expect(await codeOf(schedule(t, discord))).toBe("OUTCOME_UNKNOWN_PENDING");

    await t.platformAccounts.changeStatus(t.accounts.get("x") ?? "", "connected", "expired");
    expect(await codeOf(schedule(t, xEs))).toBe("ACCOUNT_NOT_CONNECTED");
    expect(t.current(xEs.id)?.status).toBe("approved");
    expect(t.current(xEn.id)?.status).toBe("approved");
  });

  it("schedulePost programa cada red con texto aprobado, todos sus idiomas, en el candado del post", async () => {
    const t = await twoLanguages();

    const { results } = await schedulePost(
      { ...t.deps, now: () => NOW },
      { postId: t.post.id, at: AT, dryRun: true, actor: "operator" },
    );

    expect(
      results.map((result) =>
        result.outcome === "scheduled"
          ? { platform: result.platform, languages: result.publications.map((p) => p.language) }
          : result,
      ),
    ).toEqual([
      { platform: "x", languages: ["es", "en"] },
      { platform: "discord", languages: ["es"] },
    ]);
    expect(
      t.publications.all().every((p) => p.status === "scheduled" && p.scheduledAt?.getTime()),
    ).toBe(true);
    expect(t.publications.all().every((p) => p.dryRun)).toBe(true);
  });

  it("schedulePost informa la red pedida que no se puede programar, sin cortar las demás", async () => {
    const t = await createPostPublicationScenario();

    const { results } = await schedulePost(
      { ...t.deps, now: () => NOW },
      {
        postId: t.post.id,
        platforms: ["instagram", "discord"],
        at: AT,
        dryRun: false,
        actor: "operator",
      },
    );

    expect(results).toMatchObject([
      { platform: "instagram", outcome: "skipped", code: "CONTENT_NOT_APPROVED" },
      { platform: "discord", outcome: "scheduled", at: AT },
    ]);
  });

  it("schedulePost sin nada que programar da una fila sin red; la hora se revisa antes", async () => {
    const t = await createPostPublicationScenario();
    await t.platformAccounts.changeStatus(t.accounts.get("discord") ?? "", "connected", "expired");

    await expect(
      schedulePost(
        { ...t.deps, now: () => NOW },
        { postId: t.post.id, at: AT, dryRun: false, actor: "operator" },
      ),
    ).resolves.toEqual({
      results: [
        {
          platform: null,
          outcome: "skipped",
          code: "NOTHING_TO_PUBLISH",
          message: "El post no tiene redes con el texto aprobado y la cuenta conectada",
        },
      ],
    });
    expect(
      await codeOf(
        schedulePost(
          { ...t.deps, now: () => NOW },
          { postId: t.post.id, at: NOW, dryRun: false, actor: "operator" },
        ),
      ),
    ).toBe("SCHEDULE_TOO_SOON");
  });

  it("las redes del post mandan (F9-T21): sin redes pedidas, solo las suyas; una que le quitaron no se programa ni se publica", async () => {
    const t = await twoLanguages();
    // El operador le quitó X al post: sus textos siguen aprobados, pero ya no corresponden.
    await t.posts.update(t.post.id, { platforms: ["discord"] });

    const { results } = await schedulePost(
      { ...t.deps, now: () => NOW },
      { postId: t.post.id, at: AT, dryRun: true, actor: "operator" },
    );
    expect(results.map((result) => [result.platform, result.outcome])).toEqual([
      ["discord", "scheduled"],
    ]);
    expect(t.current(t.publicationOf("x", "es").id)?.status).toBe("approved");
    expect(t.current(t.publicationOf("x", "en").id)?.status).toBe("approved");

    // Pedida a mano, se informa con su motivo; publicarla, igual.
    const asked = await schedulePost(
      { ...t.deps, now: () => NOW },
      { postId: t.post.id, platforms: ["x"], at: AT, dryRun: true, actor: "operator" },
    );
    expect(asked.results).toMatchObject([
      { platform: "x", outcome: "skipped", code: "POST_PLATFORM_EXCLUDED" },
    ]);
    expect(
      await codeOf(
        publishPost(t.deps, { postId: t.post.id, platform: "x", dryRun: true, actor: "operator" }),
      ),
    ).toBe("POST_PLATFORM_EXCLUDED");
    expect(t.current(t.publicationOf("x", "es").id)?.status).toBe("approved");

    // Si la red vuelve al post, su texto aprobado vuelve a servir.
    await t.posts.update(t.post.id, { platforms: null });
    const back = await schedulePost(
      { ...t.deps, now: () => NOW },
      { postId: t.post.id, platforms: ["x"], at: AT, dryRun: true, actor: "operator" },
    );
    expect(back.results).toMatchObject([{ platform: "x", outcome: "scheduled" }]);
  });

  it("publishPost publica la red con todos sus idiomas y encola después del candado", async () => {
    const t = await twoLanguages();

    const result = await publishPost(t.deps, {
      postId: t.post.id,
      platform: "x",
      dryRun: true,
      actor: "operator",
    });

    expect(result.started.map((p) => p.language)).toEqual(["es", "en"]);
    expect(result.started.every((p) => p.status === "publishing" && p.dryRun)).toBe(true);
    expect(t.queue.jobs.map((job) => job.data)).toEqual(
      result.started.map((p) => ({ publicationId: p.id })),
    );
    expect(t.current(t.publicationOf("discord").id)?.status).toBe("approved");
    // Otra vez: nada que iniciar, pero las que están en curso se reencolan.
    await expect(
      publishPost(t.deps, { postId: t.post.id, platform: "x", dryRun: true, actor: "operator" }),
    ).resolves.toMatchObject({ started: [], requeued: [{}, {}] });
  });
});

describe("desprogramar, descartar y retirar un post", () => {
  it("desprogramar vuelve a approved y descartar una programada la deja cancelled", async () => {
    const t = await twoLanguages();
    const discord = await schedule(t, t.publicationOf("discord"));
    const x = await schedule(t, t.publicationOf("x", "es"));

    await expect(
      unschedulePublication(t.deps, { publicationId: discord.id, actor: "operator" }),
    ).resolves.toMatchObject({ status: "approved", scheduledAt: null });
    await expect(
      cancelPublication(t.deps, { publicationId: x.id, actor: "operator" }),
    ).resolves.toMatchObject({ status: "cancelled", scheduledAt: null });
    // El reloj ya no la ve.
    expect((await due(t, AFTER)).started).toEqual([]);
  });

  it("descartar una en curso no se puede (no existe publishing → cancelled)", async () => {
    const t = await createPostPublicationScenario();
    const publication = await t.toPublishing(t.publicationOf("discord"));
    expect(
      await codeOf(cancelPublication(t.deps, { publicationId: publication.id, actor: "operator" })),
    ).toBe("PUBLICATION_IN_PROGRESS");
  });

  it("retirar una publicada en vivo: unpublished, sin aviso que devolver a ready", async () => {
    const t = await createPostPublicationScenario();
    const publication = await t.toPublishing(t.publicationOf("discord"));
    await publishPublication(t.publishDeps({ discord: createSendOncePublisher("discord") }), {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    await expect(
      retirePublication(t.deps, {
        publicationId: publication.id,
        actor: "operator",
        removedByHand: true,
      }),
    ).resolves.toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
  });

  it("sin el candado del post, descartar es SUBJECT_NOT_LISTING sin cambiar nada", async () => {
    const t = await createPostPublicationScenario();
    const publication = t.publicationOf("discord");
    expect(
      await codeOf(
        cancelPublication(
          { lock: t.lock, publications: t.publications },
          { publicationId: publication.id, actor: "operator" },
        ),
      ),
    ).toBe("SUBJECT_NOT_LISTING");
    expect(t.current(publication.id)?.status).toBe("approved");
  });
});

describe("la vigilancia con posts", () => {
  const later = () => new Date(Date.now() + STALE_PUBLISHING_MS + 60_000);
  const watch = (t: PostPublicationScenario) =>
    watchPublications({
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      queue: t.queue,
      now: later,
    });

  it("reencola la publishing atascada de un post (también de una cuenta a mano) y no toca las que esperan al operador", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "discord", language: "es" },
        { platform: "linkedin", language: "es" },
        { platform: "x", language: "es" },
      ],
      accounts: [
        { platform: "discord" },
        { platform: "linkedin", meta: { mode: "manual" } },
        { platform: "x" },
      ],
    });
    const discord = await t.toPublishing(t.publicationOf("discord"));
    const linkedin = await t.toPublishing(t.publicationOf("linkedin"));
    const x = await t.toPublishing(t.publicationOf("x"));
    await t.publications.transition(
      x.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );

    const result = await watch(t);

    expect([...result.requeued].sort()).toEqual([discord.id, linkedin.id].sort());
    expect(result.syncs).toEqual({ enqueued: 0, alreadyQueued: 0, failed: [] });
    expect(t.current(x.id)?.status).toBe("outcome_unknown");
    // Reencolar la de la cuenta a mano no la publica: el intento solo la deja lista.
    await expect(
      publishPublication(t.publishDeps({}), { publicationId: linkedin.id, isLastAttempt: false }),
    ).resolves.toMatchObject({ outcome: "awaiting_manual_confirm" });
    expect((await watch(t)).requeued).not.toContain(linkedin.id);
  });
});

describe("revisiones del post (ajustes de la revisión de F9-T07)", () => {
  const postScheduled = async (status: "archived" | "idea") => {
    const t = await createPostPublicationScenario();
    const publication = await schedule(t, t.publicationOf("discord"));
    await t.posts.update(t.post.id, { status });
    return { t, publication };
  };

  it("un post archivado o idea es POST_NOT_READY al publicar, programar y publicar una", async () => {
    for (const status of ["archived", "idea"] as const) {
      const t = await createPostPublicationScenario();
      const publication = t.publicationOf("discord");
      await t.posts.update(t.post.id, { status });

      expect(
        await codeOf(
          publishPost(t.deps, {
            postId: t.post.id,
            platform: "discord",
            dryRun: true,
            actor: "operator",
          }),
        ),
      ).toBe("POST_NOT_READY");
      expect(
        await codeOf(
          schedulePost(
            { ...t.deps, now: () => NOW },
            { postId: t.post.id, at: AT, dryRun: true, actor: "operator" },
          ),
        ),
      ).toBe("POST_NOT_READY");
      expect(
        await codeOf(
          startPublication(t.deps, {
            publicationId: publication.id,
            dryRun: true,
            actor: "operator",
          }),
        ),
      ).toBe("POST_NOT_READY");
      expect(await codeOf(schedule(t, publication))).toBe("POST_NOT_READY");
      expect(t.current(publication.id)?.status).toBe("approved");
      expect(t.queue.jobs).toEqual([]);
    }
  });

  it("a la hora, la programada de un post archivado queda failed con POST_NOT_READY", async () => {
    const { t, publication } = await postScheduled("archived");

    expect((await due(t, AFTER)).failed).toEqual([
      { publicationId: publication.id, code: "POST_NOT_READY" },
    ]);
    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      lastError: { code: "POST_NOT_READY" },
    });
    expect(t.queue.jobs).toEqual([]);
  });

  it("publishPost con una corrida activa es CONTENT_RUN_ACTIVE y con una dudosa OUTCOME_UNKNOWN_PENDING", async () => {
    const t = await twoLanguages();
    const run = await t.repos.contentRuns.create({ postId: t.post.id, texts: true });
    const error = await caught(
      publishPost(t.deps, { postId: t.post.id, platform: "x", dryRun: true, actor: "operator" }),
    );
    expect(error).toMatchObject({
      code: "CONTENT_RUN_ACTIVE",
      details: { postId: t.post.id, contentRunId: run.id },
    });
    await t.repos.contentRuns.markRunning(run.id);
    await t.repos.contentRuns.markFailed(run.id, {
      code: "LLM_ERROR",
      message: "x",
    });

    const xEn = await t.toPublishing(t.publicationOf("x", "en"));
    await t.publications.transition(
      xEn.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    await expect(
      caught(
        publishPost(t.deps, { postId: t.post.id, platform: "x", dryRun: true, actor: "operator" }),
      ),
    ).resolves.toMatchObject({
      code: "OUTCOME_UNKNOWN_PENDING",
      details: { publicationId: xEn.id },
    });
    expect(t.current(t.publicationOf("x", "es").id)?.status).toBe("approved");
  });

  it("un aviso con resultado dudoso: publicar o programar esa publicación da OUTCOME_UNKNOWN_PENDING (cambio intencional desde F9-T06)", async () => {
    const t = await createPublicationScenario();
    const publication = t.byFormat("post") as Publication;
    await t.publications.transition(
      publication.id,
      { from: "approved", to: "publishing", changes: { dryRun: false } },
      { actor: "operator" },
    );
    await t.publications.transition(
      publication.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );

    expect(
      await codeOf(
        startPublication(t.deps, {
          publicationId: publication.id,
          dryRun: false,
          actor: "operator",
        }),
      ),
    ).toBe("OUTCOME_UNKNOWN_PENDING");
    expect(
      await codeOf(
        schedulePublication(
          { ...t.deps, now: () => new Date() },
          {
            publicationId: publication.id,
            at: new Date(Date.now() + 3600e3),
            dryRun: false,
            actor: "operator",
          },
        ),
      ),
    ).toBe("OUTCOME_UNKNOWN_PENDING");
    expect(t.publications.all().find((p) => p.id === publication.id)?.status).toBe(
      "outcome_unknown",
    );
  });
});

describe("una publicación a mano que espera confirmación", () => {
  const manualLinkedIn = async () => {
    const t = await createPostPublicationScenario({
      texts: [{ platform: "linkedin", language: "es" }],
      accounts: [{ platform: "linkedin", meta: { mode: "manual" } }],
    });
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await publishPublication(t.publishDeps({}), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    expect(t.current(publication.id)?.status).toBe("awaiting_manual_confirm");
    return { t, publication };
  };

  it("MANUAL_CONFIRM_PENDING habla de publicarla a mano en su red, no de Marketplace", async () => {
    const { t, publication } = await manualLinkedIn();
    for (const attempt of [
      startPublication(t.deps, { publicationId: publication.id, dryRun: false, actor: "operator" }),
      schedule(t, publication),
      cancelPublication(t.deps, { publicationId: publication.id, actor: "operator" }),
    ]) {
      const error = await caught(attempt);
      expect(error).toMatchObject({
        code: "MANUAL_CONFIRM_PENDING",
        message: expect.stringContaining("publiques a mano en LinkedIn"),
      });
      expect((error as AppError).message).not.toContain("Marketplace");
    }
  });

  it("publicar la red cuando todo espera confirmación dice eso, no que está publicado", async () => {
    const { t, publication } = await manualLinkedIn();
    const error = await caught(
      publishPost(t.deps, {
        postId: t.post.id,
        platform: "linkedin",
        dryRun: false,
        actor: "operator",
      }),
    );
    expect(error).toMatchObject({
      code: "NOTHING_TO_PUBLISH",
      message: expect.stringContaining("esperan tu confirmación"),
      details: { publicationIds: [publication.id] },
    });
  });
});

describe("un error pasajero corta el pedido de programar", () => {
  const transient = () =>
    new AppError("DB_UNAVAILABLE", "la base no respondió", { retriable: true });

  it("schedulePost lo relanza en vez de dejar la red como saltada", async () => {
    const t = await createPostPublicationScenario();
    const failure = transient();
    await expect(
      schedulePost(
        {
          ...t.deps,
          postLock: {
            run: async () => {
              throw failure;
            },
          },
          now: () => NOW,
        },
        { postId: t.post.id, at: AT, dryRun: true, actor: "operator" },
      ),
    ).rejects.toBe(failure);
  });

  it("scheduleListings también (paridad)", async () => {
    const t = await createPublicationScenario();
    const failure = transient();
    await expect(
      scheduleListings(
        {
          ...t.deps,
          lock: {
            run: async () => {
              throw failure;
            },
          },
          now: () => NOW,
        },
        { listingIds: [t.listingId], at: AT, dryRun: true, actor: "operator" },
      ),
    ).rejects.toBe(failure);
  });
});
