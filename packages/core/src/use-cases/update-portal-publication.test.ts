import { describe, expect, it } from "vitest";
import type { PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { ListingImportData } from "../ports/listing-repository.js";
import type { PublishedUpdate, PublishedUpdateResult } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import { createPublicationScenario, type PublicationScenario } from "../testing/index.js";
import { approveContent } from "./approve-content.js";
import { publishListing } from "./publish-listing.js";
import { updatePortalPublication } from "./update-portal-publication.js";

// F6-T07 (spec F6 §4.7, ADR-0020): actualizar un aviso de Portal publicado.

// La hora real: el token del escenario vence una hora después de crearlo.
const NOW = new Date();
const PORTAL = "portal_inmobiliario";
const ITEM_ID = "MLC1234567890";
const CONTACT = { contact: "Corredora", email: null, countryCode2: "56", phone2: "911112222" };
const PROGRESS = {
  pictureIds: ["1-MLC_PIC"],
  sellerContact: CONTACT,
  createRequestedAt: NOW.toISOString(),
  itemId: ITEM_ID,
  descriptionDone: true,
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : "otro";
  }
  return null;
};

/** Una publicación de Portal publicada (en vivo con su progreso, o simulada). */
async function setup(options: { dryRun?: boolean; apiMode?: PublishMode } = {}) {
  const t = await createPublicationScenario({ platform: PORTAL });
  const dryRun = options.dryRun ?? false;
  const [started] = (
    await publishListing(t.deps, {
      listingId: t.listingId,
      platform: PORTAL,
      dryRun,
      actor: "operator",
    })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  if (!dryRun) await t.publications.saveProgress(started.id, PROGRESS);
  await t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: { externalId: dryRun ? `dry-run:${started.id}` : ITEM_ID, publishedAt: NOW },
    },
    { actor: "system" },
  );
  const updates: PublishedUpdate[] = [];
  let fail: AppError | undefined;
  const update = async (_ref: unknown, _ctx: unknown, request: PublishedUpdate) => {
    updates.push(request);
    if (fail !== undefined) throw fail;
    const result: PublishedUpdateResult = {
      remote: { status: "active", subStatus: [], stopTime: null, expirationTime: null },
      progress: { ...PROGRESS, sellerContact: { ...CONTACT, phone2: "933334444" } },
      fields: [
        ...(request.text ? ["title", "description"] : []),
        ...(request.listing ? ["price", "attributes"] : []),
      ],
    };
    return result;
  };
  const deps = {
    ...t.deps,
    publications: t.publications,
    contents: t.contents,
    listings: t.listings,
    brokers: t.brokers,
    platformAccounts: t.platformAccounts,
    mercadoLibre: null,
    operationsFor: (platform: string) => (platform === PORTAL ? { update } : undefined),
    apiMode: options.apiMode ?? "live",
    queue: t.queue,
    now: () => NOW,
  };
  const current = () => t.publications.all().find((p) => p.id === started.id) as Publication;
  return {
    t,
    deps,
    id: started.id,
    updates,
    current,
    failWith: (error: AppError) => {
      fail = error;
    },
  };
}

/** Un texto de Portal nuevo, aprobado (una corrida de textos después de publicar). */
async function newApprovedText(t: PublicationScenario) {
  await t.prepare();
  await approveContent(t.approveDeps, { contentId: await t.portalId(), actor: "operator" });
  return t.portalId();
}

/** La propiedad cambia (otra versión, otro precio): una carga nueva de la planilla. */
async function changeListing(t: PublicationScenario) {
  const listing = await t.listings.get(t.listingId);
  if (listing === null) throw new Error("falta el aviso");
  await t.listings.update(t.listingId, {
    ...listing,
    priceAmount: listing.priceAmount + 100,
    sourceHash: "h-nueva",
  } as unknown as ListingImportData);
}

