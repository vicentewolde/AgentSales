import { randomUUID } from "node:crypto";
import {
  AppError,
  chileDateStart,
  type ListingImportData,
  type PlatformContext,
  type PublicationOperations,
  type PublishMode,
  publishListing,
} from "@agentsales/core";
import { createPublicationScenario } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import {
  agendaResponseSchema,
  brokerResponseSchema,
  calendarResponseSchema,
  errorBodySchema,
  publicationEventsResponseSchema,
  publicationResponseSchema,
  scheduleResponseSchema,
  trackingResponseSchema,
} from "../contracts/index.js";
import { adminApp, TEST_ADMIN_TOKEN, testDeps } from "../testing/index.js";

// F6-T10 (spec F6 §4.13): programar, desprogramar, el lote, la matriz, la agenda, `auto_publish` y
// actualizar o republicar Portal, con la API en proceso.

const json = { "Content-Type": "application/json" };
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function setup(
  options: {
    publishMode?: PublishMode;
    platform?: "instagram" | "portal_inmobiliario";
    now?: () => Date;
  } = {},
) {
  const t = await createPublicationScenario({
    nextId: randomUUID,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const app = adminApp(
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
      publishMode: options.publishMode ?? "dry-run",
      ...(options.now === undefined ? {} : { now: options.now }),
      healthDetails: {
        backupStatus: async () => null,
      },
    }),
  );
  const send = (method: string, path: string, body: unknown = {}) =>
    app.request(path, { method, headers: json, body: JSON.stringify(body) });
  const post = (path: string, body: unknown = {}) => send("POST", path, body);
  const codeOf = async (response: Response) =>
    errorBodySchema.parse(await response.json()).error.code;
  const brokerSlug = async () => {
    const listing = await t.listings.get(t.listingId);
    return (await t.brokers.findById(listing?.brokerId ?? ""))?.slug ?? "";
  };
  return { t, app, send, post, codeOf, brokerSlug };
}

describe("POST /publications/:id/schedule y /unschedule", () => {
  it("programa con el modo de la API y la hora al minuto; desprogramar la deja aprobada", async () => {
    const { t, post } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const response = await post(`/publications/${id}/schedule`, { at: inMinutes(60) });

    expect(response.status).toBe(200);
    const { publication } = publicationResponseSchema.parse(await response.json());
    expect(publication).toMatchObject({ status: "scheduled", dryRun: true, schedule: "upcoming" });
    expect(publication.scheduledAt?.getUTCSeconds()).toBe(0);

    const back = await post(`/publications/${id}/unschedule`);
    expect(back.status).toBe(200);
    expect(publicationResponseSchema.parse(await back.json()).publication).toMatchObject({
      status: "approved",
      scheduledAt: null,
      schedule: null,
    });
  });

  it("en vivo queda programada en vivo, aunque el cuerpo diga dryRun (el modo es de la API)", async () => {
    const { t, post } = await setup({ publishMode: "live" });
    const response = await post(`/publications/${t.byFormat("post")?.id}/schedule`, {
      at: inMinutes(30),
      dryRun: true,
    });
    expect(publicationResponseSchema.parse(await response.json()).publication.dryRun).toBe(false);
  });

  it("muy pronto o muy lejos es 400 con su código; una hora sin zona es 400 REQUEST_INVALID", async () => {
    const { t, post, codeOf } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const soon = await post(`/publications/${id}/schedule`, { at: inMinutes(1) });
    expect([soon.status, await codeOf(soon)]).toEqual([400, "SCHEDULE_TOO_SOON"]);
    const far = await post(`/publications/${id}/schedule`, { at: inMinutes(61 * 24 * 60) });
    expect([far.status, await codeOf(far)]).toEqual([400, "SCHEDULE_TOO_FAR"]);
    const local = await post(`/publications/${id}/schedule`, { at: "2026-10-19T10:00:00" });
    expect([local.status, await codeOf(local)]).toEqual([400, "REQUEST_INVALID"]);
  });

  it("la bitácora muestra la hora al programar y la anterior y la nueva al reprogramar", async () => {
    const { t, app, post } = await setup();
    const id = t.byFormat("post")?.id ?? "";
    await post(`/publications/${id}/schedule`, { at: inMinutes(60) });
    await post(`/publications/${id}/schedule`, { at: inMinutes(120) });

    const { events } = publicationEventsResponseSchema.parse(
      await (await app.request(`/publications/${id}/events`)).json(),
    );
    expect(events.find((e) => e.toStatus === "scheduled")?.payload).toMatchObject({
      reason: "operator",
      scheduledAt: expect.any(String),
    });
    expect(events.find((e) => e.type === "schedule_changed")?.payload).toEqual({
      from: expect.any(String),
      to: expect.any(String),
      mode: "dry-run",
    });
  });

  it("desprogramar una que no está programada es 409; originGuard frena un POST del panel sin Origin", async () => {
    const { t, app, post, codeOf } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const response = await post(`/publications/${id}/unschedule`);
    expect([response.status, await codeOf(response)]).toEqual([409, "INVALID_TRANSITION"]);
    const bare = await app.request(`/publications/${id}/unschedule`, {
      method: "POST",
      headers: { Cookie: `agentsales_session=${TEST_ADMIN_TOKEN}` },
    });
    expect(bare.status).toBe(403);
  });
});

