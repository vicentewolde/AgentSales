import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { PlatformContext, PublishedRef, Publisher, RemoteStatus } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import { structuredCopy } from "../testing/copy.js";
import { createPublicationScenario } from "../testing/index.js";
import { pausePublication } from "./pause-publication.js";
import type { PublicationOperation } from "./publication-operations.js";
import { requestPublicationSync } from "./publication-operations.js";
import { publishListing } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";
import { resolvePublication } from "./resolve-publication.js";
import { syncPublication } from "./sync-publication.js";

// F9.5-T04a: el resultado dudoso de Instagram (`IG_PUBLISH_OUTCOME_UNKNOWN`) y Portal
// (`ML_PUBLISH_OUTCOME_UNKNOWN`) en un aviso: el intento lo deja en `outcome_unknown` sin
// reintento, y «salió» en Portal guarda el id del ítem (`MLC…`) para que el sync y las
// operaciones lo encuentren. Los cortes con el publisher real y la red simulada (msw) están en
// `packages/publishers` (instagram/post.test.ts y mercadolibre/publisher.test.ts).

// La hora real: el token del escenario de Portal vence una hora después de crearlo.
const NOW = new Date();
const PORTAL = "portal_inmobiliario";
const ITEM_ID = "MLC1234567890";
const PORTAL_LINK = `https://www.portalinmobiliario.com/MLC-1234567890-depto-en-nunoa-_JM?utm=x#f`;
const SELLER_CONTACT = {
  contact: "Corredora",
  email: "c@corredor.test",
  countryCode2: "56",
  phone2: "911112222",
};
/** Lo que deja el publisher de Portal antes de un `POST /items` sin respuesta. */
const CREATE_REQUESTED = {
  pictureIds: ["1-MLC_PIC", "2-MLC_PIC"],
  sellerContact: SELLER_CONTACT,
  createRequestedAt: NOW.toISOString(),
};

/** Un publisher guionado que guarda un progreso y lanza el resultado dudoso de su red. */
function doubtfulPublisher(platform: "instagram" | "portal_inmobiliario") {
  const calls: unknown[] = [];
  const publisher: Publisher = {
    platform,
    formats: platform === PORTAL ? ["post"] : ["post", "reel"],
    validate: () => ({ ok: true }),
    async publish(_input, ctx) {
      calls.push(ctx.progress);
      if (platform === PORTAL) {
        await ctx.saveProgress(CREATE_REQUESTED);
        throw new AppError("ML_PUBLISH_OUTCOME_UNKNOWN", "No se sabe si el aviso se creó", {
          details: { found: "none" },
        });
      }
      throw new AppError("IG_PUBLISH_OUTCOME_UNKNOWN", "No se sabe si salió en Instagram");
    },
  };
  return { publisher, calls };
}

/** Las operaciones de Portal guionadas: registran lo que reciben. */
function fakeOperations() {
  const calls: Array<{ operation: string; ref: PublishedRef }> = [];
  const make =
    (operation: PublicationOperation | "getStatus", status: string) =>
    async (ref: PublishedRef, _ctx: PlatformContext): Promise<RemoteStatus> => {
      calls.push({ operation, ref: structuredCopy(ref) });
      return {
        status,
        subStatus: [],
        stopTime: "2027-04-07T12:00:00.000-03:00",
        expirationTime: null,
      };
    };
  return {
    calls,
    operations: {
      pause: make("pause", "paused"),
      resume: make("resume", "active"),
      close: make("close", "closed"),
      getStatus: make("getStatus", "active"),
    },
  };
}

/** Un aviso con su publicación en vivo que terminó en resultado dudoso. */
async function doubtful(platform: "instagram" | "portal_inmobiliario") {
  const t = await createPublicationScenario({ platform });
  const { started } = await publishListing(t.deps, {
    listingId: t.listingId,
    platform,
    dryRun: false,
    actor: "operator",
  });
  const publication = started[0];
  if (publication === undefined) throw new Error("falta la publicación");
  const { publisher, calls } = doubtfulPublisher(platform);
  const publishDeps = {
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    contents: t.contents,
    media: t.media,
    listings: t.listings,
    brokers: t.brokers,
    storage: t.storage,
    publishers: { [platform]: publisher },
    workerMode: "live" as const,
    marketplaceAutomation: true,
    mercadoLibre: null,
    now: () => NOW,
  };
  const attempt = () =>
    publishPublication(publishDeps, { publicationId: publication.id, isLastAttempt: false });
  const current = () => t.publications.all().find((p) => p.id === publication.id) as Publication;
  const fake = fakeOperations();
  const platformDeps = {
    ...t.deps,
    platformAccounts: t.platformAccounts,
    mercadoLibre: null,
    operationsFor: (wanted: string) => (wanted === PORTAL ? fake.operations : undefined),
    apiMode: "live" as const,
    now: () => NOW,
  };
  return { t, id: publication.id, attempt, current, calls, platformDeps, operated: fake.calls };
}

