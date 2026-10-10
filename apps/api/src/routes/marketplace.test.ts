import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import {
  type JobQueue,
  type Publication,
  type PublishMode,
  publishPublication,
  type UfValueSource,
} from "@agentsales/core";
import {
  contentBrokerFixture,
  createFakePublisher,
  createInMemoryBrokerRepository,
  createInMemoryJobQueue,
  createInMemoryPlatformAccountRepository,
  createPublicationScenario,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../app.js";
import {
  accountListResponseSchema,
  accountResponseSchema,
  contentApproveResponseSchema,
  errorBodySchema,
  listingContentResponseSchema,
  listingPublishResponseSchema,
  marketplaceLoginResponseSchema,
  publicationConfirmResponseSchema,
  publicationResponseSchema,
} from "../contracts/index.js";
import { testDeps } from "../testing/index.js";

// F5-T08: la API de Marketplace (spec F5 §4.2, §4.3 y §4.10).

const MARKETPLACE = "fb_marketplace";
const json = { "Content-Type": "application/json" };
const post = (body: unknown = {}) => ({
  method: "POST",
  headers: json,
  body: JSON.stringify(body),
});
/** El enlace que pega el operador, con datos de rastreo en la consulta. */
const PASTED_URL = "https://www.facebook.com/marketplace/item/123456789/?ref=share&tracking=abc123";
const CLEAN_URL = "https://www.facebook.com/marketplace/item/123456789/";

/** Un logger que guarda todo lo que escribe, desde `debug` (para ver que el enlace no va al log). */
function capturingLogger() {
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    }),
  );
  return { logger, text: () => lines.join("") };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

// ---------------------------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------------------------

function accountsSetup(overrides: Partial<AppDeps> = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const queue = createInMemoryJobQueue();
  const now = new Date("2026-10-10T12:00:00Z");
  const app = createApp(
    testDeps({ brokers, platformAccounts, queue, now: () => now, ...overrides }),
  );
  const connectMarketplace = (meta: Record<string, unknown> = {}) =>
    platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: MARKETPLACE,
      externalAccountId: "100012345678901",
      displayName: "Facebook de prueba",
      tokenExpiresAt: null,
      meta: {
        userId: "100012345678901",
        connectedAt: "2026-10-09T12:00:00.000Z",
        sessionCheckedAt: "2026-10-09T12:00:00.000Z",
        ...meta,
      },
      credentials: null,
    });
  return { app, broker, platformAccounts, queue, now, connectMarketplace };
}

describe("POST /accounts/marketplace/login", () => {
  it("encola el inicio de sesión (202) con la hora del pedido y el nombre", async () => {
    const { app, broker, queue, now } = accountsSetup();

    const response = await app.request(
      "/accounts/marketplace/login",
      post({ broker: broker.slug, label: "Facebook de Ana" }),
    );

    expect(response.status).toBe(202);
    expect(marketplaceLoginResponseSchema.parse(await response.json())).toEqual({
      queued: true,
      brokerId: broker.id,
      requestedAt: now,
    });
    expect(queue.jobs).toEqual([
      {
        name: "marketplace.profile",
        data: {
          brokerId: broker.id,
          action: "login",
          requestedAt: now.toISOString(),
          label: "Facebook de Ana",
        },
        options: { singletonKey: broker.id },
      },
    ]);
  });

  it("con otra acción del perfil en cola: 409 MARKETPLACE_PROFILE_ACTION_PENDING", async () => {
    const busy: JobQueue = { enqueue: async () => null };
    const { app, broker } = accountsSetup({ queue: busy });
    const response = await app.request(
      "/accounts/marketplace/login",
      post({ broker: broker.slug }),
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("MARKETPLACE_PROFILE_ACTION_PENDING");
  });

  it("un corredor que no existe es 404; un nombre demasiado largo o sin corredor, 400", async () => {
    const { app, broker, queue } = accountsSetup();
    const missing = await app.request("/accounts/marketplace/login", post({ broker: "no-existe" }));
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("BROKER_NOT_FOUND");
    for (const body of [{ broker: broker.slug, label: "x".repeat(81) }, { label: "Ana" }]) {
      const response = await app.request("/accounts/marketplace/login", post(body));
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("REQUEST_INVALID");
    }
    expect(queue.jobs).toEqual([]);
  });
});

describe("GET /accounts · la vista de Marketplace", () => {
  it("la sesión revisada y el último error de inicio de sesión con su texto, sin token", async () => {
    const { app, connectMarketplace } = accountsSetup();
    const account = await connectMarketplace({
      lastLoginError: { code: "MARKETPLACE_LOGIN_TIMEOUT", at: "2026-10-10T11:00:00.000Z" },
    });

    const { accounts } = accountListResponseSchema.parse(
      await (await app.request("/accounts")).json(),
    );

    expect(accounts).toEqual([
      expect.objectContaining({
        id: account.id,
        platform: MARKETPLACE,
        status: "connected",
        tokenExpiresAt: null,
        tokenExpiryEstimated: false,
        tokenRefreshedAt: null,
        accountType: null,
        permissions: null,
        connectedAt: new Date("2026-10-09T12:00:00.000Z"),
        sessionCheckedAt: new Date("2026-10-09T12:00:00.000Z"),
        lastLoginError: {
          code: "MARKETPLACE_LOGIN_TIMEOUT",
          message: "Pasaron 10 minutos sin que se iniciara la sesión en Facebook",
          at: new Date("2026-10-10T11:00:00.000Z"),
        },
      }),
    ]);
  });

  it("una meta que no calza deja esos campos en null; las de Instagram no traen sesión", async () => {
    const { app, broker, platformAccounts } = accountsSetup();
    await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: MARKETPLACE,
      externalAccountId: "1",
      displayName: "Rota",
      tokenExpiresAt: null,
      meta: { userId: "no-numérico" },
      credentials: null,
    });
    const { accounts } = accountListResponseSchema.parse(
      await (await app.request("/accounts")).json(),
    );
    expect(accounts[0]).toMatchObject({
      connectedAt: null,
      sessionCheckedAt: null,
      lastLoginError: null,
    });
  });
});