describe("POST /schedule", () => {
  it("programa las propiedades con su resultado y salta la que no se puede, sin cortar el lote", async () => {
    const { t, post } = await setup();
    const missing = randomUUID();

    const response = await post("/schedule", {
      listingIds: [t.listingId, missing],
      platforms: ["instagram"],
      at: inMinutes(120),
      spacingMinutes: 15,
    });

    expect(response.status).toBe(200);
    const body = scheduleResponseSchema.parse(await response.json());
    expect(body.results).toMatchObject([
      { listingId: t.listingId, platform: "instagram", outcome: "scheduled" },
      { listingId: missing, outcome: "skipped", code: "LISTING_NOT_FOUND" },
    ]);
    expect(body.results[0]?.publications?.map((p) => p.status)).toEqual(["scheduled", "scheduled"]);
  });

  it("repetidas: 400 SCHEDULE_BATCH_INVALID; vacío o con un espaciado de más: 400 REQUEST_INVALID", async () => {
    const { t, post, codeOf } = await setup();
    const repeated = await post("/schedule", {
      listingIds: [t.listingId, t.listingId],
      at: inMinutes(60),
    });
    expect([repeated.status, await codeOf(repeated)]).toEqual([400, "SCHEDULE_BATCH_INVALID"]);
    for (const body of [
      { listingIds: [], at: inMinutes(60) },
      { listingIds: [t.listingId], at: inMinutes(60), spacingMinutes: 241 },
    ]) {
      const response = await post("/schedule", body);
      expect([response.status, await codeOf(response)]).toEqual([400, "REQUEST_INVALID"]);
    }
  });
});

describe("GET /tracking y GET /agenda", () => {
  it("la matriz trae cada propiedad con sus celdas; un corredor que no existe es 404", async () => {
    const { t, app, post, brokerSlug } = await setup();
    await post(`/publications/${t.byFormat("post")?.id}/schedule`, { at: inMinutes(90) });

    const response = await app.request(`/tracking?broker=${await brokerSlug()}`);

    expect(response.status).toBe(200);
    const { rows } = trackingResponseSchema.parse(await response.json());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.listing.id).toBe(t.listingId);
    expect(rows[0]?.coverUrl).not.toBeNull();
    expect(rows[0]?.cells.instagram.map((p) => [p.format, p.status, p.schedule])).toEqual([
      ["post", "scheduled", "upcoming"],
      ["reel", "approved", null],
    ]);
    expect((await app.request("/tracking?broker=nadie")).status).toBe(404);
  });

  it("la matriz no muestra las archivadas salvo ?archived=1", async () => {
    const { t, app } = await setup();
    t.listings.setStatus(t.listingId, "archived");
    const rows = async (query: string) =>
      trackingResponseSchema.parse(await (await app.request(`/tracking${query}`)).json()).rows;
    expect(await rows("")).toEqual([]);
    expect(await rows("?archived=1")).toHaveLength(1);
  });

  it("la agenda trae las próximas, las falladas con su consejo y el respaldo", async () => {
    const { t, app, post } = await setup();
    await post(`/publications/${t.byFormat("post")?.id}/schedule`, { at: inMinutes(90) });
    const reel = t.byFormat("reel")?.id ?? "";
    await t.publications.transition(
      reel,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.publications.transition(
      reel,
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "IG_AUTH_INVALID", message: "m", retriable: false } },
      },
      { actor: "system" },
    );

    const response = await app.request("/agenda");

    expect(response.status).toBe(200);
    const { items } = agendaResponseSchema.parse(await response.json());
    expect(items.map((item) => [item.kind, item.action])).toEqual([
      ["failed", "retry"],
      ["upcoming", "none"],
      ["backup", "backup"],
    ]);
    expect(items[0]).toMatchObject({ code: "IG_AUTH_INVALID", publicationId: reel });
    expect(items[0]?.advice).toBeTruthy();
  });
});

