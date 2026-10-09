import { describe, expect, it } from "vitest";
import type { PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { ListingAttributes } from "../listing-validator/index.js";
import { MERCADOLIBRE_REJECTED_AFTER_REFRESH } from "../ports/mercadolibre-auth.js";
import type {
  PlatformContext,
  PublishContext,
  Publisher,
  PublishInput,
  PublishResult,
  PublishValidation,
} from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import {
  createFakePublisher,
  createPublicationScenario,
  PORTAL_SCENARIO_TOKENS,
  type PublicationScenario,
} from "../testing/index.js";
import { approveContent } from "./approve-content.js";
import { publishListing } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";
import { startPublication } from "./start-publication.js";

// F4-T16: el intento, publicar y aprobar con Portal (spec F4 §4.5, §4.6 y §4.8).

// La hora real: el token del escenario vence una hora después de crearlo (`ensureAccessToken` lo
// compara con este reloj).
const NOW = new Date();
const PORTAL = "portal_inmobiliario";

/** Un publisher de Portal guionado: guarda lo que recibió y responde con `respond`. */
function portalPublisher(
  respond: (input: PublishInput, ctx: PublishContext) => Promise<PublishResult> = async () => ({
    externalId: "MLC1234567890",
    externalUrl: "https://departamento.mercadolibre.cl/MLC-1234567890-_JM",
    simulated: false,
    remote: {
      status: "paused",
      subStatus: ["picture_download_pending"],
      stopTime: "2027-04-07T12:00:00.000-03:00",
      expirationTime: null,
    },
  }),
  preflight?: (input: PublishInput, ctx: PlatformContext) => Promise<PublishValidation>,
) {
  const calls: Array<{ input: PublishInput; ctx: PublishContext }> = [];
  const preflighted: Array<{ input: PublishInput; ctx: PlatformContext }> = [];
  const publisher: Publisher = {
    platform: PORTAL,
    formats: ["post"],
    validate: () => ({ ok: true }),
    async publish(input, ctx) {
      calls.push({ input, ctx });
      return respond(input, ctx);
    },
    ...(preflight === undefined
      ? {}
      : {
          async preflight(input: PublishInput, ctx: PlatformContext) {
            preflighted.push({ input, ctx });
            return preflight(input, ctx);
          },
        }),
  };
  return { publisher, calls, preflighted };
}

/** Un refresco falso de Mercado Libre: cuenta las llamadas y entrega un par nuevo. */
function fakeRefresh() {
  const refreshed: string[] = [];
  return {
    refreshed,
    auth: {
      async refresh(refreshToken: string) {
        refreshed.push(refreshToken);
        return {
          accessToken: `APP_USR-nuevo-${refreshed.length}`,
          refreshToken: `TG-nuevo-${refreshed.length}`,
          accessTokenExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
          scopes: ["offline_access", "read", "write"],
          userId: "8035443",
        };
      },
    },
  };
}

/** Le quita el WhatsApp al corredor del aviso (Portal lo exige, D5). */
async function withoutWhatsapp(t: PublicationScenario) {
  const listing = await t.listings.get(t.listingId);
  const broker = listing === null ? null : await t.brokers.findById(listing.brokerId);
  if (broker === null) throw new Error("falta el corredor");
  const { id, logoMediaId: _logo, autoPublish: _auto, ...data } = broker;
  await t.brokers.update(id, { ...data, whatsapp: null });
}

/** Cambia el aviso como lo haría una carga del Excel (con su versión nueva). */
async function reimport(
  t: PublicationScenario,
  change: (listing: Listing) => Partial<Listing>,
  sourceHash = "h-2",
) {
  const listing = await t.listings.get(t.listingId);
  if (listing === null) throw new Error("falta el aviso");
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
  } = { ...listing, ...change(listing) };
  await t.listings.update(t.listingId, {
    ...core,
    attributes: core.attributes as ListingAttributes,
    sourceHash,
  });
}

