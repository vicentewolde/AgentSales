import { randomUUID } from "node:crypto";
import {
  AppError,
  type JobQueue,
  type Listing,
  type ListingAttributes,
  type PlatformContext,
  type Publication,
  type PublicationOperations,
  type PublishMode,
  publishListing,
  type RemoteStatus,
} from "@agentsales/core";
import {
  createPublicationScenario,
  PORTAL_SCENARIO_TOKENS,
  type PublicationScenario,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  contentApproveResponseSchema,
  errorBodySchema,
  listingContentResponseSchema,
  publicationOperationResponseSchema,
  publicationResponseSchema,
  publicationSyncResponseSchema,
} from "../contracts/index.js";
import { fakeMercadoLibreAuth, TEST_ML_REDIRECT_URI, testDeps } from "../testing/index.js";
import { OPERATION_TIMEOUT_MS } from "./publications.js";

// F4-T19: la API de Portal (spec F4 §4.9 y §4.11).

const PORTAL = "portal_inmobiliario";
const ITEM_ID = "MLC1234567890";
const json = { "Content-Type": "application/json" };

const status = (value: string, extra: Partial<RemoteStatus> = {}): RemoteStatus => ({
  status: value,
  subStatus: [],
  stopTime: "2027-04-07T12:00:00.000-03:00",
  expirationTime: null,
  ...extra,
});

/** Operaciones de Portal guionadas: cada llamada se registra con su señal. */
function fakeOperations(
  respond: (operation: string) => Promise<RemoteStatus> = async (operation) =>
    status({ pause: "paused", resume: "active", close: "closed" }[operation] ?? "active"),
) {
  const calls: Array<{ operation: string; signal: PlatformContext["signal"] }> = [];
  const make = (operation: string) => async (_ref: unknown, ctx: PlatformContext) => {
    // Como las reales: primero el token, después la llamada.
    await ctx.accessToken();
    calls.push({ operation, signal: ctx.signal });
    return respond(operation);
  };
  const operations: PublicationOperations = {
    pause: make("pause"),
    resume: make("resume"),
    close: make("close"),
    getStatus: make("getStatus"),
  };
  return { operations, calls };
}

/** Una publicación de Portal ya publicada, como la deja el intento. */
async function published(t: PublicationScenario, dryRun: boolean): Promise<Publication> {
  const [started] = (
    await publishListing(t.deps, { listingId: t.listingId, platform: PORTAL, dryRun, actor: "cli" })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  if (!dryRun) {
    await t.publications.saveProgress(started.id, {
      pictureIds: ["1-MLC_PIC"],
      sellerContact: { contact: null, email: null, countryCode2: "56", phone2: "911112222" },
      itemId: ITEM_ID,
      descriptionDone: true,
    });
    await t.listings.changeStatus(t.listingId, "ready", "active");
  }
  return t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: { externalId: dryRun ? `dry-run:${started.id}` : ITEM_ID },
    },
    { actor: "system" },
  );
}

async function setup(
  options: {
    publishMode?: PublishMode;
    approve?: boolean;
    operations?: PublicationOperations;
    queue?: (t: PublicationScenario) => JobQueue;
    /** Sin el par de la app de Mercado Libre: no se refresca el token. */
    mercadoLibreConfigured?: boolean;
  } = {},
) {
  const t = await createPublicationScenario({
    platform: PORTAL,
    nextId: randomUUID,
    approve: options.approve ?? true,
  });
  const fake = fakeOperations();
  const mercadoLibreAuth = fakeMercadoLibreAuth();
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
      queue: options.queue?.(t) ?? t.deps.queue,
      publishMode: options.publishMode ?? "live",
      operationsFor: (platform) =>
        platform === PORTAL ? (options.operations ?? fake.operations) : undefined,
      mercadoLibre: {
        auth: mercadoLibreAuth,
        configured: options.mercadoLibreConfigured ?? true,
        redirectUri: TEST_ML_REDIRECT_URI,
      },
    }),
  );
  const post = (path: string, body: unknown = {}) =>
    app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });
  const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;
  return { t, app, post, errorOf, calls: fake.calls, mercadoLibreAuth };
}

