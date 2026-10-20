import type { Language, Platform } from "../enums.js";
import type { PlatformCredentials } from "../platform-account.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import type { Publisher } from "../ports/publisher.js";
import type { PlatformTokenRefresher } from "../ports/token-refresher.js";
import type { Publication } from "../publication.js";
import { postSubject } from "../subject.js";
import { approveContent } from "../use-cases/approve-content.js";
import type { PublishPublicationDeps } from "../use-cases/publish-publication.js";
import { createInMemoryContentRepositories } from "./content.js";
import { contentBrokerFixture } from "./content-fixtures.js";
import { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryListingRepository,
} from "./import-repositories.js";
import { createInMemoryJobQueue } from "./job-queue.js";
import { createInMemoryMediaRepository, createInMemoryMediaStorage } from "./media.js";
import { createInMemoryPlatformAccountRepository } from "./platform-accounts.js";
import {
  createInMemoryEditorialProfileRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
} from "./posts.js";
import { createInMemoryListingLock, createInMemoryPublicationRepository } from "./publications.js";

/** Una cuenta conectada de la marca en una red, con su `meta` y sus credenciales. */
export type PostScenarioAccount = {
  platform: Platform;
  meta?: Record<string, unknown>;
  credentials?: PlatformCredentials;
  tokenExpiresAt?: Date | null;
};

/** Un texto aprobado del post: su red y su idioma. */
export type PostScenarioText = { platform: Platform; language: Language };

/** El token de las cuentas del escenario de posts (inventado): no debe aparecer en la bitácora. */
export const POST_SCENARIO_TOKEN = "token-post-prueba";

/** Credenciales por defecto de cada red (inventadas). */
function defaultCredentials(platform: Platform): PlatformCredentials {
  if (platform === "discord") {
    return { webhookUrl: "https://discord.com/api/webhooks/123456/token-webhook-prueba" };
  }
  if (platform === "x" || platform === "tiktok") {
    return { accessToken: POST_SCENARIO_TOKEN, refreshToken: "refresh-post-prueba" };
  }
  return { accessToken: POST_SCENARIO_TOKEN };
}

/**
 * Escenario de publicación de un post (F9-T06, ADR-0029): una marca con un post `image`, su foto
 * procesada (`ig_4x5`), un texto aprobado por red e idioma (con hashtags) y una cuenta conectada
 * por red; las publicaciones nacen en `approved` al aprobar, en el candado del post. `toPublishing`
 * las pasa a `publishing` directo (sin las revisiones de publicar), `deps` son las de publicar,
 * programar, el disparo y cancelar (F9-T07: los dos candados, la cola y lo que se lee fuera), y
 * `publishDeps` arma las dependencias de `publishPublication` con los dobles.
 */