async function setup(
  options: {
    dryRun?: boolean;
    workerMode?: PublishMode;
    publisher?: Publisher;
    mercadoLibre?: ReturnType<typeof fakeRefresh>["auth"] | null;
  } = {},
) {
  const t = await createPublicationScenario({ platform: PORTAL });
  const warnings: unknown[] = [];
  const start = () =>
    publishListing(t.deps, {
      listingId: t.listingId,
      platform: PORTAL,
      dryRun: options.dryRun ?? false,
      actor: "operator",
    });
  const deps = {
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    contents: t.contents,
    media: t.media,
    listings: t.listings,
    brokers: t.brokers,
    storage: t.storage,
    publishers: { [PORTAL]: options.publisher ?? portalPublisher().publisher },
    workerMode: options.workerMode ?? "live",
    mercadoLibre: options.mercadoLibre === undefined ? null : options.mercadoLibre,
    now: () => NOW,
    onWarning: (warning: unknown) => warnings.push(warning),
  };
  const run = (publication: Publication, isLastAttempt = false) =>
    publishPublication(deps, { publicationId: publication.id, isLastAttempt });
  const current = (id: string) => t.publications.all().find((p) => p.id === id);
  return { t, start, deps, run, current, warnings };
}

describe("aprobar con Portal", () => {
  it("abre un post con las fotos y la versión del aviso, y devuelve que está listo", async () => {
    const t = await createPublicationScenario({ platform: PORTAL });

    expect(t.approved?.portalReadiness).toEqual({ ready: true });
    expect(t.approved?.created).toHaveLength(1);
    expect(t.approved?.created[0]).toMatchObject({
      platform: PORTAL,
      format: "post",
      listingSourceHash: "h",
    });
  });

  it("lo que falta es una advertencia: el texto se aprueba igual", async () => {
    const t = await createPublicationScenario({ platform: PORTAL, approve: false });
    await withoutWhatsapp(t);
    await reimport(t, () => ({}));

    const approved = await approveContent(t.approveDeps, {
      contentId: await t.portalId(),
      actor: "operator",
    });

    expect(approved.content.status).toBe("approved");
    expect(approved.portalReadiness).toMatchObject({
      ready: false,
      issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null }],
    });
    expect(approved.created[0]?.listingSourceHash).toBe("h-2");
  });

  it("Instagram no recibe portalReadiness", async () => {
    const t = await createPublicationScenario();
    expect(t.approved).not.toHaveProperty("portalReadiness");
  });
});