describe("POST /publications/:id/pause, /resume y /close", () => {
  it("en live llaman a Mercado Libre (con un tope) y devuelven la publicación con su estado remoto", async () => {
    const { t, post, calls } = await setup();
    const publication = await published(t, false);

    const paused = await post(`/publications/${publication.id}/pause`);
    expect(paused.status).toBe(200);
    expect(publicationOperationResponseSchema.parse(await paused.json())).toMatchObject({
      publication: { status: "paused", remoteState: { status: "paused" } },
      listingBackToReady: false,
    });

    const resumed = await post(`/publications/${publication.id}/resume`);
    expect(
      publicationOperationResponseSchema.parse(await resumed.json()).publication,
    ).toMatchObject({ status: "published", remoteState: { status: "active" } });

    const closed = await post(`/publications/${publication.id}/close`, { confirmed: true });
    expect(publicationOperationResponseSchema.parse(await closed.json())).toMatchObject({
      publication: { status: "unpublished", remoteState: { status: "closed" } },
      listingBackToReady: true,
    });

    expect(calls.map((call) => call.operation)).toEqual(["pause", "resume", "close"]);
    expect(calls.every((call) => call.signal !== undefined && !call.signal.aborted)).toBe(true);
    expect(OPERATION_TIMEOUT_MS).toBe(20_000);
  });

  it("cerrar en live sin confirmed es 409 CLOSE_NOT_CONFIRMED, sin llamar", async () => {
    const { t, post, errorOf, calls } = await setup();
    const publication = await published(t, false);

    const response = await post(`/publications/${publication.id}/close`);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("CLOSE_NOT_CONFIRMED");
    expect(calls).toEqual([]);
  });

  it("una publicación de live con la API en dry-run es 409 PUBLISH_MODE_MISMATCH, sin llamar", async () => {
    const { t, post, errorOf, calls } = await setup({ publishMode: "dry-run" });
    const publication = await published(t, false);

    for (const path of ["pause", "close"]) {
      const response = await post(`/publications/${publication.id}/${path}`, { confirmed: true });
      expect(response.status, path).toBe(409);
      expect((await errorOf(response)).code).toBe("PUBLISH_MODE_MISMATCH");
    }
    expect(calls).toEqual([]);
  });

  it("una de dry-run se cambia en simulación, sin llamar a Mercado Libre", async () => {
    const { t, post, calls } = await setup({ publishMode: "dry-run" });
    const publication = await published(t, true);

    const response = await post(`/publications/${publication.id}/close`);

    expect(response.status).toBe(200);
    expect(publicationOperationResponseSchema.parse(await response.json()).publication.status).toBe(
      "unpublished",
    );
    expect(calls).toEqual([]);
  });

  it("los errores de Mercado Libre llegan con su HTTP y un mensaje claro", async () => {
    const cases: Array<[AppError, number]> = [
      [new AppError("ML_ITEM_REJECTED", "Mercado Libre rechazó el cambio"), 409],
      [new AppError("ML_CONFLICT", "conflicto", { retriable: true }), 409],
      [new AppError("ML_UNAVAILABLE", "sin respuesta", { retriable: true }), 503],
      [new AppError("ML_RATE_LIMITED", "límite", { retriable: true }), 429],
      [new AppError("ML_ABORTED", "Se cortó la llamada a Mercado Libre", { retriable: true }), 503],
    ];
    for (const [error, expected] of cases) {
      const fake = fakeOperations(async () => {
        throw error;
      });
      const { t, post, errorOf } = await setup({ operations: fake.operations });
      const publication = await published(t, false);

      const response = await post(`/publications/${publication.id}/pause`);

      expect(response.status, error.code).toBe(expected);
      const body = await errorOf(response);
      expect(body.code).toBe(error.code);
      if (error.code === "ML_ABORTED") expect(body.message).toContain("revisará el estado");
    }
  });

  it("un acceso rechazado deja la cuenta vencida (400 ML_AUTH_INVALID, como al conectar)", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_AUTH_INVALID", "El acceso de Mercado Libre no es válido");
    });
    const { t, post } = await setup({ operations: fake.operations });
    const publication = await published(t, false);

    const response = await post(`/publications/${publication.id}/pause`);

    expect(response.status).toBe(400);
    expect((await t.platformAccounts.get(publication.platformAccountId))?.status).toBe("expired");
  });

  it("con el token por vencer: lo refresca con el par de la app; sin el par, 503 sin llamar", async () => {
    for (const configured of [true, false]) {
      const { t, post, calls, mercadoLibreAuth } = await setup({
        mercadoLibreConfigured: configured,
      });
      const publication = await published(t, false);
      const account = await t.platformAccounts.get(publication.platformAccountId);
      await t.platformAccounts.upsertConnected({
        brokerId: account?.brokerId ?? "",
        platform: PORTAL,
        externalAccountId: "8035443",
        displayName: "VICENTEWOLDE",
        tokenExpiresAt: null,
        meta: { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
        credentials: { ...PORTAL_SCENARIO_TOKENS },
      });

      const response = await post(`/publications/${publication.id}/pause`);

      if (configured) {
        expect(response.status).toBe(200);
        expect(mercadoLibreAuth.calls).toContain("refresh");
      } else {
        expect(response.status).toBe(503);
        expect(mercadoLibreAuth.calls).not.toContain("refresh");
      }
      // Sin token, nunca llega a pausar en Mercado Libre.
      if (!configured) expect(calls).toEqual([]);
    }
  });

  it("sin las operaciones de la plataforma: 503 PUBLISHER_NOT_CONFIGURED", async () => {
    const { t } = await setup();
    const publication = await published(t, false);
    const bare = createApp(
      testDeps({
        listings: t.listings,
        brokers: t.brokers,
        platformAccounts: t.platformAccounts,
        publications: t.publications,
        lock: t.deps.lock,
        queue: t.deps.queue,
        publishMode: "live",
      }),
    );
    const response = await bare.request(`/publications/${publication.id}/pause`, {
      method: "POST",
      headers: json,
      body: "{}",
    });

    expect(response.status).toBe(503);
  });
});