describe("resultado dudoso de un aviso (F9.5-T04a)", () => {
  it.each([
    ["instagram", "IG_PUBLISH_OUTCOME_UNKNOWN"],
    ["portal_inmobiliario", "ML_PUBLISH_OUTCOME_UNKNOWN"],
  ] as const)(
    "%s: el intento lo deja en outcome_unknown, sin reintento ni fallo",
    async (platform, code) => {
      const { t, id, attempt, current, calls } = await doubtful(platform);

      // No lanza: la cola no lo reintenta.
      await expect(attempt()).resolves.toMatchObject({
        outcome: "outcome_unknown",
        publication: { status: "outcome_unknown", lastError: { code, retriable: false } },
      });
      expect(current().status).toBe("outcome_unknown");
      expect(calls).toHaveLength(1);
      const events = await t.publications.listEvents(id);
      expect(
        events.filter((event) => event.type === "publish_attempt").at(-1)?.payload,
      ).toMatchObject({ result: "outcome_unknown", error: { code } });
      // El aviso no sube a `active`: no se sabe si salió.
      expect((await t.listings.get(t.listingId))?.status).toBe("ready");
    },
  );

  it("Instagram: «salió» en vivo sin enlace se acepta (el id queda vacío) y el aviso pasa a active", async () => {
    const { t, id, attempt } = await doubtful("instagram");
    await attempt();

    const { publication } = await resolvePublication(t.deps, {
      publicationId: id,
      outcome: "published",
      actor: "operator",
    });

    expect(publication).toMatchObject({ status: "published", externalId: null, externalUrl: null });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("Portal en vivo: «salió» sin enlace ni id se rechaza (PUBLISHED_URL_REQUIRED) sin cambiar nada", async () => {
    const { t, id, attempt, current } = await doubtful(PORTAL);
    await attempt();

    await expect(
      resolvePublication(t.deps, { publicationId: id, outcome: "published", actor: "operator" }),
    ).rejects.toMatchObject({
      code: "PUBLISHED_URL_REQUIRED",
      retriable: false,
      message: expect.stringContaining("MLC"),
    });
    expect(current().status).toBe("outcome_unknown");
    // Un enlace que no es de Portal tampoco sirve.
    await expect(
      resolvePublication(t.deps, {
        publicationId: id,
        outcome: "published",
        url: "https://www.instagram.com/p/abc/",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "PUBLISHED_URL_INVALID" });
    expect(current().status).toBe("outcome_unknown");
  });

  it("Portal: «salió» con el enlace guarda el MLC… (y en el progreso), y el sync lo lee", async () => {
    const { t, id, attempt, current, platformDeps, operated } = await doubtful(PORTAL);
    await attempt();

    const { publication, changed } = await resolvePublication(t.deps, {
      publicationId: id,
      outcome: "published",
      url: PORTAL_LINK,
      actor: "operator",
    });

    expect(changed).toBe(true);
    expect(publication).toMatchObject({
      status: "published",
      externalId: ITEM_ID,
      externalUrl: "https://www.portalinmobiliario.com/MLC-1234567890-depto-en-nunoa-_JM",
      progress: { ...CREATE_REQUESTED, itemId: ITEM_ID },
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");

    // Lo que pide la ruta de la API: el sync queda en la cola y lee el ítem por su id.
    await expect(requestPublicationSync(t, { publicationId: id })).resolves.toEqual({
      queued: true,
    });
    expect(t.queue.jobs).toContainEqual(
      expect.objectContaining({ name: "publication.sync", data: { publicationId: id } }),
    );
    await expect(syncPublication(platformDeps, { publicationId: id })).resolves.toMatchObject({
      outcome: "synced",
    });
    expect(operated.at(-1)).toMatchObject({
      operation: "getStatus",
      ref: { externalId: ITEM_ID },
    });
    expect(current().remoteState).toMatchObject({ status: "active" });

    // Pausar manda el mismo ítem, con un progreso cuyo `itemId` es ese (las operaciones reales lo
    // exigen para reutilizar el contacto guardado).
    await pausePublication(platformDeps, { publicationId: id, actor: "operator" });
    expect(operated.at(-1)).toMatchObject({
      operation: "pause",
      ref: { externalId: ITEM_ID, progress: { itemId: ITEM_ID, sellerContact: SELLER_CONTACT } },
    });
  });

  it("Portal: solo el id (MLC-…) también sirve, sin enlace; repetirlo no cambia nada y otro id es PUBLICATION_ALREADY_CONFIRMED", async () => {
    const { t, id, attempt } = await doubtful(PORTAL);
    await attempt();

    await expect(
      resolvePublication(t.deps, {
        publicationId: id,
        outcome: "published",
        url: "MLC-1234567890",
        actor: "operator",
      }),
    ).resolves.toMatchObject({
      changed: true,
      publication: { externalId: ITEM_ID, externalUrl: null },
    });
    await expect(
      resolvePublication(t.deps, {
        publicationId: id,
        outcome: "published",
        url: PORTAL_LINK,
        actor: "operator",
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      resolvePublication(t.deps, {
        publicationId: id,
        outcome: "published",
        url: "MLC999",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_ALREADY_CONFIRMED" });
  });

  it("Portal: «no salió» la deja fallida sin el progreso (reintentar crea desde cero)", async () => {
    const { t, id, attempt } = await doubtful(PORTAL);
    await attempt();

    await expect(
      resolvePublication(t.deps, {
        publicationId: id,
        outcome: "not_published",
        actor: "operator",
      }),
    ).resolves.toMatchObject({
      publication: {
        status: "failed",
        progress: null,
        lastError: { code: "OUTCOME_RESOLVED_NOT_PUBLISHED" },
      },
    });
  });

  it("Portal en simulación: «salió» sin enlace se acepta (dry-run:<id>), como en las demás redes", async () => {
    const t = await createPublicationScenario({ platform: PORTAL });
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: PORTAL,
      dryRun: true,
      actor: "operator",
    });
    const id = started[0]?.id ?? "";
    await t.publications.transition(
      id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: {
          lastError: { code: "ML_PUBLISH_OUTCOME_UNKNOWN", message: "x", retriable: false },
        },
      },
      { actor: "system" },
    );

    await expect(
      resolvePublication(t.deps, { publicationId: id, outcome: "published", actor: "operator" }),
    ).resolves.toMatchObject({ publication: { externalId: `dry-run:${id}`, externalUrl: null } });
  });
});
