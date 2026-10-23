import type { BrokerData, Language, Platform, PublicationStatus } from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "../access.js";
import { createApp } from "../app.js";
import {
  contentApproveResponseSchema,
  contentEditResponseSchema,
  contentRunRequestResponseSchema,
  contentUnapproveResponseSchema,
  errorBodySchema,
  postDetailResponseSchema,
  postPublishResponseSchema,
  postScheduleResponseSchema,
  publicationConfirmResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9-T12 (spec F9 §4.10): los textos de un post por red e idioma (pedir, editar, aprobar y quitar
// la aprobación), publicar y programar un post, y resolver una publicación con resultado dudoso.
// Un corredor solo toca los posts de su marca (lo ajeno es 404); los errores llegan con su código
// HTTP y un mensaje que dice qué hacer.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-posts-t12";
/** Una hora al minuto (programar trunca los segundos). */
const inHours = (hours: number) => {
  const at = new Date(Date.now() + hours * 3_600_000);
  at.setUTCSeconds(0, 0);
  return at.toISOString();
};

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

async function setup(options: { publishMode?: "dry-run" | "live" } = {}) {
  const auth = testAuth();
  const queue = createInMemoryJobQueue();
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    queue,
    publishMode: options.publishMode ?? "dry-run",
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("vinny"), { kind: "brand" });
  const theirs = await deps.brokers.create(brokerData("ajena"), { kind: "brand" });
  const user = auth.repos.seed.user({
    email: "marca@ejemplo.cl",
    name: "Marca",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "cli" });
  await deps.platformAccounts.upsertConnected({
    brokerId: mine.id,
    platform: "discord",
    externalAccountId: "canal-1",
    displayName: "#anuncios",
    tokenExpiresAt: null,
    meta: {},
    credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
  });
  const post = await deps.posts.create({
    brokerId: mine.id,
    topic: "Lo que aprendí esta semana",
    kind: "text",
    status: "draft",
  });
  const foreign = await deps.posts.create({
    brokerId: theirs.id,
    topic: "De otra marca",
    kind: "text",
    status: "draft",
  });
  const as =
    (token: string) =>
    (path: string, init: { method?: string; json?: unknown } = {}) =>
      app.request(path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method !== undefined && init.method !== "GET" ? { origin: ORIGIN } : {}),
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      });
  /** Hace de worker: termina la corrida activa con un texto por red e idioma. */
  const finishDraft = async (
    postId: string,
    texts: { platform: Platform; language: Language; body?: string }[] = [
      { platform: "discord", language: "es" },
    ],
  ) => {
    const run = await deps.contentRuns.findActive({ kind: "post", id: postId });
    if (run === null) throw new Error("sin corrida activa");
    await deps.contentRuns.markRunning(run.id);
    await deps.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: texts.map((text) => ({
        platform: text.platform,
        language: text.language,
        title: null,
        body: text.body ?? `Texto en ${text.language} para ${text.platform}`,
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-v1",
        rawOutput: null,
      })),
    });
  };
  /** Mueve una publicación del post por la máquina de estados (lo que haría el worker). */
  const move = (postId: string, id: string, steps: PublicationStatus[]) =>
    deps.postLock.run(postId, async ({ publications }) => {
      let current = await publications.get(id);
      for (const to of steps) {
        if (current === null) throw new Error("no existe");
        current = await publications.transition(
          id,
          {
            from: current.status,
            to,
            ...(to === "publishing" ? { changes: { dryRun: true } } : {}),
          },
          { actor: "system" },
        );
      }
      return current;
    });
  return {
    deps,
    queue,
    mine,
    post,
    foreign,
    finishDraft,
    move,
    broker: as(MINE),
    admin: as(TEST_ADMIN_TOKEN),
  };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("textos de un post por red e idioma", () => {
  it("draft → el post muestra el texto con su idioma y revisión → editar → aprobar → quitar la aprobación", async () => {
    const s = await setup();
    const draft = await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    expect(draft.status).toBe(202);
    const { contentRun, reused } = contentRunRequestResponseSchema.parse(await draft.json());
    expect(reused).toBe(false);
    expect(contentRun).toMatchObject({
      subject: { kind: "post", id: s.post.id },
      texts: true,
      status: "queued",
    });
    expect(s.queue.jobs.map((job) => job.name)).toEqual(["post.draft"]);
    await s.finishDraft(s.post.id);

    const detail = postDetailResponseSchema.parse(
      await (await s.broker(`/posts/${s.post.id}`)).json(),
    );
    expect(detail.contents).toHaveLength(1);
    expect(detail.contents[0]).toMatchObject({
      platform: "discord",
      language: "es",
      status: "draft",
    });
    expect(Array.isArray(detail.contents[0]?.checks)).toBe(true);
    expect(detail.latestRun?.status).toBe("succeeded");
    expect(detail.publications).toEqual([]);

    const edited = await s.broker(`/posts/${s.post.id}/contents/discord/es`, {
      method: "PATCH",
      json: { body: "Lo que aprendí esta semana, en corto" },
    });
    expect(edited.status).toBe(200);
    expect(contentEditResponseSchema.parse(await edited.json()).content).toMatchObject({
      status: "edited",
      language: "es",
      body: "Lo que aprendí esta semana, en corto",
    });

    const approved = await s.broker(`/posts/${s.post.id}/contents/discord/es/approve`, {
      method: "POST",
    });
    expect(approved.status).toBe(200);
    const result = contentApproveResponseSchema.parse(await approved.json());
    expect(result.content.status).toBe("approved");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      postId: s.post.id,
      listingId: null,
      platform: "discord",
      language: "es",
      status: "approved",
    });
    expect((await s.deps.posts.get(s.post.id))?.status).toBe("ready");

    const undone = await s.broker(`/posts/${s.post.id}/contents/discord/es/unapprove`, {
      method: "POST",
    });
    expect(undone.status).toBe(200);
    const back = contentUnapproveResponseSchema.parse(await undone.json());
    expect(back.content.status).toBe("edited");
    expect(back.cancelled.map((p) => p.status)).toEqual(["cancelled"]);
    expect((await s.deps.posts.get(s.post.id))?.status).toBe("draft");
  });

  it("sin texto en esa red o idioma es 404 con qué hacer; una red de avisos es 400", async () => {
    const s = await setup();
    const missing = await s.broker(`/posts/${s.post.id}/contents/x/en/approve`, {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    const error = await errorOf(missing);
    expect(error.code).toBe("CONTENT_NOT_FOUND");
    expect(error.message).toContain("pide los textos");

    const portal = await s.broker(`/posts/${s.post.id}/contents/portal_inmobiliario/es/approve`, {
      method: "POST",
    });
    expect(portal.status).toBe(400);
  });

  it("pedir los textos de un post archivado es 409 POST_NOT_READY; con textos editados, CONTENT_EDITED", async () => {
    const s = await setup();
    await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    await s.finishDraft(s.post.id);
    await s.broker(`/posts/${s.post.id}/contents/discord/es`, {
      method: "PATCH",
      json: { body: "Editado a mano" },
    });
    const edited = await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    expect(edited.status).toBe(409);
    expect((await errorOf(edited)).code).toBe("CONTENT_EDITED");
    const replaced = await s.broker(`/posts/${s.post.id}/draft`, {
      method: "POST",
      json: { replaceEdits: true },
    });
    expect(replaced.status).toBe(202);

    const archived = await s.deps.posts.create({
      brokerId: s.mine.id,
      topic: "Archivado",
      kind: "text",
      status: "archived",
    });
    const response = await s.broker(`/posts/${archived.id}/draft`, { method: "POST", json: {} });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("POST_NOT_READY");
  });

  it("un título en un texto de post es 400 CONTENT_TITLE_INVALID", async () => {
    const s = await setup();
    await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    await s.finishDraft(s.post.id);
    const response = await s.broker(`/posts/${s.post.id}/contents/discord/es`, {
      method: "PATCH",
      json: { title: "Un título" },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("CONTENT_TITLE_INVALID");
  });
});

describe("publicar y programar un post", () => {
  async function approvedPost() {
    const s = await setup();
    await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    await s.finishDraft(s.post.id);
    await s.broker(`/posts/${s.post.id}/contents/discord/es/approve`, { method: "POST" });
    return s;
  }

  it("programar deja la publicación programada a la hora, en el modo de la API", async () => {
    const s = await approvedPost();
    const at = inHours(3);
    const response = await s.broker(`/posts/${s.post.id}/schedule`, {
      method: "POST",
      json: { at, platforms: ["discord"] },
    });
    expect(response.status).toBe(200);
    const { results } = postScheduleResponseSchema.parse(await response.json());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ platform: "discord", outcome: "scheduled" });
    expect(results[0]?.publications?.[0]).toMatchObject({
      status: "scheduled",
      dryRun: true,
      scheduledAt: new Date(at),
    });
  });

  it("con el servidor en live, programar y publicar usan el modo de la marca (ADR-0036): apagada o ajena, simulación; encendida y propia, de verdad", async () => {
    const at = inHours(3);
    const modeOf = async (prepare: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) => {
      const s = await setup({ publishMode: "live" });
      await prepare(s);
      await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
      await s.finishDraft(s.post.id);
      await s.broker(`/posts/${s.post.id}/contents/discord/es/approve`, { method: "POST" });
      const scheduled = postScheduleResponseSchema.parse(
        await (
          await s.broker(`/posts/${s.post.id}/schedule`, {
            method: "POST",
            json: { at, platforms: ["discord"] },
          })
        ).json(),
      );
      return scheduled.results[0]?.publications?.[0]?.dryRun;
    };
    // Nace apagada (y no propia): simulación.
    expect(await modeOf(async () => {})).toBe(true);
    // Propia pero apagada: simulación.
    expect(
      await modeOf(async (s) => {
        await s.deps.brokers.setSettings(s.mine.id, { operatorOwned: true });
      }),
    ).toBe(true);
    // Encendida (y propia): de verdad.
    expect(
      await modeOf(async (s) => {
        await s.deps.brokers.setSettings(s.mine.id, { operatorOwned: true });
        await s.deps.brokers.setLiveEnabled(s.mine.id, true);
      }),
    ).toBe(false);
    // Publicar ya: lo mismo.
    const on = await approvedPostWith({ owned: true, live: true });
    const started = postPublishResponseSchema.parse(
      await (
        await on.broker(`/posts/${on.post.id}/publish`, {
          method: "POST",
          json: { platform: "discord" },
        })
      ).json(),
    );
    expect(started.started).toHaveLength(1);
    expect(started.started.every((publication) => !publication.dryRun)).toBe(true);
    const off = await approvedPostWith({ owned: true, live: false });
    const simulated = postPublishResponseSchema.parse(
      await (
        await off.broker(`/posts/${off.post.id}/publish`, {
          method: "POST",
          json: { platform: "discord" },
        })
      ).json(),
    );
    expect(simulated.started).toHaveLength(1);
    expect(simulated.started.every((publication) => publication.dryRun)).toBe(true);
  });

  async function approvedPostWith(options: { owned: boolean; live: boolean }) {
    const s = await setup({ publishMode: "live" });
    await s.deps.brokers.setSettings(s.mine.id, { operatorOwned: options.owned });
    if (options.live) await s.deps.brokers.setLiveEnabled(s.mine.id, true);
    await s.broker(`/posts/${s.post.id}/draft`, { method: "POST", json: {} });
    await s.finishDraft(s.post.id);
    await s.broker(`/posts/${s.post.id}/contents/discord/es/approve`, { method: "POST" });
    return s;
  }

  it("sin redes pedidas, la que no tiene texto aprobado no se informa; sin ninguna, NOTHING_TO_PUBLISH", async () => {
    const s = await setup();
    const response = await s.broker(`/posts/${s.post.id}/schedule`, {
      method: "POST",
      json: { at: inHours(3) },
    });
    expect(response.status).toBe(200);
    const { results } = postScheduleResponseSchema.parse(await response.json());
    expect(results).toEqual([
      expect.objectContaining({ platform: null, outcome: "skipped", code: "NOTHING_TO_PUBLISH" }),
    ]);
    const tooSoon = await s.broker(`/posts/${s.post.id}/schedule`, {
      method: "POST",
      json: { at: new Date().toISOString() },
    });
    expect(tooSoon.status).toBe(400);
    expect((await errorOf(tooSoon)).code).toBe("SCHEDULE_TOO_SOON");
  });

  it("las redes del post (F9-T21): no se quita una red con pendientes, y una red quitada no se aprueba, publica ni programa", async () => {
    const s = await approvedPost();
    const [publication] = await s.deps.publications.listBySubject({ kind: "post", id: s.post.id });
    if (publication === undefined) throw new Error("sin publicación");

    const remove = await s.broker(`/posts/${s.post.id}`, {
      method: "PATCH",
      json: { platforms: ["x"] },
    });
    expect(remove.status).toBe(409);
    expect((await errorOf(remove)).code).toBe("POST_HAS_PENDING_PUBLICATIONS");
    expect((await s.deps.posts.get(s.post.id))?.platforms).toBeNull();

    // Datos de antes de la regla: el post ya no tiene Discord y su publicación sigue aprobada.
    await s.deps.posts.update(s.post.id, { platforms: ["x"] });
    for (const [path, json] of [
      [`/publications/${publication.id}/publish`, undefined],
      [`/publications/${publication.id}/schedule`, { at: inHours(3) }],
      [`/posts/${s.post.id}/publish`, { platform: "discord" }],
      [`/posts/${s.post.id}/contents/discord/es/approve`, undefined],
    ] as const) {
      const response = await s.broker(path, { method: "POST", json });
      expect([path, response.status]).toEqual([path, 409]);
      expect((await errorOf(response)).code).toBe("POST_PLATFORM_EXCLUDED");
    }
    // Programar el post pidiendo esa red: una fila saltada con el motivo (200).
    const scheduled = await s.broker(`/posts/${s.post.id}/schedule`, {
      method: "POST",
      json: { at: inHours(3), platforms: ["discord"] },
    });
    expect(scheduled.status).toBe(200);
    expect(postScheduleResponseSchema.parse(await scheduled.json()).results).toEqual([
      expect.objectContaining({
        platform: "discord",
        outcome: "skipped",
        code: "POST_PLATFORM_EXCLUDED",
      }),
    ]);
    expect((await s.deps.publications.get(publication.id))?.status).toBe("approved");
  });

  it("publicar una red la pasa a publishing y encola publication.publish", async () => {
    const s = await approvedPost();
    const response = await s.broker(`/posts/${s.post.id}/publish`, {
      method: "POST",
      json: { platform: "discord" },
    });
    expect(response.status).toBe(202);
    const body = postPublishResponseSchema.parse(await response.json());
    expect(body.started.map((p) => [p.platform, p.status, p.dryRun])).toEqual([
      ["discord", "publishing", true],
    ]);
    expect(s.queue.jobs.map((job) => job.name)).toContain("publication.publish");

    const again = await s.broker(`/posts/${s.post.id}/publish`, {
      method: "POST",
      json: { platform: "x" },
    });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("CONTENT_NOT_APPROVED");
  });

  it("una outcome_unknown bloquea quitar la aprobación (OUTCOME_UNKNOWN_PENDING) y se resuelve en los dos sentidos", async () => {
    const s = await approvedPost();
    const [publication] = (await s.deps.publications.listBySubject({
      kind: "post",
      id: s.post.id,
    })) as { id: string }[];
    const id = publication?.id ?? "";
    await s.move(s.post.id, id, ["publishing", "outcome_unknown"]);

    const blocked = await s.broker(`/posts/${s.post.id}/contents/discord/es/unapprove`, {
      method: "POST",
    });
    expect(blocked.status).toBe(409);
    const error = await errorOf(blocked);
    expect(error.code).toBe("OUTCOME_UNKNOWN_PENDING");
    expect(error.publicationId).toBe(id);

    const notPublished = await s.broker(`/publications/${id}/resolve`, {
      method: "POST",
      json: { outcome: "not_published" },
    });
    expect(notPublished.status).toBe(200);
    expect(publicationConfirmResponseSchema.parse(await notPublished.json())).toMatchObject({
      changed: true,
      publication: { status: "failed", lastError: { code: "OUTCOME_RESOLVED_NOT_PUBLISHED" } },
    });

    // Reintentar por el id de la publicación y volver a quedar dudosa; esta vez sí salió.
    const retried = await s.broker(`/publications/${id}/publish`, { method: "POST" });
    expect(retried.status).toBe(202);
    await s.move(s.post.id, id, ["outcome_unknown"]);
    const published = await s.broker(`/publications/${id}/resolve`, {
      method: "POST",
      json: { outcome: "published", url: "https://discord.com/channels/1/2/3" },
    });
    expect(published.status).toBe(200);
    const body = publicationConfirmResponseSchema.parse(await published.json());
    // En simulación el enlace se ignora.
    expect(body).toMatchObject({ changed: true, publication: { status: "published" } });
    expect(body.publication.externalUrl).toBeNull();
    const repeated = await s.broker(`/publications/${id}/resolve`, {
      method: "POST",
      json: { outcome: "published" },
    });
    expect(publicationConfirmResponseSchema.parse(await repeated.json()).changed).toBe(false);
    const wrong = await s.broker(`/publications/${id}/resolve`, {
      method: "POST",
      json: { outcome: "not_published" },
    });
    expect(wrong.status).toBe(409);
    expect((await errorOf(wrong)).code).toBe("INVALID_TRANSITION");
  });

  it("resolve valida el cuerpo: un resultado desconocido es 400", async () => {
    const s = await approvedPost();
    const [publication] = await s.deps.publications.listBySubject({
      kind: "post",
      id: s.post.id,
    });
    const response = await s.broker(`/publications/${publication?.id}/resolve`, {
      method: "POST",
      json: { outcome: "quizas" },
    });
    expect(response.status).toBe(400);
  });

  it("confirm y not-published sirven para una publicación a mano de un post", async () => {
    const s = await approvedPost();
    const [publication] = await s.deps.publications.listBySubject({
      kind: "post",
      id: s.post.id,
    });
    const id = publication?.id ?? "";
    await s.move(s.post.id, id, ["publishing", "awaiting_manual_confirm"]);
    const notPublished = await s.broker(`/publications/${id}/not-published`, { method: "POST" });
    expect(notPublished.status).toBe(200);
    await s.broker(`/publications/${id}/publish`, { method: "POST" });
    await s.move(s.post.id, id, ["awaiting_manual_confirm"]);
    const confirmed = await s.broker(`/publications/${id}/confirm`, { method: "POST", json: {} });
    expect(confirmed.status).toBe(200);
    expect(publicationConfirmResponseSchema.parse(await confirmed.json()).publication.status).toBe(
      "published",
    );
  });

  it("enlace y withoutUrl a la vez es 400; withoutUrl en otra red que no es LinkedIn también", async () => {
    const s = await approvedPost();
    const [publication] = await s.deps.publications.listBySubject({
      kind: "post",
      id: s.post.id,
    });
    const id = publication?.id ?? "";
    await s.move(s.post.id, id, ["publishing", "awaiting_manual_confirm"]);
    const both = await s.broker(`/publications/${id}/confirm`, {
      method: "POST",
      json: { url: "https://www.linkedin.com/feed/update/urn:li:share:1/", withoutUrl: true },
    });
    expect(both.status).toBe(400);
    // Discord no se confirma sin enlace, tampoco en simulación: solo LinkedIn.
    const alone = await s.broker(`/publications/${id}/confirm`, {
      method: "POST",
      json: { withoutUrl: true },
    });
    expect(alone.status).toBe(400);
    expect((await errorOf(alone)).code).toBe("PUBLISHED_URL_REQUIRED");
    expect((await s.deps.publications.get(id))?.status).toBe("awaiting_manual_confirm");
  });
});