describe("POST /publications/:id/sync", () => {
  it("encola la lectura (202, queued); si ya había una programada, queued: false", async () => {
    const { t, post } = await setup();
    const publication = await published(t, false);

    const response = await post(`/publications/${publication.id}/sync`);

    expect(response.status).toBe(202);
    expect(publicationSyncResponseSchema.parse(await response.json())).toEqual({
      publicationId: publication.id,
      queued: true,
    });
    expect(t.queue.jobs).toContainEqual({
      name: "publication.sync",
      data: { publicationId: publication.id },
      options: { singletonKey: publication.id },
    });

    const busy = await setup({ queue: () => ({ enqueue: async () => null }) });
    const other = await published(busy.t, false);
    const again = await busy.post(`/publications/${other.id}/sync`);
    expect(publicationSyncResponseSchema.parse(await again.json()).queued).toBe(false);
  });

  it("una que no existe es 404; una de Instagram, 409 OPERATION_NOT_SUPPORTED", async () => {
    const { post, errorOf } = await setup();
    const missing = await post(`/publications/${randomUUID()}/sync`);
    expect(missing.status).toBe(404);

    const instagram = await createPublicationScenario({ nextId: randomUUID });
    const app = createApp(
      testDeps({
        listings: instagram.listings,
        publications: instagram.publications,
        lock: instagram.deps.lock,
        queue: instagram.deps.queue,
      }),
    );
    const id = instagram.byFormat("post")?.id ?? "";
    const response = await app.request(`/publications/${id}/sync`, {
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("OPERATION_NOT_SUPPORTED");
  });
});

describe("publicar y aprobar Portal", () => {
  /** Le quita el WhatsApp al corredor (Portal lo exige). */
  async function withoutWhatsapp(t: PublicationScenario) {
    const listing = await t.listings.get(t.listingId);
    const broker = listing === null ? null : await t.brokers.findById(listing.brokerId);
    if (broker === null) throw new Error("falta el corredor");
    const { id, logoMediaId: _logo, autoPublish: _auto, ...data } = broker;
    await t.brokers.update(id, { ...data, whatsapp: null });
  }

  it("PORTAL_NOT_READY es 409 con la lista de lo que falta (y nada más de details)", async () => {
    const { t, post, errorOf } = await setup();
    await withoutWhatsapp(t);

    const response = await post(`/listings/${t.listingId}/publish`, { platform: PORTAL });

    expect(response.status).toBe(409);
    const body = await errorOf(response);
    expect(body).toEqual({
      code: "PORTAL_NOT_READY",
      message: expect.stringContaining("Falta información para publicar en Portal"),
      issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null, message: expect.any(String) }],
    });
    expect(JSON.stringify(body)).not.toContain(t.listingId);
  });

  it("un aviso que cambió desde que se aprobó: 409 PUBLICATION_LISTING_CHANGED al instante", async () => {
    const { t, post, errorOf } = await setup();
    const [started] = (
      await publishListing(t.deps, {
        listingId: t.listingId,
        platform: PORTAL,
        dryRun: true,
        actor: "cli",
      })
    ).started;
    if (started === undefined) throw new Error("falta la publicación");
    await t.publications.transition(
      started.id,
      { from: "publishing", to: "failed" },
      { actor: "system" },
    );
    const listing = (await t.listings.get(t.listingId)) as Listing;
    const {
      id: _id,
      brokerId: _b,
      category: _c,
      status: _s,
      closeReason: _r,
      source: _o,
      createdAt: _ca,
      updatedAt: _ua,
      ...core
    } = listing;
    await t.listings.update(t.listingId, {
      ...core,
      priceAmount: (listing.priceAmount ?? 0) + 100,
      attributes: core.attributes as ListingAttributes,
      sourceHash: "h-2",
    });

    const response = await post(`/publications/${started.id}/publish`);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("PUBLICATION_LISTING_CHANGED");
    expect(t.publications.all()[0]?.status).toBe("failed");
  });

  it("el contenido y aprobar traen lo que le falta al aviso para Portal", async () => {
    const { t, app, post } = await setup({ approve: false });
    await withoutWhatsapp(t);

    const content = listingContentResponseSchema.parse(
      await (await app.request(`/listings/${t.listingId}/content`)).json(),
    );
    expect(content.portalReadiness).toEqual({
      ready: false,
      issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null, message: expect.any(String) }],
    });

    const approved = contentApproveResponseSchema.parse(
      await (await post(`/contents/${await t.portalId()}/approve`)).json(),
    );
    expect(approved.content.status).toBe("approved");
    expect(approved.portalReadiness).toMatchObject({ ready: false });
  });
});

