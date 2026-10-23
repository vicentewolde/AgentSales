import { randomUUID } from "node:crypto";
import {
  type BrokerData,
  listingSubject,
  type NewListing,
  postSubject,
  type WorkerHeartbeat,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "./access.js";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import { TEST_ADMIN_CLI_TOKEN, TEST_ADMIN_TOKEN, testAuth, testDeps } from "./testing/index.js";

// F7-T08 y T09 (spec F7 §4.4, ADR-0022): cada corredor ve solo lo suyo. Lo de otro corredor
// responde "no existe" con el mismo cuerpo que un id inexistente, y las listas no traen nada ajeno.

const ORIGIN = "http://localhost:5173";
const MINE = "token-de-mi-corredor";

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

const newListing = (brokerId: string, externalRef: string): NewListing => ({
  brokerId,
  externalRef,
  category: "real_estate",
  source: "xlsx",
  operation: "sale",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Calle Inventada 123",
  unitNumber: "41",
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF",
  highlights: null,
  internalNotes: "comisión 2%",
  attributes: { dormitorios: 3 },
  sourceHash: "hash",
});

/** Lo de un corredor: aviso, corrida y texto, cuenta, publicación y carga. */
async function ownedBy(deps: ReturnType<typeof testDeps>, slug: string) {
  const broker = await deps.brokers.create(brokerData(slug));
  const listing = await deps.listings.create(newListing(broker.id, `P-${slug}`));
  const run = await deps.contentRuns.create({ listingId: listing.id, texts: true });
  await deps.contentRuns.markRunning(run.id);
  await deps.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [
      {
        platform: "instagram",
        title: null,
        body: "Texto",
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "v1",
        rawOutput: null,
      },
    ],
  });
  const [content] = await deps.contents.listCurrent(listingSubject(listing.id));
  const account = await deps.platformAccounts.upsertConnected({
    brokerId: broker.id,
    platform: "instagram",
    externalAccountId: `ig-${slug}`,
    displayName: `@${slug}`,
    tokenExpiresAt: new Date("2026-12-01T00:00:00Z"),
    meta: {},
    credentials: { accessToken: `IGAA-${slug}` },
  });
  const publication = await deps.lock.run(listing.id, (repos) =>
    repos.publications.create(
      {
        listingId: listing.id,
        platformAccountId: account.id,
        platform: "instagram",
        format: "post",
        contentId: content?.id ?? "",
        mediaIds: [],
        listingSourceHash: "hash",
      },
      { actor: "system" },
    ),
  );
  const importRun = await deps.importRuns.create({
    id: randomUUID(),
    source: "xlsx",
    fileName: "x.xlsx",
    dryRun: false,
    input: { xlsxPath: "/tmp/x.xlsx", mediaDir: null, broker: slug },
    brokerId: broker.id,
  });
  // F9-T10: un post de su marca (las rutas `/posts/:id…`).
  const post = await deps.posts.create({
    brokerId: broker.id,
    topic: `Post ${slug}`,
    kind: "text",
  });
  // F9-T21: un plan de ideas de su marca (las rutas `/plans/:id`).
  const plan = await deps.planRuns.create({
    brokerId: broker.id,
    periodStart: new Date("2026-10-21T03:00:00Z"),
    periodEnd: new Date("2026-11-04T03:00:00Z"),
    request: { platforms: ["linkedin"], count: 2, days: 14, requestedBy: null },
  });
  return { broker, listing, run, content, account, publication, importRun, post, plan };
}