describe("publicar Portal: revisiones antes de pasar a publishing", () => {
  it("al aviso le falta algo: PORTAL_NOT_READY con lo que falta, sin cambiar nada ni encolar", async () => {
    const { t, start } = await setup();
    await withoutWhatsapp(t);

    const error = await start().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "PORTAL_NOT_READY",
      retriable: false,
      details: { issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null }] },
    });
    expect(t.publications.all().map((p) => p.status)).toEqual(["approved"]);
    expect(t.queue.jobs).toEqual([]);
  });

  it("publicar una también revisa lo que falta (PORTAL_NOT_READY)", async () => {
    const { t } = await setup();
    const [post] = t.publications.all();
    if (post === undefined) throw new Error("falta el post");
    await withoutWhatsapp(t);

    await expect(
      startPublication(t.deps, { publicationId: post.id, dryRun: true, actor: "operator" }),
    ).rejects.toMatchObject({ code: "PORTAL_NOT_READY" });
    expect(t.publications.all()[0]?.status).toBe("approved");
  });

  it("un texto aprobado que hoy tiene errores (una regla nueva) no pasa: CONTENT_HAS_ERRORS", async () => {
    const { t, start } = await setup();
    const contentId = await t.portalId();
    const content = await t.contents.get(contentId);
    // Un teléfono en el texto de Portal es un error desde F4-T12 (CONTACT_IN_TEXT).
    await t.contents.update(contentId, {
      body: `${content?.body ?? ""}\nLlama al +56 9 8765 4321.`,
    });

    const error = await start().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONTENT_HAS_ERRORS",
      retriable: false,
      details: { contentId, codes: expect.arrayContaining(["CONTACT_IN_TEXT"]) },
    });
    expect((error as Error).message).toContain("quita la aprobación");
    expect(t.publications.all().map((p) => p.status)).toEqual(["approved"]);

    const [post] = t.publications.all();
    await expect(
      startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_HAS_ERRORS" });
  });

  it("Instagram sigue igual: no se vuelve a revisar el texto ni lo que pide Portal", async () => {
    const t = await createPublicationScenario();
    const contentId = await t.instagramId();
    const content = await t.contents.get(contentId);
    await t.contents.update(contentId, {
      body: `${content?.body ?? ""}\nLlama al +56 9 8765 4321.`,
    });

    await expect(
      publishListing(t.deps, {
        listingId: t.listingId,
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      }),
    ).resolves.toMatchObject({ started: [expect.anything(), expect.anything()] });
  });

  it("reintentar una fallida también revisa; si solo hay que reencolar, no", async () => {
    const { t, start, run } = await setup({
      publisher: portalPublisher(async () => {
        throw new AppError("ML_ITEM_REJECTED", "Mercado Libre rechazó el aviso");
      }).publisher,
    });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");
    await run(post).catch(() => undefined);
    expect(t.publications.all()[0]?.status).toBe("failed");
    await withoutWhatsapp(t);

    // La fallida vuelve a `publishing`: se revisa y falta el WhatsApp.
    await expect(start()).rejects.toMatchObject({ code: "PORTAL_NOT_READY" });
    expect(t.publications.all()[0]?.status).toBe("failed");

    // Ya en `publishing` (un job perdido): se reencola sin revisar, el intento revisa todo.
    await t.publications.transition(
      post.id,
      { from: "failed", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await expect(start()).resolves.toMatchObject({ started: [], requeued: [{ id: post.id }] });
  });

  it("la revisión usa las definiciones leídas antes del candado (un dato del aviso no es error)", async () => {
    const { t, start } = await setup();
    const contentId = await t.portalId();
    const content = await t.contents.get(contentId);
    // 80 m² es la superficie total del aviso: está en el brief, armado con las definiciones.
    await t.contents.update(contentId, {
      body: `${content?.body ?? ""}
Superficie total de 80 m².`,
    });

    await expect(start()).resolves.toMatchObject({ started: [expect.anything()] });
  });

  it("sin la versión del aviso no nace ninguna publicación (LISTING_NOT_FOUND)", async () => {
    const t = await createPublicationScenario({ platform: PORTAL, approve: false });
    const getSourceHash = t.listings.getSourceHash;
    t.listings.getSourceHash = async () => "";
    try {
      await expect(
        approveContent(t.approveDeps, { contentId: await t.portalId(), actor: "operator" }),
      ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    } finally {
      t.listings.getSourceHash = getSourceHash;
    }
    expect(t.publications.all()).toEqual([]);
  });

  it("con todo en orden pasa a publishing y encola", async () => {
    const { t, start } = await setup();
    const result = await start();
    expect(result.started.map((p) => p.status)).toEqual(["publishing"]);
    expect(t.queue.jobs).toHaveLength(1);
  });
});

describe("el intento de Portal", () => {
  it("en live: publica con el aviso y el contacto, y guarda el estado remoto con checkedAt", async () => {
    const fake = portalPublisher();
    const { t, start, run, current } = await setup({ publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");

    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });

    expect(current(post.id)).toMatchObject({
      status: "published",
      externalId: "MLC1234567890",
      remoteState: {
        status: "paused",
        subStatus: ["picture_download_pending"],
        stopTime: "2027-04-07T12:00:00.000-03:00",
        expirationTime: null,
        checkedAt: NOW.toISOString(),
      },
    });
    const [call] = fake.calls;
    expect(call?.input.listing).toMatchObject({ propertyType: "Departamento", operation: "sale" });
    expect(call?.input.brokerContact?.whatsapp).toBe("+56 9 1111 2222");
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("el token sale de ensureAccessToken, nunca del guardado tal cual, y sin el refreshToken", async () => {
    const refresh = fakeRefresh();
    const seen: string[] = [];
    const fake = portalPublisher(async (_input, ctx) => {
      expect(ctx.credentials).toEqual({ accessToken: PORTAL_SCENARIO_TOKENS.accessToken });
      expect(JSON.stringify(ctx.credentials)).not.toContain(PORTAL_SCENARIO_TOKENS.refreshToken);
      const token = await ctx.accessToken?.();
      seen.push(token ?? "");
      // Después de un 401: el guardado (`storedAccessToken`) fallaría cerrado; este refresca.
      seen.push((await ctx.accessToken?.({ rejectedToken: token ?? "" })) ?? "");
      return { externalId: "MLC1", externalUrl: null, simulated: false };
    });
    const { start, run } = await setup({ publisher: fake.publisher, mercadoLibre: refresh.auth });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");

    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });

    expect(seen).toEqual([PORTAL_SCENARIO_TOKENS.accessToken, "APP_USR-nuevo-1"]);
    expect(refresh.refreshed).toEqual([PORTAL_SCENARIO_TOKENS.refreshToken]);
  });

  it("en dry-run, preflight recibe el mismo proveedor de token y sus notas van a la bitácora", async () => {
    const fake = portalPublisher(undefined, async (_input, ctx) => {
      expect(await ctx.accessToken()).toBe(PORTAL_SCENARIO_TOKENS.accessToken);
      return { ok: true, notes: ["Mercado Libre no revisó el aviso (ML_NO_QUOTA)"] };
    });
    const { t, start, run, current } = await setup({ dryRun: true, publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");

    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });

    expect(fake.calls).toEqual([]);
    expect(fake.preflighted).toHaveLength(1);
    expect(current(post.id)).toMatchObject({
      externalId: `dry-run:${post.id}`,
      remoteState: null,
    });
    const events = await t.publications.listEvents(post.id);
    expect(events.find((event) => event.type === "publish_attempt")?.payload).toMatchObject({
      mode: "dry-run",
      notes: ["Mercado Libre no revisó el aviso (ML_NO_QUOTA)"],
    });
  });

  it("un aviso que cambió desde que se aprobó: failed con PUBLICATION_LISTING_CHANGED", async () => {
    const fake = portalPublisher();
    const { t, start, run, current } = await setup({ publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");
    await reimport(t, (listing) => ({ priceAmount: (listing.priceAmount ?? 0) + 100 }));

    await expect(run(post)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_CHANGED" });
    expect(current(post.id)).toMatchObject({
      status: "failed",
      lastError: { code: "PUBLICATION_LISTING_CHANGED", retriable: false },
    });
    expect(fake.calls).toEqual([]);
  });

  it("ML_AUTH_INVALID (también el 401 repetido del catálogo o del publisher) deja la cuenta expired", async () => {
    const errors = [
      new AppError("ML_AUTH_INVALID", "El acceso de Mercado Libre no es válido", {
        details: { httpStatus: 401, reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
      }),
      new AppError("ML_AUTH_INVALID", "El acceso guardado no es válido", {
        details: { reason: "token_malformed" },
      }),
    ];
    for (const error of errors) {
      const fake = portalPublisher(async () => {
        throw error;
      });
      const { t, start, run, current } = await setup({ publisher: fake.publisher });
      const [post] = (await start()).started;
      if (post === undefined) throw new Error("falta el post");

      await expect(run(post)).rejects.toMatchObject({ code: "ML_AUTH_INVALID" });

      expect(current(post.id)).toMatchObject({ status: "failed" });
      expect((await t.platformAccounts.get(post.platformAccountId))?.status).toBe("expired");
    }
  });

  it("en dry-run, un ML_AUTH_INVALID de preflight también deja la cuenta expired", async () => {
    const fake = portalPublisher(undefined, async () => {
      throw new AppError("ML_AUTH_INVALID", "rechazado otra vez", {
        details: { reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
      });
    });
    const { t, start, run } = await setup({ dryRun: true, publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");

    await expect(run(post)).rejects.toMatchObject({ code: "ML_AUTH_INVALID" });
    expect((await t.platformAccounts.get(post.platformAccountId))?.status).toBe("expired");
  });

  it("un estado remoto que no calza se avisa y la publicación queda published igual", async () => {
    const fake = portalPublisher(async () => ({
      externalId: "MLC1",
      externalUrl: null,
      simulated: false,
      remote: { status: "active", subStatus: [], stopTime: "mañana", expirationTime: null },
    }));
    const { start, run, current, warnings } = await setup({ publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");

    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });

    expect(current(post.id)).toMatchObject({ status: "published", remoteState: null });
    expect(warnings).toContainEqual({
      publicationId: post.id,
      step: "remote_state",
      code: "PUBLICATION_REMOTE_STATE_INVALID",
    });
  });

  it("sin el par de la app y con el token por vencer: MERCADOLIBRE_NOT_CONFIGURED, sin publicar", async () => {
    const fake = portalPublisher(async (_input, ctx) => {
      await ctx.accessToken?.();
      return { externalId: "MLC1", externalUrl: null, simulated: false };
    });
    const { t, start, run, current } = await setup({ publisher: fake.publisher });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");
    const account = await t.platformAccounts.get(post.platformAccountId);
    await t.platformAccounts.upsertConnected({
      brokerId: account?.brokerId ?? "",
      platform: PORTAL,
      externalAccountId: "8035443",
      displayName: "VICENTEWOLDE",
      tokenExpiresAt: null,
      meta: { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
      credentials: { ...PORTAL_SCENARIO_TOKENS },
    });

    await expect(run(post)).rejects.toMatchObject({ code: "MERCADOLIBRE_NOT_CONFIGURED" });
    expect(current(post.id)).toMatchObject({ status: "failed" });
    expect((await t.platformAccounts.get(post.platformAccountId))?.status).toBe("connected");
  });

  it("Instagram sigue con el token guardado: un rejectedToken falla cerrado", async () => {
    const t = await createPublicationScenario();
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const seen: unknown[] = [];
    const instagram = createFakePublisher();
    const spy: Publisher = {
      ...instagram,
      async publish(input, ctx) {
        seen.push(ctx.credentials);
        await expect(ctx.accessToken?.({ rejectedToken: "x" })).rejects.toMatchObject({
          code: "ACCESS_TOKEN_REFRESH_UNSUPPORTED",
        });
        return instagram.publish(input, ctx);
      },
    };
    const [post] = started;
    if (post === undefined) throw new Error("falta el post");
    await publishPublication(
      {
        publications: t.publications,
        platformAccounts: t.platformAccounts,
        contents: t.contents,
        media: t.media,
        listings: t.listings,
        brokers: t.brokers,
        storage: t.storage,
        publishers: { instagram: spy },
        workerMode: "live",
        mercadoLibre: null,
        now: () => NOW,
      },
      { publicationId: post.id, isLastAttempt: false },
    );
    expect(seen).toEqual([{ accessToken: "IGAA-prueba" }]);
  });
});

describe("la versión del aviso al publicar (F4-T19)", () => {
  it("una fallida cuyo aviso cambió no vuelve a publishing: PUBLICATION_LISTING_CHANGED al instante", async () => {
    const { t, start, run } = await setup({
      publisher: portalPublisher(async () => {
        throw new AppError("ML_ITEM_REJECTED", "Mercado Libre rechazó el aviso");
      }).publisher,
    });
    const [post] = (await start()).started;
    if (post === undefined) throw new Error("falta el post");
    await run(post).catch(() => undefined);
    await reimport(t, (listing) => ({ priceAmount: (listing.priceAmount ?? 0) + 100 }));

    await expect(start()).rejects.toMatchObject({
      code: "PUBLICATION_LISTING_CHANGED",
      details: { publicationId: post.id, reason: "changed" },
    });
    await expect(
      startPublication(t.deps, { publicationId: post.id, dryRun: false, actor: "operator" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_LISTING_CHANGED" });
    expect(t.publications.all()[0]?.status).toBe("failed");
  });

  it("una publicación sin versión del aviso también es PUBLICATION_LISTING_CHANGED (como el worker)", async () => {
    const t = await createPublicationScenario({ platform: PORTAL, approve: false });
    await approveContent(t.approveDeps, { contentId: await t.portalId(), actor: "operator" });
    const [approved] = t.publications.all();
    if (approved === undefined) throw new Error("falta la publicación");
    // Una anterior a la migración 0007: sin versión (el repositorio guarda "" como `null`).
    const legacy = await t.publications.create(
      { ...approved, format: "reel", listingSourceHash: "" },
      { actor: "system" },
    );
    expect(legacy.listingSourceHash).toBeNull();

    await expect(
      startPublication(t.deps, { publicationId: legacy.id, dryRun: true, actor: "operator" }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_LISTING_CHANGED",
      details: { reason: "missing_version" },
    });
  });

  it("si la versión actual no se puede leer, una publicación sin versión tampoco pasa", async () => {
    const t = await createPublicationScenario({ platform: PORTAL, approve: false });
    await approveContent(t.approveDeps, { contentId: await t.portalId(), actor: "operator" });
    const [approved] = t.publications.all();
    if (approved === undefined) throw new Error("falta la publicación");
    const legacy = await t.publications.create(
      { ...approved, format: "reel", listingSourceHash: "" },
      { actor: "system" },
    );
    t.listings.getSourceHash = async () => null;

    await expect(
      startPublication(t.deps, { publicationId: legacy.id, dryRun: true, actor: "operator" }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_LISTING_CHANGED",
      details: { reason: "missing_version" },
    });
  });
});