describe("seguridad de las rutas nuevas", () => {
  it("un formulario desde otro origen no llega a pausar, reactivar, cerrar ni pedir el sync (CSRF)", async () => {
    const { t, app, calls } = await setup();
    const publication = await published(t, false);

    for (const path of ["pause", "resume", "close", "sync"]) {
      const response = await app.request(`/publications/${publication.id}/${path}`, {
        method: "POST",
        headers: { Origin: "http://evil.test" },
        body: JSON.stringify({ confirmed: true }),
      });
      expect(response.status, path).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toEqual([]);
  });

  it("otro Host es 403 HOST_NOT_ALLOWED", async () => {
    const { t, app, errorOf, calls } = await setup();
    const publication = await published(t, false);

    const response = await app.request(`http://evil.test/publications/${publication.id}/pause`, {
      method: "POST",
      headers: json,
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("HOST_NOT_ALLOWED");
    expect(calls).toEqual([]);
  });

  it("ninguna respuesta lleva tokens ni lo guardado del publisher", async () => {
    const { t, app, post } = await setup();
    const publication = await published(t, false);

    const bodies = [
      await (await post(`/publications/${publication.id}/pause`)).text(),
      await (await post(`/publications/${publication.id}/sync`)).text(),
      await (await app.request(`/publications/${publication.id}`)).text(),
      await (await app.request(`/listings/${t.listingId}/publications`)).text(),
      await (await app.request(`/publications/${publication.id}/events`)).text(),
    ];

    for (const body of bodies) {
      expect(body).not.toContain(PORTAL_SCENARIO_TOKENS.accessToken);
      expect(body).not.toContain(PORTAL_SCENARIO_TOKENS.refreshToken);
      expect(body).not.toContain("911112222");
      expect(body).not.toContain("1-MLC_PIC");
    }
    expect(
      publicationResponseSchema.parse(JSON.parse(bodies[2] ?? "{}")).publication,
    ).not.toHaveProperty("progress");
  });
});