describe("POST /accounts/:id/disconnect · Marketplace", () => {
  it("sin confirmar: 409 DISCONNECT_NOT_CONFIRMED, sin cambiar ni encolar nada", async () => {
    const { app, queue, platformAccounts, connectMarketplace } = accountsSetup();
    const account = await connectMarketplace();
    for (const body of [{}, { confirmed: false }]) {
      const response = await app.request(`/accounts/${account.id}/disconnect`, post(body));
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("DISCONNECT_NOT_CONFIRMED");
    }
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
    expect(queue.jobs).toEqual([]);
  });

  it("confirmado: encola el borrado del perfil y la cuenta queda desconectada", async () => {
    const { app, broker, queue, connectMarketplace } = accountsSetup();
    const account = await connectMarketplace();

    const response = await app.request(
      `/accounts/${account.id}/disconnect`,
      post({ confirmed: true }),
    );

    expect(response.status).toBe(200);
    expect(accountResponseSchema.parse(await response.json()).account.status).toBe("revoked");
    expect(queue.jobs).toEqual([
      {
        name: "marketplace.profile",
        data: { brokerId: broker.id, action: "forget" },
        options: { singletonKey: broker.id },
      },
    ]);
  });

  it("con otra acción del perfil en cola: 409 MARKETPLACE_PROFILE_ACTION_PENDING y sigue conectada", async () => {
    const busy: JobQueue = { enqueue: async () => null };
    const { app, platformAccounts, connectMarketplace } = accountsSetup({ queue: busy });
    const account = await connectMarketplace();
    const response = await app.request(
      `/accounts/${account.id}/disconnect`,
      post({ confirmed: true }),
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("MARKETPLACE_PROFILE_ACTION_PENDING");
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
  });

  it("un cuerpo que no es JSON es 400 INVALID_JSON", async () => {
    const { app, connectMarketplace } = accountsSetup();
    const account = await connectMarketplace();
    const response = await app.request(`/accounts/${account.id}/disconnect`, {
      method: "POST",
      headers: json,
      body: "{confirmed",
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Publicar y confirmar
// ---------------------------------------------------------------------------------------------

/** La UF de los tests (inventada): ayer y hoy, en cualquier fecha que se pida. */
const ufSource: UfValueSource = {
  async valuesBetween(from, to) {
    return [
      { date: from, value: "41126.12" },
      { date: to, value: "41130.94" },
    ];
  },
};

async function publicationSetup(
  options: { publishMode?: PublishMode; ufConfigured?: boolean } = {},
) {
  const t = await createPublicationScenario({ platform: MARKETPLACE, nextId: randomUUID });
  const log = capturingLogger();
  const mode = options.publishMode ?? "live";
  const app = createApp(
    testDeps({
      listings: t.listings,
      brokers: t.brokers,
      media: t.media,
      fieldDefinitions: t.fieldDefinitions,
      storage: t.storage,
      contents: t.contents,
      contentRuns: t.contentRuns,
      platformAccounts: t.platformAccounts,
      publications: t.publications,
      lock: t.deps.lock,
      queue: t.deps.queue,
      publishMode: mode,
      logger: log.logger,
      marketplace: { dailyLimit: 3, ufConfigured: options.ufConfigured ?? true },
    }),
  );
  const fake = createFakePublisher({
    platform: MARKETPLACE,
    formats: ["post"],
    manualConfirm: true,
  });
  /** Hace de worker: el intento deja el formulario listo (`awaiting_manual_confirm`). */
  const attempt = (publication: Publication) =>
    publishPublication(
      {
        publications: t.publications,
        platformAccounts: t.platformAccounts,
        contents: t.contents,
        media: t.media,
        listings: t.listings,
        brokers: t.brokers,
        storage: t.storage,
        publishers: { fb_marketplace: fake },
        workerMode: mode,
        mercadoLibre: null,
        marketplaceDailyLimit: 3,
        uf: ufSource,
      },
      { publicationId: publication.id, isLastAttempt: false },
    );
  const publish = () =>
    app.request(`/listings/${t.listingId}/publish`, post({ platform: MARKETPLACE }));
  /** Publica por la API y deja el formulario listo, como el worker. */
  const awaiting = async () => {
    const response = await publish();
    expect(response.status).toBe(202);
    const [started] = listingPublishResponseSchema.parse(await response.json()).started;
    if (started === undefined) throw new Error("no se inició la publicación");
    const publication = await t.publications.get(started.id);
    if (publication === null) throw new Error("falta la publicación");
    expect((await attempt(publication)).outcome).toBe("awaiting_manual_confirm");
    return started.id;
  };
  const view = async (id: string) =>
    publicationResponseSchema.parse(await (await app.request(`/publications/${id}`)).json())
      .publication;
  return { t, app, log, publish, awaiting, view };
}

describe("publicar Marketplace (spec F5 §4.6 y §4.7)", () => {
  it("al aviso le falta lo del formulario: 409 MARKETPLACE_NOT_READY con la lista (issues)", async () => {
    const { app, t, publish } = await publicationSetup({ ufConfigured: false });

    const response = await publish();

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("MARKETPLACE_NOT_READY");
    expect(error.issues).toEqual([expect.objectContaining({ code: "UF_SOURCE_NOT_CONFIGURED" })]);
    expect(error).not.toHaveProperty("publicationId");
    // Lo mismo en la pestaña de contenido y como advertencia al aprobar.
    const content = listingContentResponseSchema.parse(
      await (await app.request(`/listings/${t.listingId}/content`)).json(),
    );
    expect(content.marketplaceReadiness).toEqual({
      ready: false,
      issues: [expect.objectContaining({ code: "UF_SOURCE_NOT_CONFIGURED", field: null })],
    });
    const contentId = content.contents.find((item) => item.platform === MARKETPLACE)?.id;
    const approved = contentApproveResponseSchema.parse(
      await (await app.request(`/contents/${contentId}/approve`, post())).json(),
    );
    expect(approved.marketplaceReadiness).toMatchObject({ ready: false });
    expect(approved.portalReadiness).toBeNull();
  });

  it("listo: la pestaña de contenido no pide nada", async () => {
    const { app, t } = await publicationSetup();
    const content = listingContentResponseSchema.parse(
      await (await app.request(`/listings/${t.listingId}/content`)).json(),
    );
    expect(content.marketplaceReadiness).toEqual({ ready: true, issues: [] });
  });

  it("la cuenta llegó a su límite de hoy (en vivo): 409 MARKETPLACE_DAILY_LIMIT", async () => {
    const { t, publish } = await publicationSetup();
    const [publication] = t.publications.all();
    if (publication === undefined) throw new Error("falta la publicación");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await t.publications.addEvent(publication.id, {
        type: "publish_attempt",
        actor: "system",
        payload: { mode: "live", attempt, retry: 0, result: "failed" },
      });
    }
    const response = await publish();
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("MARKETPLACE_DAILY_LIMIT");
  });

  it("formulario listo: la vista suma `manual` (precio en pesos y UF), sin el progreso crudo", async () => {
    const { app, awaiting, view } = await publicationSetup();
    const id = await awaiting();

    const text = await (await app.request(`/publications/${id}`)).text();
    expect(text).not.toContain('"progress"');
    expect(text).not.toContain('"attempt"');
    const publication = await view(id);
    expect(publication.status).toBe("awaiting_manual_confirm");
    expect(publication.manual).toEqual({
      formReadyAt: expect.any(Date),
      simulated: false,
      windowOpen: true,
      windowClosedAt: null,
      photos: 2,
      priceClp: expect.any(Number),
      ufValue: "41130.94",
      ufDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("otra publicación de la cuenta con el formulario abierto: 409 MARKETPLACE_FORM_OPEN con su id", async () => {
    const { t, publish } = await publicationSetup();
    const [own] = t.publications.all();
    if (own === undefined) throw new Error("falta la publicación");
    // Otra propiedad de la misma cuenta, con su formulario llenándose.
    const other = await t.publications.create(
      {
        listingId: randomUUID(),
        platformAccountId: own.platformAccountId,
        platform: MARKETPLACE,
        format: "post",
        contentId: own.contentId,
        mediaIds: [],
        listingSourceHash: "h",
      },
      { actor: "operator" },
    );
    await t.publications.transition(
      other.id,
      { from: "approved", to: "publishing", changes: { dryRun: false } },
      { actor: "operator" },
    );

    const response = await publish();

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "MARKETPLACE_FORM_OPEN",
      publicationId: other.id,
    });
  });

  it("mientras espera: descartar, quitar la aprobación y desconectar responden 409 MANUAL_CONFIRM_PENDING con la publicación", async () => {
    const { app, t, awaiting } = await publicationSetup();
    const id = await awaiting();
    const content = (await t.contents.listCurrent(t.listingId)).find(
      (item) => item.platform === MARKETPLACE,
    );
    const account = (await t.platformAccounts.list())[0];

    for (const path of [
      `/publications/${id}/cancel`,
      `/contents/${content?.id}/unapprove`,
      `/accounts/${account?.id}/disconnect`,
    ]) {
      const response = await app.request(path, post({ confirmed: true }));
      expect(response.status, path).toBe(409);
      expect(await errorOf(response)).toMatchObject({
        code: "MANUAL_CONFIRM_PENDING",
        publicationId: id,
      });
    }
    expect((await t.publications.get(id))?.status).toBe("awaiting_manual_confirm");
  });
});

describe("POST /publications/:id/confirm y /not-published (spec F5 §4.3)", () => {
  it("en vivo, sin enlace: 400 MARKETPLACE_URL_REQUIRED; un enlace que no es de un aviso: 400 MARKETPLACE_URL_INVALID, sin repetirlo", async () => {
    const { app, t, awaiting } = await publicationSetup();
    const id = await awaiting();

    const without = await app.request(`/publications/${id}/confirm`, post());
    expect(without.status).toBe(400);
    expect((await errorOf(without)).code).toBe("MARKETPLACE_URL_REQUIRED");

    const wrong = "https://www.facebook.com/profile.php?id=999&secreto=1";
    const invalid = await app.request(`/publications/${id}/confirm`, post({ url: wrong }));
    expect(invalid.status).toBe(400);
    const text = await invalid.text();
    expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe("MARKETPLACE_URL_INVALID");
    expect(text).not.toContain("secreto");
    expect((await t.publications.get(id))?.status).toBe("awaiting_manual_confirm");
  });

  it("un enlace rechazado (inválido o enorme) tampoco va al log", async () => {
    const { app, awaiting, log } = await publicationSetup();
    const id = await awaiting();
    await app.request(
      `/publications/${id}/confirm`,
      post({ url: "https://www.facebook.com/profile.php?id=999&secreto=1" }),
    );
    await app.request(
      `/publications/${id}/confirm`,
      post({ url: `https://www.facebook.com/secreto${"x".repeat(3000)}` }),
    );
    expect(log.text()).toContain(`/publications/${id}/confirm`);
    expect(log.text()).not.toContain("secreto");
  });

  it("con el enlace: publicada con el enlace limpio; repetirlo no cambia nada; otro enlace es 409", async () => {
    const { app, t, awaiting, log } = await publicationSetup();
    const id = await awaiting();

    const response = await app.request(`/publications/${id}/confirm`, post({ url: PASTED_URL }));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("tracking");
    const confirmed = publicationConfirmResponseSchema.parse(JSON.parse(text));
    expect(confirmed).toMatchObject({
      changed: true,
      publication: { status: "published", externalUrl: CLEAN_URL, manual: { windowOpen: false } },
    });
    // En vivo, el aviso pasa a publicado.
    expect((await t.listings.get(t.listingId))?.status).toBe("active");

    const again = await app.request(`/publications/${id}/confirm`, post({ url: CLEAN_URL }));
    expect(again.status).toBe(200);
    expect(publicationConfirmResponseSchema.parse(await again.json()).changed).toBe(false);

    const other = await app.request(
      `/publications/${id}/confirm`,
      post({ url: "https://www.facebook.com/marketplace/item/987654321/" }),
    );
    expect(other.status).toBe(409);
    expect((await errorOf(other)).code).toBe("PUBLICATION_ALREADY_CONFIRMED");

    // El enlace pegado (ni su consulta) nunca va al log.
    expect(log.text()).not.toContain("123456789");
    expect(log.text()).not.toContain("tracking");
    expect(log.text()).toContain(`/publications/${id}/confirm`);
  });

  it("marcar como retirada una publicada en vivo pide haberla borrado a mano en Facebook", async () => {
    const { app, awaiting } = await publicationSetup();
    const id = await awaiting();
    await app.request(`/publications/${id}/confirm`, post({ url: PASTED_URL }));

    const unconfirmed = await app.request(`/publications/${id}/retire`, post());
    expect(unconfirmed.status).toBe(409);
    expect((await errorOf(unconfirmed)).code).toBe("REMOVAL_NOT_CONFIRMED");

    const retired = await app.request(`/publications/${id}/retire`, post({ removedByHand: true }));
    expect(retired.status).toBe(200);
    expect(publicationResponseSchema.parse(await retired.json()).publication.status).toBe(
      "unpublished",
    );
  });

  it("la bitácora dice que lo confirmó el operador", async () => {
    const { app, awaiting } = await publicationSetup();
    const id = await awaiting();
    await app.request(`/publications/${id}/confirm`, post({ url: PASTED_URL }));
    const events = (await (await app.request(`/publications/${id}/events`)).json()) as {
      events: Array<{ toStatus: string | null; payload: Record<string, unknown> }>;
    };
    expect(events.events.find((event) => event.toStatus === "published")?.payload).toEqual({
      mode: "live",
      confirmedBy: "operator",
    });
  });

  it("en simulación, el enlace se ignora: publicada sin enlace", async () => {
    const { app, awaiting } = await publicationSetup({ publishMode: "dry-run" });
    const id = await awaiting();
    const response = await app.request(`/publications/${id}/confirm`, post({ url: PASTED_URL }));
    expect(response.status).toBe(200);
    expect(publicationConfirmResponseSchema.parse(await response.json()).publication).toMatchObject(
      { status: "published", externalUrl: null, manual: { simulated: true } },
    );
  });

  it("no lo publiqué: failed con MARKETPLACE_NOT_PUBLISHED; otra vez, 409 INVALID_TRANSITION", async () => {
    const { app, awaiting } = await publicationSetup();
    const id = await awaiting();

    const response = await app.request(`/publications/${id}/not-published`, post());
    expect(response.status).toBe(200);
    expect(publicationResponseSchema.parse(await response.json()).publication).toMatchObject({
      status: "failed",
      lastError: { code: "MARKETPLACE_NOT_PUBLISHED" },
    });

    const again = await app.request(`/publications/${id}/not-published`, post());
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("INVALID_TRANSITION");
    const confirm = await app.request(`/publications/${id}/confirm`, post({ url: PASTED_URL }));
    expect(confirm.status).toBe(409);
  });

  it("una publicación que no existe es 404; un id que no es uuid o un enlace enorme, 400", async () => {
    const { app } = await publicationSetup();
    const missing = await app.request(`/publications/${randomUUID()}/confirm`, post());
    expect(missing.status).toBe(404);
    expect((await app.request("/publications/abc/not-published", post())).status).toBe(400);
    const huge = await app.request(
      `/publications/${randomUUID()}/confirm`,
      post({ url: `https://www.facebook.com/${"x".repeat(3000)}` }),
    );
    expect(huge.status).toBe(400);
    expect((await errorOf(huge)).code).toBe("REQUEST_INVALID");
  });
});