describe("GET /calendar (F9-T18)", () => {
  const range = (from: string, to: string) =>
    `from=${encodeURIComponent(chileDateStart(from).toISOString())}&to=${encodeURIComponent(chileDateStart(to).toISOString())}`;

  it("trae lo programado del rango; reprogramar (el caso de uso de F6) lo mueve de día", async () => {
    // 2026-10-15 12:00 en Chile.
    const now = new Date("2026-10-15T15:00:00.000Z");
    const { t, app, post, brokerSlug } = await setup({ now: () => now });
    const id = t.byFormat("post")?.id ?? "";
    // El 16 a las 10:00 de Chile (UTC-3).
    await post(`/publications/${id}/schedule`, { at: "2026-10-16T10:00:00-03:00" });

    const day = async (from: string, to: string, broker = "") => {
      const response = await app.request(`/calendar?${range(from, to)}${broker}`);
      expect(response.status).toBe(200);
      return calendarResponseSchema.parse(await response.json()).entries;
    };
    const [entry] = await day("2026-10-16", "2026-10-17", `&broker=${await brokerSlug()}`);
    expect(entry).toMatchObject({
      publicationId: id,
      kind: "scheduled",
      platform: "instagram",
      format: "post",
      status: "scheduled",
      dryRun: true,
      schedule: "upcoming",
      listingId: t.listingId,
      postId: null,
      brokerSlug: await brokerSlug(),
    });
    expect(entry?.at.toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(await day("2026-10-17", "2026-10-18")).toEqual([]);

    // Mover la fecha es `POST /publications/:id/schedule` (schedulePublication, F6).
    const moved = await post(`/publications/${id}/schedule`, { at: "2026-10-17T09:30:00-03:00" });
    expect(moved.status).toBe(200);
    expect(await day("2026-10-16", "2026-10-17")).toEqual([]);
    expect((await day("2026-10-17", "2026-10-18")).map((e) => e.publicationId)).toEqual([id]);
  });

  it("el día del cambio de hora (6 de septiembre) empieza a la 01:00 y guarda lo de esa madrugada", async () => {
    const now = new Date("2026-09-01T15:00:00.000Z");
    const { t, app, post } = await setup({ now: () => now });
    const id = t.byFormat("post")?.id ?? "";
    // 01:30 del 6 en Chile, ya en horario de verano (UTC-3): 04:30 UTC.
    await post(`/publications/${id}/schedule`, { at: "2026-09-06T04:30:00Z" });

    const entries = async (from: string, to: string) =>
      calendarResponseSchema.parse(await (await app.request(`/calendar?${range(from, to)}`)).json())
        .entries;
    expect(await entries("2026-09-05", "2026-09-06")).toEqual([]);
    expect((await entries("2026-09-06", "2026-09-07")).map((e) => e.publicationId)).toEqual([id]);
  });

  it("un rango al revés, vacío o de más de 43 días es 400; sin zona, 400; un corredor ajeno, 404", async () => {
    const { app, codeOf } = await setup();
    for (const query of [
      range("2026-10-20", "2026-10-19"),
      range("2026-10-20", "2026-10-20"),
      range("2026-10-01", "2026-11-14"),
      "from=2026-10-01T00:00:00&to=2026-10-08T00:00:00",
      "from=2026-10-01T03:00:00Z",
    ]) {
      const response = await app.request(`/calendar?${query}`);
      expect([query, response.status, await codeOf(response)]).toEqual([
        query,
        400,
        "REQUEST_INVALID",
      ]);
    }
    expect((await app.request(`/calendar?${range("2026-10-01", "2026-11-12")}`)).status).toBe(200);
    expect(
      (await app.request(`/calendar?${range("2026-10-01", "2026-10-08")}&broker=nadie`)).status,
    ).toBe(404);
  });
});

describe("PATCH /brokers/:id (auto_publish)", () => {
  it("lo activa; la agenda muestra lo aprobado sin publicar y lo que espera revisión", async () => {
    const { t, app, send } = await setup();
    const listing = await t.listings.get(t.listingId);
    const brokerId = listing?.brokerId ?? "";
    // Un texto de Portal sin aprobar: el escenario conecta solo Instagram, así que no cuenta.
    const response = await send("PATCH", `/brokers/${brokerId}`, { autoPublish: true });

    expect(response.status).toBe(200);
    expect(brokerResponseSchema.parse(await response.json()).broker.autoPublish).toBe(true);
    const { items } = agendaResponseSchema.parse(await (await app.request("/agenda")).json());
    expect(items.filter((item) => item.kind === "approved_waiting")).toHaveLength(2);
    expect(items.filter((item) => item.kind === "needs_review")).toEqual([]);

    await t.platformAccounts.upsertConnected({
      brokerId,
      platform: "portal_inmobiliario",
      externalAccountId: "8035443",
      displayName: "Portal",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "a", refreshToken: "r" },
    });
    const again = agendaResponseSchema.parse(await (await app.request("/agenda")).json()).items;
    expect(again.filter((item) => item.kind === "needs_review")).toMatchObject([
      { platform: "portal_inmobiliario", action: "review" },
    ]);
  });

  it("un corredor que no existe es 404; un cuerpo sin autoPublish, 400", async () => {
    const { send } = await setup();
    expect((await send("PATCH", `/brokers/${randomUUID()}`, { autoPublish: true })).status).toBe(
      404,
    );
    expect((await send("PATCH", `/brokers/${randomUUID()}`, {})).status).toBe(400);
  });
});