describe("permisos de las rutas nuevas (ADR-0022, `posts.manage`)", () => {
  it("un corredor no toca los posts de otra marca (404); el administrador sí", async () => {
    const s = await setup();
    const id = s.foreign.id;
    for (const [method, path, json] of [
      ["POST", `/posts/${id}/draft`, {}],
      ["PATCH", `/posts/${id}/contents/discord/es`, { body: "x" }],
      ["POST", `/posts/${id}/contents/discord/es/approve`, undefined],
      ["POST", `/posts/${id}/contents/discord/es/unapprove`, undefined],
      ["POST", `/posts/${id}/publish`, { platform: "discord" }],
      ["POST", `/posts/${id}/schedule`, { at: inHours(3) }],
    ] as const) {
      const response = await s.broker(path, { method, ...(json === undefined ? {} : { json }) });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect((await errorOf(response)).code).toBe("POST_NOT_FOUND");
    }
    const byAdmin = await s.admin(`/posts/${id}/draft`, { method: "POST", json: {} });
    expect(byAdmin.status).toBe(202);
  });

  it("resolver una publicación de otra marca es 404", async () => {
    const s = await setup();
    const other = await s.deps.platformAccounts.upsertConnected({
      brokerId: s.foreign.brokerId,
      platform: "discord",
      externalAccountId: "canal-ajeno",
      displayName: "#ajeno",
      tokenExpiresAt: null,
      meta: {},
      credentials: { webhookUrl: "https://discord.com/api/webhooks/9/token-ajeno" },
    });
    expect(other.brokerId).toBe(s.foreign.brokerId);
    await s.admin(`/posts/${s.foreign.id}/draft`, { method: "POST", json: {} });
    await s.finishDraft(s.foreign.id);
    const approved = contentApproveResponseSchema.parse(
      await (
        await s.admin(`/posts/${s.foreign.id}/contents/discord/es/approve`, { method: "POST" })
      ).json(),
    );
    const id = approved.created[0]?.id ?? "";
    const response = await s.broker(`/publications/${id}/resolve`, {
      method: "POST",
      json: { outcome: "not_published" },
    });
    expect(response.status).toBe(404);
  });

  it("cada ruta nueva está en la tabla de permisos, como de sesión", () => {
    for (const route of [
      "POST /posts/:id/draft",
      "PATCH /posts/:id/contents/:platform/:language",
      "POST /posts/:id/contents/:platform/:language/approve",
      "POST /posts/:id/contents/:platform/:language/unapprove",
      "POST /posts/:id/publish",
      "POST /posts/:id/schedule",
      "POST /publications/:id/resolve",
    ]) {
      expect([route, ROUTE_ACCESS[route]]).toEqual([route, "session"]);
    }
  });
});
