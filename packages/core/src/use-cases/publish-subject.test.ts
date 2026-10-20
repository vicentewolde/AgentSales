import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { OUTCOME_UNKNOWN } from "../publish/outcome.js";
import {
  createFakePublisher,
  createPostPublicationScenario,
  createPublicationScenario,
  createSendOncePublisher,
  POST_SCENARIO_TOKEN,
} from "../testing/index.js";
import { cancelPublication } from "./cancel-publication.js";
import { confirmManualPublication, markNotPublished } from "./confirm-manual-publication.js";
import { publishListing } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";
import { resolvePublication } from "./resolve-publication.js";
import { schedulePublication } from "./schedule-publications.js";
import { startPublication } from "./start-publication.js";
import { unapproveContent } from "./unapprove-content.js";

// F9-T06 (ADR-0029 puntos 8, 9 y 11): el intento de publicar sobre un sujeto, el resultado dudoso,
// el traspaso a mano por cuenta y el access token al publicar.

const NOW = new Date("2026-10-20T15:00:00Z");
const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return isAppError(error) ? error.code : error;
};

const attemptsOf = async (
  t: { publications: { listEvents(id: string): Promise<{ type: string; payload: unknown }[]> } },
  publication: Publication,
) =>
  (await t.publications.listEvents(publication.id))
    .filter((event) => event.type === "publish_attempt")
    .map((event) => event.payload as { result: string; sent?: { caption: string } });

describe("publishPublication con un post", () => {
  it("publica con los medios del post, el idioma de la publicación y los hashtags dentro del texto", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "x", language: "es" },
        { platform: "x", language: "en" },
      ],
    });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const deps = t.publishDeps({ x }, { now: () => NOW });
    const en = await t.toPublishing(t.publicationOf("x", "en"));

    const result = await publishPublication(deps, { publicationId: en.id, isLastAttempt: false });

    expect(result).toMatchObject({
      outcome: "published",
      publication: {
        status: "published",
        externalId: "msg-1",
        externalUrl: "https://example.test/x/1",
        publishedAt: NOW,
      },
    });
    const [sent] = x.sends;
    expect(sent).toMatchObject({
      platform: "x",
      format: "post",
      language: "en",
      title: null,
      // X no separa los hashtags: van dentro del texto (`socialCaption`).
      caption: "Texto en en para x\n\n#agentpey #ia",
      media: [{ mediaId: t.image.id, storagePath: `posts/${t.post.id}/ig_4x5/foto.jpg` }],
    });
    expect(sent?.listing).toBeUndefined();
    // Un post nunca pasa a `active`: no hay aviso que tocar, y el post sigue como estaba.
    expect((await t.posts.get(t.post.id))?.status).toBe("ready");
    // Lo guardado en la bitácora no lleva el token.
    expect(JSON.stringify(await t.publications.listEvents(en.id))).not.toContain(
      POST_SCENARIO_TOKEN,
    );
  });

  it("Discord va con el cuerpo, sin hashtags", async () => {
    const t = await createPostPublicationScenario();
    const discord = createSendOncePublisher("discord");
    const publication = await t.toPublishing(t.publicationOf("discord"));
    await publishPublication(t.publishDeps({ discord }), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    expect(discord.sends[0]?.caption).toBe("Texto en es para discord");
  });

  it("sin publisher de la red: PUBLISHER_NOT_CONFIGURED y failed", async () => {
    const t = await createPostPublicationScenario();
    const publication = await t.toPublishing(t.publicationOf("discord"));
    expect(
      await codeOf(
        publishPublication(t.publishDeps({}), {
          publicationId: publication.id,
          isLastAttempt: false,
        }),
      ),
    ).toBe("PUBLISHER_NOT_CONFIGURED");
    expect(t.current(publication.id)?.status).toBe("failed");
  });
});