describe("updatePortalPublication", () => {
  it("en vivo, con el texto nuevo aprobado: actualiza, re-fija el texto, la versión y el contacto con manual_edit, y pide un sync", async () => {
    const { t, deps, id, updates, current } = await setup();
    const contentId = await newApprovedText(t);

    const updated = await updatePortalPublication(deps, {
      publicationId: id,
      actor: "operator",
      confirmed: true,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      text: true,
      listing: false,
      input: { title: expect.any(String), media: [] },
    });
    expect(updated).toMatchObject({
      status: "published",
      contentId,
      progress: { sellerContact: { phone2: "933334444" } },
      remoteState: { status: "active" },
    });
    expect((await t.publications.listEvents(id)).at(-1)).toMatchObject({
      type: "manual_edit",
      actor: "operator",
      payload: { mode: "live", fields: ["title", "description"], remote: { status: "active" } },
    });
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);
    expect(current().contentId).toBe(contentId);
  });

  it("con la propiedad cambiada manda precio y atributos y fija la versión nueva", async () => {
    const { t, deps, id, updates, current } = await setup();
    await changeListing(t);

    await updatePortalPublication(deps, { publicationId: id, actor: "cli", confirmed: true });

    expect(updates[0]).toMatchObject({ text: false, listing: true });
    expect(current().listingSourceHash).toBe("h-nueva");
  });

  it("nada que actualizar: PORTAL_NOTHING_TO_UPDATE, sin llamar", async () => {
    const { deps, id, updates } = await setup();
    expect(
      await codeOf(
        updatePortalPublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
      ),
    ).toBe("PORTAL_NOTHING_TO_UPDATE");
    expect(updates).toEqual([]);
  });

  it("en vivo pide la confirmación y la API en vivo", async () => {
    const { t, deps, id, updates } = await setup();
    await changeListing(t);

    expect(
      await codeOf(updatePortalPublication(deps, { publicationId: id, actor: "operator" })),
    ).toBe("UPDATE_NOT_CONFIRMED");
    expect(
      await codeOf(
        updatePortalPublication(
          { ...deps, apiMode: "dry-run" },
          { publicationId: id, actor: "operator", confirmed: true },
        ),
      ),
    ).toBe("PUBLISH_MODE_MISMATCH");
    expect(updates).toEqual([]);
  });

  it("en simulación re-fija sin llamar a la plataforma", async () => {
    const { t, deps, id, updates, current } = await setup({ dryRun: true, apiMode: "dry-run" });
    await changeListing(t);

    await updatePortalPublication(deps, { publicationId: id, actor: "operator" });

    expect(updates).toEqual([]);
    expect(current()).toMatchObject({ listingSourceHash: "h-nueva", progress: null });
    expect((await t.publications.listEvents(id)).at(-1)).toMatchObject({
      type: "manual_edit",
      payload: { mode: "dry-run", fields: ["price", "attributes"] },
    });
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toEqual([]);
  });

  it("si cambió el tipo o la operación respecto de lo enviado: PORTAL_UPDATE_NEEDS_RELIST", async () => {
    const { t, deps, id, updates } = await setup();
    await changeListing(t);
    const listing = await t.listings.get(t.listingId);
    await t.publications.addEvent(id, {
      type: "publish_attempt",
      actor: "system",
      payload: {
        mode: "live",
        attempt: 1,
        retry: 0,
        result: "published",
        sent: {
          platform: PORTAL,
          format: "post",
          title: "t",
          caption: "c",
          media: [],
          account: { id: "a", displayName: "X" },
          listing: {
            id: t.listingId,
            externalRef: "P1",
            operation: "rent",
            propertyType: "Casa",
            region: listing?.region ?? null,
            comuna: listing?.comuna ?? null,
            address: null,
            unitNumber: null,
            showExactAddress: false,
            priceAmount: 1,
            priceCurrency: "CLP",
            attributes: {},
          },
        },
      },
    });

    expect(
      await codeOf(
        updatePortalPublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
      ),
    ).toBe("PORTAL_UPDATE_NEEDS_RELIST");
    expect(updates).toEqual([]);
  });

  it("una respuesta perdida pide un sync y no re-fija nada", async () => {
    const { t, deps, id, current, failWith } = await setup();
    await changeListing(t);
    failWith(new AppError("ML_UNAVAILABLE", "sin red", { retriable: true }));

    expect(
      await codeOf(
        updatePortalPublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
      ),
    ).toBe("ML_UNAVAILABLE");
    expect(current().listingSourceHash).toBe("h");
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);
  });

  it("solo Portal publicado o pausado", async () => {
    const { t, deps, id } = await setup();
    await t.publications.transition(
      id,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );
    expect(
      await codeOf(
        updatePortalPublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("si la publicación cambió mientras se actualizaba: PUBLICATION_STALE, pide un sync y no re-fija", async () => {
    const { t, deps, id, current } = await setup();
    await changeListing(t);
    const touching = {
      ...deps,
      operationsFor: (platform: string) => {
        const ops = deps.operationsFor(platform);
        if (ops === undefined) return undefined;
        return {
          update: async (...args: Parameters<typeof ops.update>) => {
            const result = await ops.update(...args);
            // Un sync guardó el estado remoto entre la llamada y el candado.
            await t.publications.setRemoteState(id, null);
            return result;
          },
        };
      },
    };

    expect(
      await codeOf(
        updatePortalPublication(touching, {
          publicationId: id,
          actor: "operator",
          confirmed: true,
        }),
      ),
    ).toBe("PUBLICATION_STALE");
    expect(current().listingSourceHash).toBe("h");
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);
  });
});
