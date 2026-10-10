import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import type { AppError } from "../errors.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { NewListing } from "../ports/listing-repository.js";
import type { Publication } from "../publication.js";
import { approveContent } from "../use-cases/approve-content.js";
import { prepareContent } from "../use-cases/prepare-content.js";
import { createInMemoryContentRepositories } from "./content.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "./content-fixtures.js";
import { fakeHash } from "./fake-hash.js";
import { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryListingRepository,
} from "./import-repositories.js";
import { createInMemoryJobQueue } from "./job-queue.js";
import { createInMemoryLlmProvider } from "./llm.js";
import { createInMemoryMediaRepository, createInMemoryMediaStorage } from "./media.js";
import { createInMemoryMediaProcessor } from "./media-processor.js";
import { createInMemoryPlatformAccountRepository } from "./platform-accounts.js";
import { createInMemoryListingLock, createInMemoryPublicationRepository } from "./publications.js";
import { createInMemoryHtmlRenderer, createInMemorySlideTemplates } from "./slides.js";

/** El token de la cuenta del escenario: los tests revisan que no aparezca en logs ni bitácora. */
export const PUBLICATION_SCENARIO_TOKEN = "IGAA-prueba";
/** Los tokens de la cuenta de Mercado Libre del escenario de Portal (inventados). */
export const PORTAL_SCENARIO_TOKENS = {
  accessToken: "APP_USR-prueba-portal",
  refreshToken: "TG-prueba-portal",
} as const;

// Escenario de publicación para los tests de core (F3-T10 y T11): un aviso preparado con los
// dobles, la cuenta de Instagram conectada y el texto aprobado, con un candado y una cola que
// fallan si se usan donde no corresponde.

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/**
 * Un aviso `ready` con 2 fotos y un video, preparado con el proveedor falso. Por defecto con la
 * cuenta de Instagram conectada y el texto aprobado (nacen carrusel y reel en `approved`). Con
 * `platform: "portal_inmobiliario"`, la cuenta y el texto son de Portal (nace un `post` con las
 * fotos 4:3), con el `access_token` vigente por una hora.
 */