describe("POST /publications/:id/update y /relist (Portal en simulación)", () => {
  async function portal() {
    const s = await setup({ platform: "portal_inmobiliario" });
    const [started] = (
      await publishListing(s.t.deps, {
        listingId: s.t.listingId,
        platform: "portal_inmobiliario",
        dryRun: true,
        actor: "cli",
      })
    ).started;
    if (started === undefined) throw new Error("falta la publicación");
    await s.t.publications.transition(
      started.id,
      { from: "publishing", to: "published", changes: { externalId: `dry-run:${started.id}` } },
      { actor: "system" },
    );
    return { ...s, id: started.id };
  }

  it("actualizar sin cambios es 409 PORTAL_NOTHING_TO_UPDATE", async () => {
    const { post, codeOf, id } = await portal();
    const response = await post(`/publications/${id}/update`);
    expect([response.status, await codeOf(response)]).toEqual([409, "PORTAL_NOTHING_TO_UPDATE"]);
  });

  it("republicar una cerrada crea una nueva que recuerda la anterior (202)", async () => {
    const { t, post, id } = await portal();
    await t.publications.transition(
      id,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );

    const response = await post(`/publications/${id}/relist`);

    expect(response.status).toBe(202);
    expect(publicationResponseSchema.parse(await response.json()).publication).toMatchObject({
      relistedFrom: id,
      status: "publishing",
      dryRun: true,
    });
  });

  it("republicar una publicada es 409 RELIST_NOT_ALLOWED", async () => {
    const { post, codeOf, id } = await portal();
    const response = await post(`/publications/${id}/relist`);
    expect([response.status, await codeOf(response)]).toEqual([409, "RELIST_NOT_ALLOWED"]);
  });
});