export async function createPostPublicationScenario(
  options: { texts?: PostScenarioText[]; accounts?: PostScenarioAccount[] } = {},
) {
  const broker = contentBrokerFixture({ kind: "brand" });
  const brokers = createInMemoryBrokerRepository([broker]);
  const posts = createInMemoryPostRepository();
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Lo que aprendí construyendo",
    kind: "image",
    status: "draft",
  });
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const original = await media.create({
    listingId: null,
    postId: post.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `posts/${post.id}/original/foto.jpg`,
    mime: "image/jpeg",
    bytes: 10,
    checksum: "sha-foto",
    sortOrder: 0,
    isCover: false,
  });
  const { media: image } = await media.upsertDerivative({
    role: "processed",
    variant: "ig_4x5",
    parentMediaId: original.id,
    postId: post.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `posts/${post.id}/ig_4x5/foto.jpg`,
    mime: "image/jpeg",
    bytes: 8,
    checksum: "sha-foto-4x5",
    width: 1080,
    height: 1350,
    durationS: null,
  });
  const { contents, contentRuns } = createInMemoryContentRepositories();
  const publications = createInMemoryPublicationRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const listings = createInMemoryListingRepository();
  const repos: PostLockedRepositories = {
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const postLock = createInMemoryPostLock(repos);
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  });

  const texts = options.texts ?? [{ platform: "discord", language: "es" }];
  const run = await contentRuns.create({ postId: post.id, texts: true });
  await contentRuns.markRunning(run.id);
  await contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: texts.map((text) => ({
      platform: text.platform,
      language: text.language,
      title: null,
      body: `Texto en ${text.language} para ${text.platform}`,
      hashtags: ["#agentpey", "#ia"],
      llmProvider: "fake",
      llmModel: "fake",
      promptVersion: "social-v1",
      rawOutput: null,
    })),
  });
  const accounts = new Map<Platform, string>();
  const wanted: PostScenarioAccount[] =
    options.accounts ??
    [...new Set(texts.map((text) => text.platform)).values()].map((platform) => ({ platform }));
  for (const account of wanted) {
    const saved = await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: account.platform,
      externalAccountId: `cuenta-${account.platform}`,
      displayName: `@agentpey-${account.platform}`,
      tokenExpiresAt: account.tokenExpiresAt ?? null,
      meta: account.meta ?? {},
      credentials: account.credentials ?? defaultCredentials(account.platform),
    });
    accounts.set(account.platform, saved.id);
  }
  const approveDeps = {
    contents,
    listings,
    fieldDefinitions: createInMemoryFieldDefinitionRepository([]),
    // La revisión de un texto de post (F9-T11) lee el perfil de la marca antes del candado.
    postReview: { posts, editorialProfiles: createInMemoryEditorialProfileRepository() },
    lock,
    postLock,
  };
  const approved: Publication[] = [];
  for (const item of await contents.listCurrent(postSubject(post.id))) {
    const result = await approveContent(approveDeps, { contentId: item.id, actor: "operator" });
    approved.push(...result.created);
  }

  /** Una publicación del post por red e idioma (por defecto, `es`). */
  const publicationOf = (platform: Platform, language: Language = "es") => {
    const found = approved.find((p) => p.platform === platform && p.language === language);
    if (found === undefined) throw new Error(`sin publicación ${platform}/${language}`);
    return found;
  };
  /** `approved` → `publishing` en el modo pedido, sin las revisiones de publicar. */
  const toPublishing = (publication: Publication, { dryRun = false } = {}) =>
    publications.transition(
      publication.id,
      { from: "approved", to: "publishing", changes: { dryRun, incrementAttempts: true } },
      { actor: "operator", payload: { mode: dryRun ? "dry-run" : "live" } },
    );
  /** Las dependencias de `publishPublication` con los dobles y los publishers dados. */
  const publishDeps = (
    publishers: Readonly<Partial<Record<Platform, Publisher>>>,
    extra: {
      now?: () => Date;
      tokenRefreshers?: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
    } = {},
  ): PublishPublicationDeps => ({
    publications,
    platformAccounts,
    mercadoLibre: null,
    contents,
    media,
    listings,
    brokers,
    storage,
    publishers,
    workerMode: "live",
    marketplaceAutomation: false,
    ...extra,
  });
  const current = (id: string) => publications.all().find((p) => p.id === id);
  const queue = createInMemoryJobQueue();
  const fieldDefinitions = createInMemoryFieldDefinitionRepository([]);
  return {
    broker,
    post,
    image,
    repos,
    posts,
    publications,
    platformAccounts,
    contents,
    media,
    storage,
    listings,
    lock,
    postLock,
    accounts,
    approved,
    publicationOf,
    toPublishing,
    publishDeps,
    current,
    /** Las de confirmar, no publicar y resolver: los dos candados y la lectura de fuera. */
    subjectDeps: { lock, postLock, publications },
    queue,
    /**
     * Las de publicar, programar, el disparo de las programadas, desprogramar, descartar y retirar
     * (F9-T07): los dos candados, la cola y lo que se lee fuera del candado.
     */
    deps: { lock, postLock, queue, publications, listings, fieldDefinitions },
  };
}

export type PostPublicationScenario = Awaited<ReturnType<typeof createPostPublicationScenario>>;