export async function createPublicationScenario(
  options: {
    platform?: "instagram" | "portal_inmobiliario" | "fb_marketplace";
    /** El reloj de la bitácora de publicaciones (el límite diario de Marketplace cuenta por día). */
    clock?: () => Date;
    account?: boolean;
    approve?: boolean;
    queueFails?: () => AppError | undefined;
    /** Ids del aviso, los textos y la cuenta (la API exige uuid en sus rutas); por defecto, legibles. */
    nextId?: () => string;
  } = {},
) {
  const ids = options.nextId === undefined ? {} : { nextId: options.nextId };
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const broker = contentBrokerFixture();
  const listings = createInMemoryListingRepository(ids);
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    ...rest
  } = contentListingFixture();
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "h",
  });
  await listings.promoteToReady(listing.id);
  const originals = [
    { name: "foto-1", kind: "image" as const, isCover: true },
    { name: "foto-2", kind: "image" as const },
    { name: "video-1", kind: "video" as const },
  ];
  for (const [index, original] of originals.entries()) {
    const path = `brokers/${broker.id}/listings/${listing.id}/original/${original.name}`;
    const mime = original.kind === "video" ? "video/mp4" : "image/jpeg";
    await storage.put(path, text(original.name), mime);
    await media.create({
      listingId: listing.id,
      brokerId: broker.id,
      kind: original.kind,
      storagePath: path,
      mime,
      bytes: original.name.length,
      checksum: `sha-${original.name}`,
      sortOrder: index,
      isCover: original.isCover ?? false,
    });
  }
  const { contents, contentRuns } = createInMemoryContentRepositories(ids);
  const brokers = createInMemoryBrokerRepository([broker]);
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const platformAccounts = createInMemoryPlatformAccountRepository(ids);
  const publications = createInMemoryPublicationRepository(
    options.clock === undefined ? {} : { now: options.clock },
  );
  const locked: LockedRepositories = {
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const lock = createInMemoryListingLock(locked);
  const queue = createInMemoryJobQueue(
    options.queueFails === undefined ? {} : { fail: options.queueFails },
  );

  const prepare = async () => {
    const run = await contentRuns.create({ listingId: listing.id, texts: true });
    await prepareContent(
      {
        listings,
        brokers,
        fieldDefinitions,
        media,
        contentRuns,
        storage,
        processor: createInMemoryMediaProcessor(),
        templates: createInMemorySlideTemplates(),
        renderer: createInMemoryHtmlRenderer(),
        llm: createInMemoryLlmProvider([{ data: SAMPLE_CONTENT_DRAFT }]),
        sha256: fakeHash,
      },
      { contentRunId: run.id, isLastAttempt: true },
    );
  };
  await prepare();
  const platform = options.platform ?? "instagram";
  const connect = () =>
    platform === "fb_marketplace"
      ? platformAccounts.upsertConnected({
          brokerId: broker.id,
          platform: "fb_marketplace",
          externalAccountId: "100012345678901",
          displayName: "Facebook de prueba",
          tokenExpiresAt: null,
          meta: {
            userId: "100012345678901",
            connectedAt: "2026-10-09T12:00:00.000Z",
            sessionCheckedAt: "2026-10-09T12:00:00.000Z",
          },
          credentials: null,
        })
      : platform === "instagram"
        ? platformAccounts.upsertConnected({
            brokerId: broker.id,
            platform: "instagram",
            externalAccountId: "17841400000000001",
            displayName: "@muestra",
            tokenExpiresAt: null,
            meta: {},
            credentials: { accessToken: PUBLICATION_SCENARIO_TOKEN },
          })
        : platformAccounts.upsertConnected({
            brokerId: broker.id,
            platform: "portal_inmobiliario",
            externalAccountId: "8035443",
            displayName: "VICENTEWOLDE",
            tokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
            meta: { accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
            credentials: { ...PORTAL_SCENARIO_TOKENS },
          });
  const account = options.account === false ? null : await connect();
  const contentIdOf = async (wanted: "instagram" | "portal_inmobiliario" | "fb_marketplace") =>
    (await contents.listCurrent(listing.id)).find((item) => item.platform === wanted)?.id ?? "";
  const instagramId = () => contentIdOf("instagram");
  const portalId = () => contentIdOf("portal_inmobiliario");
  const approved =
    options.approve === false
      ? null
      : await approveContent(
          { contents, listings, fieldDefinitions, lock },
          { contentId: await contentIdOf(platform), actor: "operator" },
        );

  // Lo que se usa fuera del candado: falla si se llama dentro (`fn` solo usa lo del candado).
  let insideLock = false;
  const watchedLock: ListingLock = {
    async run(listingId, fn) {
      return lock.run(listingId, async (repos) => {
        insideLock = true;
        try {
          return await fn(repos);
        } finally {
          insideLock = false;
        }
      });
    },
  };
  const outsidePublications = {
    async get(id: string) {
      if (insideLock) throw new Error("get se llamó dentro del candado");
      return publications.get(id);
    },
  };
  // Lo que publicar lee antes del candado en Portal (las definiciones de campos): en PGlite, una
  // lectura de la conexión general dentro del candado se quedaría esperando.
  const outsideListings = {
    async get(id: string) {
      if (insideLock) throw new Error("listings.get se llamó dentro del candado");
      return listings.get(id);
    },
  };
  const outsideFieldDefinitions = {
    async list(filter: Parameters<typeof fieldDefinitions.list>[0]) {
      if (insideLock) throw new Error("fieldDefinitions.list se llamó dentro del candado");
      return fieldDefinitions.list(filter);
    },
  };
  // La cola se usa después del candado: falla si se encola dentro.
  const watchedQueue: typeof queue = {
    jobs: queue.jobs,
    async enqueue(name, data, enqueueOptions) {
      if (insideLock) throw new Error("se encoló dentro del candado");
      return queue.enqueue(name, data, enqueueOptions);
    },
  };
  const byFormat = (format: Publication["format"]) =>
    publications.all().find((publication) => publication.format === format);
  return {
    listingId: listing.id,
    locked,
    listings,
    contents,
    contentRuns,
    platformAccounts,
    publications,
    queue,
    account,
    connect,
    instagramId,
    portalId,
    prepare,
    approved,
    byFormat,
    deps: {
      lock: watchedLock,
      queue: watchedQueue,
      publications: outsidePublications,
      listings: outsideListings,
      fieldDefinitions: outsideFieldDefinitions,
    },
    approveDeps: { contents, listings, fieldDefinitions, lock },
    fieldDefinitions,
    media,
    storage,
    brokers,
  };
}

export type PublicationScenario = Awaited<ReturnType<typeof createPublicationScenario>>;