describe("Portal en vivo: confirmaciones y el tope de tiempo de la propiedad", () => {
  const PORTAL = "portal_inmobiliario";
  const ITEM_ID = "MLC1234567890";

  /** Un aviso de Portal publicado en vivo, con operaciones dobles (nunca Mercado Libre). */
  async function live(options: { operations?: PublicationOperations; timeoutMs?: number } = {}) {
    const t = await createPublicationScenario({ nextId: randomUUID, platform: PORTAL });
    const app = adminApp(
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
        publishMode: "live",
        operationsFor: (platform) => (platform === PORTAL ? options.operations : undefined),
        ...(options.timeoutMs === undefined ? {} : { operationTimeoutMs: options.timeoutMs }),
      }),
    );
    const [started] = (
      await publishListing(t.deps, {
        listingId: t.listingId,
        platform: PORTAL,
        dryRun: false,
        actor: "cli",
      })
    ).started;
    if (started === undefined) throw new Error("falta la publicación");
    await t.publications.saveProgress(started.id, {
      pictureIds: ["1-MLC_PIC"],
      sellerContact: { contact: null, email: null, countryCode2: "56", phone2: "911112222" },
      itemId: ITEM_ID,
      descriptionDone: true,
    });
    await t.listings.changeStatus(t.listingId, "ready", "active");
    await t.publications.transition(
      started.id,
      { from: "publishing", to: "published", changes: { externalId: ITEM_ID } },
      { actor: "system" },
    );
    const post = (path: string, body: unknown = {}) =>
      app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });
    const codeOf = async (response: Response) =>
      errorBodySchema.parse(await response.json()).error.code;
    return { t, post, codeOf, id: started.id };
  }

  it("actualizar en vivo sin confirmar es 409 UPDATE_NOT_CONFIRMED", async () => {
    const { t, post, codeOf, id } = await live();
    const listing = await t.listings.get(t.listingId);
    await t.listings.update(t.listingId, {
      ...listing,
      priceAmount: (listing?.priceAmount ?? 0) + 100,
      sourceHash: "h-nueva",
    } as unknown as ListingImportData);

    const response = await post(`/publications/${id}/update`);
    expect([response.status, await codeOf(response)]).toEqual([409, "UPDATE_NOT_CONFIRMED"]);
  });

  it("republicar en vivo sin confirmar es 409 RELIST_NOT_CONFIRMED", async () => {
    const { t, post, codeOf, id } = await live();
    await t.publications.transition(
      id,
      {
        from: "published",
        to: "unpublished",
        changes: {
          remoteState: {
            status: "closed",
            subStatus: ["expired"],
            stopTime: new Date(Date.now() - 86_400_000).toISOString(),
            expirationTime: null,
            checkedAt: new Date().toISOString(),
          },
        },
      },
      { actor: "system" },
    );

    const response = await post(`/publications/${id}/relist`);
    expect([response.status, await codeOf(response)]).toEqual([409, "RELIST_NOT_CONFIRMED"]);
  });

  it("pausar la propiedad con Portal colgado se corta al tope (503 ML_ABORTED) y la propiedad no cambia", async () => {
    const hang = (_ref: unknown, ctx: PlatformContext) =>
      new Promise<never>((_resolve, reject) => {
        ctx.signal?.addEventListener("abort", () =>
          reject(new AppError("ML_ABORTED", "Se cortó la llamada", { retriable: true })),
        );
      });
    const operations: PublicationOperations = {
      pause: hang,
      resume: hang,
      close: hang,
      getStatus: hang,
    };
    const { t, post, codeOf, id } = await live({ operations, timeoutMs: 20 });

    const response = await post(`/listings/${t.listingId}/status`, {
      action: "pause",
      confirmed: true,
    });

    expect([response.status, await codeOf(response)]).toEqual([503, "ML_ABORTED"]);
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
    expect(t.publications.all().find((p) => p.id === id)?.status).toBe("published");
  });
});