describe("resultado dudoso (ADR-0029 punto 8)", () => {
  it("un corte justo al enviar deja outcome_unknown y ningún intento posterior vuelve a llamar", async () => {
    const t = await createPostPublicationScenario();
    const discord = createSendOncePublisher("discord", { steps: ["cut"], now: () => NOW });
    const deps = t.publishDeps({ discord }, { now: () => NOW });
    const publication = await t.toPublishing(t.publicationOf("discord"));

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "outcome_unknown",
      publication: {
        status: "outcome_unknown",
        lastError: { code: OUTCOME_UNKNOWN, retriable: false },
        progress: { send: { startedAt: NOW.toISOString() } },
      },
    });
    expect(discord.sends).toHaveLength(1);
    const attempts = await attemptsOf(t, publication);
    expect(attempts.map((attempt) => attempt.result)).toEqual(["outcome_unknown"]);
    expect(attempts[0]?.sent?.caption).toBe("Texto en es para discord");

    // Otro intento (un job repetido) no publica: la publicación ya no está en `publishing`.
    await expect(
      publishPublication(deps, { publicationId: publication.id, isLastAttempt: true }),
    ).resolves.toEqual({ outcome: "skipped", status: "outcome_unknown" });
    expect(discord.sends).toHaveLength(1);
  });

  it("un corte del worker tras «enviando» deja publishing; el reintento no vuelve a llamar y la deja dudosa", async () => {
    const t = await createPostPublicationScenario();
    // Core no carga los tipos de Node: una señal mínima que se dispara a mitad del envío.
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const controller = {
      signal,
      abort: () => {
        signal.aborted = true;
      },
    };
    const discord = createSendOncePublisher("discord", { steps: [{ abort: controller }] });
    const deps = t.publishDeps({ discord });
    const publication = await t.toPublishing(t.publicationOf("discord"));

    expect(
      await codeOf(
        publishPublication(deps, {
          publicationId: publication.id,
          isLastAttempt: true,
          signal: controller.signal,
        }),
      ),
    ).toBe("PUBLISH_ABORTED");
    expect(t.current(publication.id)).toMatchObject({
      status: "publishing",
      progress: { send: { startedAt: expect.any(String) } },
    });
    // Lo que reencola el arranque del worker (o la vigilancia) ve la publicación del post.
    expect((await t.publications.listByStatus("publishing")).map((p) => p.id)).toEqual([
      publication.id,
    ]);
    expect(
      (
        await t.publications.listStalePublishing({
          before: new Date(Date.now() + 60_000),
          excludePlatforms: [],
        })
      ).map((p) => p.id),
    ).toEqual([publication.id]);

    const retried = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
      retryCount: 1,
    });

    expect(retried).toMatchObject({ outcome: "outcome_unknown" });
    expect(t.current(publication.id)?.lastError).toMatchObject({ code: OUTCOME_UNKNOWN });
    expect(discord.sends).toHaveLength(1);
  });

  it("un error que prueba que no salió borra el «enviando»: la cola reintenta y el reintento publica", async () => {
    const t = await createPostPublicationScenario();
    const limited = new AppError("DISCORD_UNAVAILABLE", "Discord no respondió", {
      retriable: true,
    });
    const discord = createSendOncePublisher("discord", { steps: [{ notSent: limited }, "ok"] });
    const deps = t.publishDeps({ discord });
    const publication = await t.toPublishing(t.publicationOf("discord"));

    await expect(
      publishPublication(deps, { publicationId: publication.id, isLastAttempt: false }),
    ).rejects.toBe(limited);
    expect(t.current(publication.id)).toMatchObject({ status: "publishing", progress: null });

    await expect(
      publishPublication(deps, {
        publicationId: publication.id,
        isLastAttempt: false,
        retryCount: 1,
      }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect(discord.sends).toHaveLength(2);
  });

  it("si el resultado quedó en el progreso pero no se guardó `published`, el reintento lo guarda sin llamar", async () => {
    const t = await createPostPublicationScenario();
    const discord = createSendOncePublisher("discord");
    const publication = await t.toPublishing(t.publicationOf("discord"));
    await t.publications.saveProgress(publication.id, {
      send: {
        startedAt: NOW.toISOString(),
        result: { externalId: "msg-9", externalUrl: "https://example.test/discord/9" },
      },
    });

    await expect(
      publishPublication(t.publishDeps({ discord }), {
        publicationId: publication.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({ outcome: "published", publication: { externalId: "msg-9" } });
    expect(discord.sends).toEqual([]);
  });

  it("un aviso con OUTCOME_UNKNOWN del publisher queda dudoso y no pasa a active", async () => {
    const t = await createPublicationScenario();
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const [post] = started;
    if (post === undefined) throw new Error("falta la publicación");
    const fake = createFakePublisher({
      steps: [{ error: new AppError(OUTCOME_UNKNOWN, "no se sabe") }],
    });
    const deps = {
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      contents: t.contents,
      media: t.media,
      listings: t.listings,
      brokers: t.brokers,
      storage: t.storage,
      publishers: { instagram: fake },
      workerMode: "live" as const,
      marketplaceAutomation: true,
      mercadoLibre: null,
    };
    await expect(
      publishPublication(deps, { publicationId: post.id, isLastAttempt: false }),
    ).resolves.toMatchObject({ outcome: "outcome_unknown" });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
  });
});

describe("resolvePublication", () => {
  /** Un post de Discord con resultado dudoso. */
  async function unknownPost() {
    const t = await createPostPublicationScenario();
    const discord = createSendOncePublisher("discord", { steps: ["cut"] });
    const deps = t.publishDeps({ discord });
    const publication = await t.toPublishing(t.publicationOf("discord"));
    await publishPublication(deps, { publicationId: publication.id, isLastAttempt: false });
    return { t, discord, deps, publication };
  }

  it("«salió» con el enlace: published con el enlace limpio, en el candado del post", async () => {
    const { t, publication } = await unknownPost();
    const result = await resolvePublication(t.subjectDeps, {
      publicationId: publication.id,
      outcome: "published",
      url: "https://discord.com/channels/1/2/3?ref=abc",
      actor: "operator",
    });
    expect(result).toMatchObject({
      changed: true,
      publication: {
        status: "published",
        externalId: "https://discord.com/channels/1/2/3",
        externalUrl: "https://discord.com/channels/1/2/3",
        lastError: null,
      },
    });
    expect(t.postLock.busy()).toEqual([]);
    // Repetir lo mismo no cambia nada; con otro enlace, ya está confirmada.
    await expect(
      resolvePublication(t.subjectDeps, {
        publicationId: publication.id,
        outcome: "published",
        actor: "operator",
      }),
    ).resolves.toMatchObject({ changed: false });
    expect(
      await codeOf(
        resolvePublication(t.subjectDeps, {
          publicationId: publication.id,
          outcome: "published",
          url: "https://discord.com/channels/1/2/4",
          actor: "operator",
        }),
      ),
    ).toBe("PUBLICATION_ALREADY_CONFIRMED");
  });

  it("«salió» sin enlace: published sin enlace", async () => {
    const { t, publication } = await unknownPost();
    await expect(
      resolvePublication(t.subjectDeps, {
        publicationId: publication.id,
        outcome: "published",
        actor: "cli",
      }),
    ).resolves.toMatchObject({
      publication: { status: "published", externalId: null, externalUrl: null },
    });
  });

  it("«no salió»: failed sin el «enviando», y el reintento vuelve a publicar", async () => {
    const { t, discord, deps, publication } = await unknownPost();
    const result = await resolvePublication(t.subjectDeps, {
      publicationId: publication.id,
      outcome: "not_published",
      actor: "operator",
    });
    expect(result.publication).toMatchObject({
      status: "failed",
      progress: null,
      lastError: { code: "OUTCOME_RESOLVED_NOT_PUBLISHED" },
    });
    await expect(
      resolvePublication(t.subjectDeps, {
        publicationId: publication.id,
        outcome: "not_published",
        actor: "operator",
      }),
    ).resolves.toMatchObject({ changed: false });

    await t.publications.transition(
      publication.id,
      { from: "failed", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "operator" },
    );
    await expect(
      publishPublication(deps, { publicationId: publication.id, isLastAttempt: false }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect(discord.sends).toHaveLength(2);
  });

  it("un enlace malo no toca nada y una publicación sin resultado dudoso es INVALID_TRANSITION", async () => {
    const { t, publication } = await unknownPost();
    expect(
      await codeOf(
        resolvePublication(t.subjectDeps, {
          publicationId: publication.id,
          outcome: "published",
          url: "http://discord.com/x",
          actor: "operator",
        }),
      ),
    ).toBe("PUBLISHED_URL_INVALID");
    expect(t.current(publication.id)?.status).toBe("outcome_unknown");

    const other = await createPostPublicationScenario();
    expect(
      await codeOf(
        resolvePublication(other.subjectDeps, {
          publicationId: other.publicationOf("discord").id,
          outcome: "published",
          actor: "operator",
        }),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("en un aviso en vivo, «salió» lo pasa a active como al publicar", async () => {
    const t = await createPublicationScenario();
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const [post] = started;
    if (post === undefined) throw new Error("falta la publicación");
    await t.publications.transition(
      post.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    await resolvePublication(
      { lock: t.deps.lock, publications: t.deps.publications },
      {
        publicationId: post.id,
        outcome: "published",
        url: "https://www.instagram.com/p/abc/",
        actor: "operator",
      },
    );
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });
});

describe("protecciones de outcome_unknown", () => {
  it("descartar, reintentar, programar y quitar la aprobación esperan que se resuelva", async () => {
    const t = await createPublicationScenario();
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const [post] = started;
    if (post === undefined) throw new Error("falta la publicación");
    await t.publications.transition(
      post.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    const pending = async (promise: Promise<unknown>) => {
      const error = await caught(promise);
      expect(error).toMatchObject({
        code: "OUTCOME_UNKNOWN_PENDING",
        details: { publicationId: post.id },
      });
    };

    await pending(cancelPublication(t.deps, { publicationId: post.id, actor: "operator" }));
    await pending(
      startPublication(t.deps, { publicationId: post.id, dryRun: false, actor: "operator" }),
    );
    await pending(
      schedulePublication(t.deps, {
        publicationId: post.id,
        at: new Date(Date.now() + 3600e3),
        dryRun: false,
        actor: "operator",
      }),
    );
    await pending(
      unapproveContent(
        { ...t.approveDeps, lock: t.deps.lock },
        { contentId: post.contentId, actor: "operator" },
      ),
    );
    expect(t.publications.all().find((p) => p.id === post.id)?.status).toBe("outcome_unknown");
  });
});

describe("traspaso a mano por cuenta (ADR-0029 punto 9)", () => {
  const manualLinkedIn = () =>
    createPostPublicationScenario({
      texts: [{ platform: "linkedin", language: "es" }],
      accounts: [{ platform: "linkedin", meta: { mode: "manual" } }],
    });

  it("una cuenta en modo manual no llama a la red: deja el texto y los medios listos", async () => {
    const t = await manualLinkedIn();
    const linkedin = createFakePublisher({ platform: "linkedin", formats: ["post"] });
    const publication = await t.toPublishing(t.publicationOf("linkedin"));

    const result = await publishPublication(t.publishDeps({ linkedin }, { now: () => NOW }), {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "awaiting_manual_confirm",
      publication: {
        status: "awaiting_manual_confirm",
        progress: {
          manual: { attempt: 1, simulated: false, readyAt: NOW.toISOString(), media: 1 },
        },
      },
    });
    expect(linkedin.published).toEqual([]);
    // Sus reglas sí se revisan (`validate` es pura), y la bitácora guarda el texto listo.
    expect(linkedin.validated).toHaveLength(1);
    const [attempt] = await attemptsOf(t, publication);
    expect(attempt).toMatchObject({
      result: "awaiting_manual_confirm",
      sent: { caption: "Texto en es para linkedin\n\n#agentpey #ia" },
    });
  });

  it("sin publisher registrado también queda lista (no es PUBLISHER_NOT_CONFIGURED)", async () => {
    const t = await manualLinkedIn();
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await expect(
      publishPublication(t.publishDeps({}), {
        publicationId: publication.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({ outcome: "awaiting_manual_confirm" });
  });

  it("confirmar guarda el enlace (en el candado del post); en vivo sin enlace, PUBLISHED_URL_REQUIRED", async () => {
    const t = await manualLinkedIn();
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await publishPublication(t.publishDeps({}), {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(
      await codeOf(
        confirmManualPublication(t.subjectDeps, {
          publicationId: publication.id,
          actor: "operator",
        }),
      ),
    ).toBe("PUBLISHED_URL_REQUIRED");
    const url = "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000000/";
    const confirmed = await confirmManualPublication(
      { ...t.subjectDeps, now: () => NOW },
      { publicationId: publication.id, url: `${url}?utm_source=share`, actor: "operator" },
    );
    expect(confirmed).toMatchObject({
      changed: true,
      publication: { status: "published", externalUrl: url, externalId: url, publishedAt: NOW },
    });
    expect(t.postLock.busy()).toEqual([]);
    await expect(
      confirmManualPublication(t.subjectDeps, { publicationId: publication.id, url, actor: "cli" }),
    ).resolves.toMatchObject({ changed: false });
  });

  it("«no lo publiqué»: failed con MANUAL_NOT_PUBLISHED", async () => {
    const t = await manualLinkedIn();
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await publishPublication(t.publishDeps({}), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    await expect(
      markNotPublished(t.subjectDeps, { publicationId: publication.id, actor: "operator" }),
    ).resolves.toMatchObject({ status: "failed", lastError: { code: "MANUAL_NOT_PUBLISHED" } });
  });

  it("sin el candado del post, confirmar un post es SUBJECT_NOT_LISTING sin cambiar nada", async () => {
    const t = await manualLinkedIn();
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await publishPublication(t.publishDeps({}), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    expect(
      await codeOf(
        confirmManualPublication(
          { lock: t.lock, publications: t.publications },
          { publicationId: publication.id, url: "https://www.linkedin.com/x", actor: "operator" },
        ),
      ),
    ).toBe("SUBJECT_NOT_LISTING");
    expect(t.current(publication.id)?.status).toBe("awaiting_manual_confirm");
  });
});

describe("access token al publicar (ADR-0029 punto 11)", () => {
  const SOON = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  const LATER = new Date(NOW.getTime() + 2 * 3600_000).toISOString();

  const xScenario = (accessTokenExpiresAt: string) =>
    createPostPublicationScenario({
      texts: [{ platform: "x", language: "es" }],
      accounts: [{ platform: "x", meta: { accessTokenExpiresAt } }],
    });

  it("un token por vencer se renueva antes de publicar, con el candado, y se guarda el par nuevo", async () => {
    const t = await xScenario(SOON);
    const refreshed: string[] = [];
    const refresher = {
      async refresh(refreshToken: string) {
        refreshed.push(refreshToken);
        return {
          accessToken: "token-x-nuevo",
          refreshToken: "refresh-x-nuevo",
          accessTokenExpiresAt: new Date(NOW.getTime() + 2 * 3600_000),
          refreshTokenExpiresAt: null,
        };
      },
      isRejected: () => false,
    };
    const x = createSendOncePublisher("x", { useAccessToken: true });
    const publication = await t.toPublishing(t.publicationOf("x"));

    await expect(
      publishPublication(
        t.publishDeps({ x }, { now: () => NOW, tokenRefreshers: { x: refresher } }),
        { publicationId: publication.id, isLastAttempt: false },
      ),
    ).resolves.toMatchObject({ outcome: "published" });

    expect(refreshed).toEqual(["refresh-post-prueba"]);
    expect(x.tokens).toEqual(["token-x-nuevo"]);
    const accountId = t.accounts.get("x") ?? "";
    expect(await t.platformAccounts.getCredentials(accountId)).toEqual({
      accessToken: "token-x-nuevo",
      refreshToken: "refresh-x-nuevo",
    });
    expect((await t.platformAccounts.get(accountId))?.meta).toMatchObject({
      accessTokenExpiresAt: new Date(NOW.getTime() + 2 * 3600_000).toISOString(),
      tokenRefreshedAt: NOW.toISOString(),
    });
  });

  it("un token vigente se usa sin renovar", async () => {
    const t = await xScenario(LATER);
    const x = createSendOncePublisher("x", { useAccessToken: true });
    const publication = await t.toPublishing(t.publicationOf("x"));
    await publishPublication(t.publishDeps({ x }, { now: () => NOW, tokenRefreshers: {} }), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    expect(x.tokens).toEqual([POST_SCENARIO_TOKEN]);
  });

  it("sin la renovación de la red: TOKEN_REFRESH_NOT_CONFIGURED y failed, sin llamar a la red", async () => {
    const t = await xScenario(SOON);
    const x = createSendOncePublisher("x", { useAccessToken: true });
    const publication = await t.toPublishing(t.publicationOf("x"));
    expect(
      await codeOf(
        publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
          publicationId: publication.id,
          isLastAttempt: false,
        }),
      ),
    ).toBe("TOKEN_REFRESH_NOT_CONFIGURED");
    expect(x.sends).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("failed");
  });

  it("un refresh token rechazado deja la cuenta vencida: TOKEN_REFRESH_REJECTED", async () => {
    const t = await xScenario(SOON);
    const rejection = new AppError("X_AUTH_INVALID", "rechazado");
    const refresher = {
      refresh: async () => {
        throw rejection;
      },
      isRejected: (error: unknown) => error === rejection,
    };
    const x = createSendOncePublisher("x", { useAccessToken: true });
    const publication = await t.toPublishing(t.publicationOf("x"));
    expect(
      await codeOf(
        publishPublication(
          t.publishDeps({ x }, { now: () => NOW, tokenRefreshers: { x: refresher } }),
          { publicationId: publication.id, isLastAttempt: false },
        ),
      ),
    ).toBe("TOKEN_REFRESH_REJECTED");
    expect((await t.platformAccounts.get(t.accounts.get("x") ?? ""))?.status).toBe("expired");
    expect(x.sends).toEqual([]);
  });
});
