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

// Escenario de publicación para los tests de core (F3-T10 y T11): un aviso preparado con los
// dobles, la cuenta de Instagram conectada y el texto aprobado, con un candado y una cola que
// fallan si se usan donde no corresponde.

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/**
 * Un aviso `ready` con 2 fotos y un video, preparado con el proveedor falso. Por defecto con la
 * cuenta de Instagram conectada y el texto aprobado (nacen carrusel y reel en `approved`).
 */
export async function createPublicationScenario(
  options: { account?: boolean; approve?: boolean; queueFails?: () => AppError | undefined } = {},
) {
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const broker = contentBrokerFixture();
  const listings = createInMemoryListingRepository();
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
  const { contents, contentRuns } = createInMemoryContentRepositories();
  const brokers = createInMemoryBrokerRepository([broker]);
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
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
  const connect = () =>
    platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "instagram",
      externalAccountId: "17841400000000001",
      displayName: "@muestra",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "IGAA-prueba" },
    });
  const account = options.account === false ? null : await connect();
  const instagramId = async () =>
    (await contents.listCurrent(listing.id)).find((item) => item.platform === "instagram")?.id ??
    "";
  const approved =
    options.approve === false
      ? null
      : await approveContent(
          { contents, listings, fieldDefinitions, lock },
          { contentId: await instagramId(), actor: "operator" },
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
    prepare,
    approved,
    byFormat,
    deps: { lock: watchedLock, queue: watchedQueue, publications: outsidePublications },
    approveDeps: { contents, listings, fieldDefinitions, lock },
    media,
    storage,
    brokers,
  };
}

export type PublicationScenario = Awaited<ReturnType<typeof createPublicationScenario>>;