async function setup(
  options: { workerHeartbeats?: () => Promise<WorkerHeartbeat[]>; workerIdleExit?: boolean } = {},
) {
  const auth = testAuth();
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    healthDetails: {
      backupStatus: async () => ({
        lastSuccessAt: null,
        lastFile: null,
        lastFailureAt: null,
        lastFailureCode: null,
      }),
      ...(options.workerHeartbeats === undefined
        ? {}
        : { workerHeartbeats: options.workerHeartbeats }),
      ...(options.workerIdleExit === undefined ? {} : { workerIdleExit: options.workerIdleExit }),
    },
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await ownedBy(deps, "mio");
  const theirs = await ownedBy(deps, "ajeno");
  const user = auth.repos.seed.user({
    email: "corredor@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: mine.broker.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method !== undefined && init.method !== "GET"
            ? {
                origin: ORIGIN,
                ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
              }
            : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
  return { deps, mine, theirs, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

/** El id de cada recurso de una ruta, según su prefijo. */
function idFor(path: string, owned: Awaited<ReturnType<typeof ownedBy>>): string {
  if (path.startsWith("/listings")) return owned.listing.id;
  if (path.startsWith("/content-runs")) return owned.run.id;
  if (path.startsWith("/contents")) return owned.content?.id ?? "";
  if (path.startsWith("/publications")) return owned.publication.id;
  if (path.startsWith("/imports")) return owned.importRun.id;
  if (path.startsWith("/brokers")) return owned.broker.id;
  if (path.startsWith("/posts")) return owned.post.id;
  if (path.startsWith("/plans")) return owned.plan.id;
  return owned.account.id;
}

describe("lo de otro corredor no existe", () => {
  it("cada ruta con id de la sesión del corredor responde 404 con el cuerpo de un id inexistente", async () => {
    const s = await setup();
    const routes = Object.entries(ROUTE_ACCESS).filter(
      ([key, policy]) => policy === "session" && key.includes(":id"),
    );
    expect(routes.length).toBeGreaterThan(20);
    for (const [key] of routes) {
      const [method = "GET", pattern = ""] = key.split(" ");
      const foreignId = idFor(pattern, s.theirs);
      const missingId = randomUUID();
      const init = method === "GET" ? { method } : { method, body: "{}" };
      const foreign = await s.broker(pattern.replace(":id", foreignId), init);
      const missing = await s.broker(pattern.replace(":id", missingId), init);
      expect([key, foreign.status]).toEqual([key, 404]);
      const foreignBody = await errorOf(foreign);
      const missingBody = await errorOf(missing);
      expect([key, foreignBody.code]).toEqual([key, missingBody.code]);
      expect(foreignBody.message.replace(foreignId, "ID")).toBe(
        missingBody.message.replace(missingId, "ID"),
      );
    }
  });

  it("lo suyo sí lo ve, y el administrador ve todo", async () => {
    const s = await setup();
    expect((await s.broker(`/listings/${s.mine.listing.id}`)).status).toBe(200);
    expect((await s.broker(`/publications/${s.mine.publication.id}/events`)).status).toBe(200);
    expect((await s.broker(`/imports/${s.mine.importRun.id}`)).status).toBe(200);
    expect((await s.admin(`/listings/${s.theirs.listing.id}`)).status).toBe(200);
  });

  it("la música del reel de una propiedad ajena (F9.5-T19): 404 y no cambia; la suya sí", async () => {
    const s = await setup();
    const body = JSON.stringify({ musicTrackId: "calm-piano" });
    const foreign = await s.broker(`/listings/${s.theirs.listing.id}`, { method: "PATCH", body });
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("LISTING_NOT_FOUND");
    expect((await s.deps.listings.get(s.theirs.listing.id))?.musicTrackId).toBeNull();
    const own = await s.broker(`/listings/${s.mine.listing.id}`, { method: "PATCH", body });
    expect(own.status).toBe(200);
    expect((await s.deps.listings.get(s.mine.listing.id))?.musicTrackId).toBe("calm-piano");
  });
});

/** Un post de un corredor con su corrida, su texto y una publicación (F9, ADR-0029). */
async function postOf(
  deps: ReturnType<typeof testDeps>,
  owned: Awaited<ReturnType<typeof ownedBy>>,
) {
  const post = await deps.posts.create({
    brokerId: owned.broker.id,
    topic: "Un post",
    kind: "text",
  });
  const run = await deps.contentRuns.create({ postId: post.id, texts: true });
  await deps.contentRuns.markRunning(run.id);
  await deps.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [
      {
        platform: "instagram",
        title: null,
        body: "Texto del post",
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "v1",
        rawOutput: null,
      },
    ],
  });
  const [content] = await deps.contents.listCurrent(postSubject(post.id));
  const publication = await deps.postLock.run(post.id, (repos) =>
    repos.publications.create(
      {
        postId: post.id,
        platformAccountId: owned.account.id,
        platform: "instagram",
        format: "post",
        contentId: content?.id ?? "",
        mediaIds: [],
      },
      { actor: "system" },
    ),
  );
  return { post, run, publication };
}

describe("el dueño de un post es su corredor (F9-T04)", () => {
  it("la corrida y la publicación de un post ajeno no existen; las del suyo sí", async () => {
    const s = await setup();
    const mine = await postOf(s.deps, s.mine);
    const theirs = await postOf(s.deps, s.theirs);

    const foreignRun = await s.broker(`/content-runs/${theirs.run.id}`);
    expect(foreignRun.status).toBe(404);
    expect((await errorOf(foreignRun)).code).toBe("CONTENT_RUN_NOT_FOUND");
    const foreignEvents = await s.broker(`/publications/${theirs.publication.id}/events`);
    expect(foreignEvents.status).toBe(404);
    expect((await errorOf(foreignEvents)).code).toBe("PUBLICATION_NOT_FOUND");

    expect((await s.broker(`/content-runs/${mine.run.id}`)).status).toBe(200);
    expect((await s.broker(`/publications/${mine.publication.id}/events`)).status).toBe(200);
    expect((await s.admin(`/publications/${theirs.publication.id}/events`)).status).toBe(200);
  });

  it("/posts/:id/… de otro corredor no existe, también en una ruta que todavía no existe", async () => {
    const s = await setup();
    const mine = await postOf(s.deps, s.mine);
    const theirs = await postOf(s.deps, s.theirs);
    const foreign = await s.broker(`/posts/${theirs.post.id}/contents`);
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("POST_NOT_FOUND");
    // Lo suyo pasa el dueño y llega a la ruta (los textos de un post llegan en T11 y T12).
    const own = await s.broker(`/posts/${mine.post.id}/contents`);
    expect(own.status).toBe(404);
    expect((await errorOf(own)).code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("las listas sin nada ajeno", () => {
  it("propiedades, cargas, cuentas y corredores", async () => {
    const s = await setup();
    const listings = (await (await s.broker("/listings")).json()) as {
      listings: { id: string }[];
    };
    expect(listings.listings.map((l) => l.id)).toEqual([s.mine.listing.id]);
    const imports = (await (await s.broker("/imports")).json()) as { importRuns: { id: string }[] };
    expect(imports.importRuns.map((r) => r.id)).toEqual([s.mine.importRun.id]);
    const accounts = (await (await s.broker("/accounts")).json()) as { accounts: { id: string }[] };
    expect(accounts.accounts.map((a) => a.id)).toEqual([s.mine.account.id]);
    const brokers = (await (await s.broker("/brokers")).json()) as { brokers: { id: string }[] };
    expect(brokers.brokers.map((b) => b.id)).toEqual([s.mine.broker.id]);
  });

  it("?broker: el administrador filtra; un corredor que pide otro recibe 404", async () => {
    const s = await setup();
    const filtered = (await (await s.admin("/listings?broker=ajeno")).json()) as {
      listings: { id: string }[];
    };
    expect(filtered.listings.map((l) => l.id)).toEqual([s.theirs.listing.id]);
    for (const path of [
      "/listings?broker=ajeno",
      "/tracking?broker=ajeno",
      "/agenda?broker=ajeno",
      `/calendar?broker=ajeno&${nextWeek()}`,
    ]) {
      const response = await s.broker(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect((await errorOf(response)).code).toBe("BROKER_NOT_FOUND");
    }
    expect((await s.broker("/listings?broker=mio")).status).toBe(200);
  });

  it("la lista de propiedades no trae notas internas, dirección, unidad ni atributos; el detalle sí", async () => {
    const s = await setup();
    const { listings } = (await (await s.broker("/listings")).json()) as {
      listings: Record<string, unknown>[];
    };
    for (const field of ["internalNotes", "address", "unitNumber", "attributes"]) {
      expect(listings[0]).not.toHaveProperty(field);
    }
    const detail = (await (await s.broker(`/listings/${s.mine.listing.id}`)).json()) as {
      listing: Record<string, unknown>;
    };
    expect(detail.listing).toMatchObject({
      internalNotes: "comisión 2%",
      address: "Calle Inventada 123",
    });
  });

  it("Seguimiento y agenda solo con lo suyo, y sin el respaldo para el corredor", async () => {
    const s = await setup();
    const tracking = (await (await s.broker("/tracking")).json()) as {
      rows: { listing: { id: string } }[];
    };
    expect(tracking.rows.map((row) => row.listing.id)).toEqual([s.mine.listing.id]);
    const agenda = (await (await s.broker("/agenda")).json()) as {
      items: { kind: string; listingId: string | null }[];
    };
    expect(agenda.items.some((item) => item.kind === "backup")).toBe(false);
    expect(agenda.items.every((item) => item.listingId === s.mine.listing.id)).toBe(true);
    const adminAgenda = (await (await s.admin("/agenda")).json()) as { items: { kind: string }[] };
    expect(adminAgenda.items.some((item) => item.kind === "backup")).toBe(true);
  });

  it("el worker apagado con algo por vencer: lo ve el administrador, no el corredor (F9.5-T24)", async () => {
    // Apagado en orden hace una hora.
    const s = await setup({
      workerHeartbeats: async () => [
        {
          processId: "worker-1",
          startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          beatAt: new Date(Date.now() - 60 * 60 * 1000),
          stoppedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    });
    // Venció hace 5 min: sale en cuanto se encienda el worker.
    const due = await scheduledPostPublication(s.deps, s.mine, new Date(Date.now() - 5 * 60_000));

    type AgendaBody = { items: { kind: string; action: string; publicationId: string | null }[] };
    const admin = (await (await s.admin("/agenda")).json()) as AgendaBody;
    expect(admin.items.filter((item) => item.kind === "worker_off")).toEqual([
      expect.objectContaining({ action: "start_worker", publicationId: due.id }),
    ]);
    const broker = (await (await s.broker("/agenda")).json()) as AgendaBody;
    expect(broker.items.some((item) => item.kind === "worker_off")).toBe(false);
  });

  it("con el horario activado, lo que espera al worker sale en la próxima revisión (F9.5-T24)", async () => {
    const s = await setup({
      workerHeartbeats: async () => [],
      workerIdleExit: true,
    });
    const due = await scheduledPostPublication(s.deps, s.mine, new Date(Date.now() - 5 * 60_000));

    const admin = (await (await s.admin("/agenda")).json()) as {
      items: { kind: string; action: string; publicationId: string | null }[];
    };
    expect(admin.items.filter((item) => item.kind === "worker_off")).toEqual([
      expect.objectContaining({ action: "wait_worker", publicationId: due.id }),
    ]);
  });

  it("los posts y las cuentas de otro corredor no aparecen en su agenda ni en su seguimiento (F9-T08)", async () => {
    const s = await setup();
    const mine = await scheduledPostPublication(s.deps, s.mine);
    const theirs = await scheduledPostPublication(s.deps, s.theirs);
    const myAccount = await linkedinExpiringSoon(s.deps, s.mine.broker.id, "mio");
    await linkedinExpiringSoon(s.deps, s.theirs.broker.id, "ajeno");

    type AgendaBody = {
      items: { kind: string; postId: string | null; accountId: string | null; title: string }[];
    };
    const agenda = (await (await s.broker("/agenda")).json()) as AgendaBody;
    expect(
      agenda.items.filter((item) => item.postId !== null).map((item) => [item.kind, item.postId]),
    ).toEqual([["upcoming", s.mine.post.id]]);
    expect(agenda.items.find((item) => item.postId !== null)?.title).toBe("Post mio");
    expect(
      agenda.items.filter((item) => item.kind === "token_expiring").map((item) => item.accountId),
    ).toEqual([myAccount.id]);

    const tracking = (await (await s.broker("/tracking")).json()) as {
      posts: { post: { id: string }; cells: { instagram: { id: string }[] } }[];
    };
    expect(tracking.posts.map((row) => row.post.id)).toEqual([s.mine.post.id]);
    expect(tracking.posts[0]?.cells.instagram.map((cell) => cell.id)).toEqual([mine.id]);

    // El administrador ve los dos, y con ?broker solo los de ese corredor.
    const admin = (await (await s.admin("/agenda")).json()) as AgendaBody;
    expect(admin.items.filter((item) => item.postId !== null).map((item) => item.postId)).toEqual(
      expect.arrayContaining([s.mine.post.id, s.theirs.post.id]),
    );
    const filtered = (await (await s.admin("/tracking?broker=ajeno")).json()) as {
      posts: { post: { id: string }; cells: { instagram: { id: string }[] } }[];
    };
    expect(filtered.posts.map((row) => row.post.id)).toEqual([s.theirs.post.id]);
    expect(filtered.posts[0]?.cells.instagram.map((cell) => cell.id)).toEqual([theirs.id]);
  });
});

/** El rango de los próximos 7 días, para `GET /calendar` (F9-T18). */
function nextWeek(): string {
  const from = new Date(Date.now() - 60 * 60 * 1000);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

describe("el calendario solo con lo suyo (F9-T18)", () => {
  it("un corredor ve sus posts y avisos programados, no los de otro; el administrador, los dos", async () => {
    const s = await setup();
    const mine = await scheduledPostPublication(s.deps, s.mine);
    const theirs = await scheduledPostPublication(s.deps, s.theirs);
    const scheduleListing = (owned: Awaited<ReturnType<typeof ownedBy>>) =>
      s.deps.lock.run(owned.listing.id, (repos) =>
        repos.publications.transition(
          owned.publication.id,
          {
            from: "approved",
            to: "scheduled",
            changes: { dryRun: true, scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
          },
          { actor: "system" },
        ),
      );
    await scheduleListing(s.mine);
    await scheduleListing(s.theirs);

    type CalendarBody = {
      entries: { publicationId: string; title: string; brokerSlug: string | null }[];
    };
    const ids = async (response: Response) =>
      ((await response.json()) as CalendarBody).entries.map((entry) => entry.publicationId);

    const own = await s.broker(`/calendar?${nextWeek()}`);
    expect(own.status).toBe(200);
    expect(await ids(own)).toEqual([mine.id, s.mine.publication.id]);
    expect(await ids(await s.admin(`/calendar?${nextWeek()}`))).toEqual(
      expect.arrayContaining([mine.id, theirs.id, s.mine.publication.id, s.theirs.publication.id]),
    );
    expect(await ids(await s.admin(`/calendar?broker=ajeno&${nextWeek()}`))).toEqual([
      theirs.id,
      s.theirs.publication.id,
    ]);
    // Mover la fecha de lo ajeno: no existe (el mismo 404 de siempre, `ownedBy`).
    const move = await s.broker(`/publications/${theirs.id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }),
    });
    expect([move.status, (await errorOf(move)).code]).toEqual([404, "PUBLICATION_NOT_FOUND"]);
  });
});

/** Una publicación de Instagram del post del corredor, programada en una hora (F9-T08). */
async function scheduledPostPublication(
  deps: Awaited<ReturnType<typeof setup>>["deps"],
  owned: Awaited<ReturnType<typeof ownedBy>>,
  scheduledAt = new Date(Date.now() + 60 * 60 * 1000),
) {
  const run = await deps.contentRuns.create({ postId: owned.post.id, texts: true });
  await deps.contentRuns.markRunning(run.id);
  await deps.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [
      {
        platform: "instagram",
        title: null,
        body: "Texto del post",
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "v1",
        rawOutput: null,
      },
    ],
  });
  const [content] = await deps.contents.listCurrent(postSubject(owned.post.id));
  return deps.postLock.run(owned.post.id, async (repos) => {
    const created = await repos.publications.create(
      {
        postId: owned.post.id,
        platformAccountId: owned.account.id,
        platform: "instagram",
        format: "post",
        contentId: content?.id ?? "",
        mediaIds: [],
      },
      { actor: "system" },
    );
    return repos.publications.transition(
      created.id,
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt },
      },
      { actor: "system" },
    );
  });
}

/** Una cuenta de LinkedIn cuyo token vence en 3 días (no se renueva sola). */
function linkedinExpiringSoon(
  deps: Awaited<ReturnType<typeof setup>>["deps"],
  brokerId: string,
  slug: string,
) {
  return deps.platformAccounts.upsertConnected({
    brokerId,
    platform: "linkedin",
    externalAccountId: `li-${slug}`,
    displayName: `LinkedIn ${slug}`,
    tokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    meta: { mode: "manual" },
    credentials: { accessToken: `li-token-${slug}` },
  });
}

describe("programar y cargar", () => {
  it("programar con una propiedad ajena no programa ninguna", async () => {
    const s = await setup();
    const response = await s.broker("/schedule", {
      method: "POST",
      body: JSON.stringify({
        listingIds: [s.mine.listing.id, s.theirs.listing.id],
        at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("LISTING_NOT_FOUND");
    const publication = await s.deps.publications.get(s.mine.publication.id);
    expect(publication?.status).toBe("approved");
  });

  it("la carga del corredor nace con su corredor; con otro corredor en el pedido, 404", async () => {
    const s = await setup();
    const upload = (broker?: string) =>
      s.broker("/imports/uploads", {
        method: "POST",
        body: JSON.stringify({
          ...(broker === undefined ? {} : { broker }),
          xlsx: { name: "propiedades.xlsx", size: 8, sha256: "a".repeat(64) },
        }),
      });
    const created = await upload();
    expect(created.status).toBe(201);
    const { importRun } = (await created.json()) as { importRun: { id: string } };
    expect(await s.deps.importRuns.get(importRun.id)).toMatchObject({
      brokerId: s.mine.broker.id,
      status: "awaiting_upload",
      input: { broker: "mio" },
    });
    // La ve mientras sube, antes de que el job lea la hoja.
    expect((await s.broker(`/imports/${importRun.id}`)).status).toBe(200);
    const foreign = await upload("ajeno");
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("BROKER_NOT_FOUND");
  });
});

describe("quién hizo qué (F7-T10)", () => {
  it("un evento desde el panel y otro desde la CLI guardan a la persona y su canal", async () => {
    const s = await setup();
    const reel = await s.deps.lock.run(s.mine.listing.id, (repos) =>
      repos.publications.create(
        {
          listingId: s.mine.listing.id,
          platformAccountId: s.mine.account.id,
          platform: "instagram",
          format: "reel",
          contentId: s.mine.content?.id ?? "",
          mediaIds: [],
          listingSourceHash: "hash",
        },
        { actor: "system" },
      ),
    );
    // El panel (`TEST_ADMIN_TOKEN`, sesión `panel`) y la CLI (sesión `cli`) del mismo administrador.
    const cancel = (id: string, token: string) =>
      s.admin(`/publications/${id}/cancel`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await cancel(s.mine.publication.id, TEST_ADMIN_TOKEN)).status).toBe(200);
    expect((await cancel(reel.id, TEST_ADMIN_CLI_TOKEN)).status).toBe(200);

    const eventsOf = async (id: string) =>
      (
        (await (await s.broker(`/publications/${id}/events`)).json()) as {
          events: { actor: string; userName: string | null; toStatus: string | null }[];
        }
      ).events;
    const [born, cancelled] = await eventsOf(s.mine.publication.id);
    expect(born).toMatchObject({ actor: "system", userName: null });
    expect(cancelled).toMatchObject({
      actor: "operator",
      userName: "Admin de prueba",
      toStatus: "cancelled",
    });
    expect((await eventsOf(reel.id)).at(-1)).toMatchObject({
      actor: "cli",
      userName: "Admin de prueba",
    });
  });
});

describe("el guardia de dueño", () => {
  it("un id que no es uuid da 404 a un corredor, y una sola lectura por pedido", async () => {
    const s = await setup();
    const response = await s.broker("/listings/no-es-un-id");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("LISTING_NOT_FOUND");

    let reads = 0;
    const get = s.deps.listings.get.bind(s.deps.listings);
    s.deps.listings.get = async (id) => {
      reads++;
      return get(id);
    };
    await s.broker(`/listings/${s.mine.listing.id}`);
    // El guardia lee una vez y la ruta, otra.
    expect(reads).toBe(2);
  });

  it("después de los pedidos ajenos, nada de lo ajeno cambió", async () => {
    const s = await setup();
    for (const [key, policy] of Object.entries(ROUTE_ACCESS)) {
      const [method = "GET", pattern = ""] = key.split(" ");
      if (policy !== "session" || method === "GET" || !pattern.includes(":id")) continue;
      await s.broker(pattern.replace(":id", idFor(pattern, s.theirs)), { method, body: "{}" });
    }
    expect((await s.deps.publications.get(s.theirs.publication.id))?.status).toBe("approved");
    expect((await s.deps.listings.get(s.theirs.listing.id))?.status).toBe(s.theirs.listing.status);
    expect((await s.deps.contents.get(s.theirs.content?.id ?? ""))?.status).toBe("draft");
    expect(await s.deps.contentRuns.findActive(listingSubject(s.theirs.listing.id))).toBeNull();
    expect(await s.deps.posts.get(s.theirs.post.id)).toMatchObject({
      status: "draft",
      topic: "Post ajeno",
    });
  });
});

describe("GET /accounts?broker= (F7-T17, el selector del panel)", () => {
  it("el administrador filtra por corredor; uno ajeno o que no existe es 404; vacío, 400", async () => {
    const s = await setup();
    const accountsOf = async (response: Response) =>
      ((await response.json()) as { accounts: { brokerId: string }[] }).accounts.map(
        (account) => account.brokerId,
      );

    const filtered = await s.admin("/accounts?broker=mio");
    expect(filtered.status).toBe(200);
    expect(await accountsOf(filtered)).toEqual([s.mine.broker.id]);
    expect(new Set(await accountsOf(await s.admin("/accounts")))).toEqual(
      new Set([s.mine.broker.id, s.theirs.broker.id]),
    );

    for (const [path, status] of [
      ["/accounts?broker=ajeno", 404],
      ["/accounts?broker=no-existe", 404],
      ["/accounts?broker=", 400],
    ] as const) {
      expect((await s.broker(path)).status).toBe(path.endsWith("no-existe") ? 404 : status);
    }
    expect(await accountsOf(await s.broker("/accounts?broker=mio"))).toEqual([s.mine.broker.id]);
  });
});
