// Dobles de prueba de los puertos de core (`@agentsales/core/testing`). Solo para tests: Biome
// prohíbe importarlo desde código de aplicación.

export {
  createFakePasswordHasher,
  createFakeSecretBox,
  createFakeSecretTokens,
  createFakeTotpProvider,
  fakeTotpCode,
  fakeTotpStep,
} from "./auth.js";
export {
  createFakeBrokerPurgeRepository,
  type FakeBrokerPurgeData,
  type FakeBrokerPurgeRepository,
} from "./broker-purge.js";
export {
  createInMemoryContentRepositories,
  type InMemoryContentRepositories,
} from "./content.js";
export {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "./content-fixtures.js";
export { fakeHash } from "./fake-hash.js";
export {
  createFakePublisher,
  createSendOncePublisher,
  type FakeOperationCall,
  type FakePublishCall,
  type FakePublisher,
  type FakePublisherOptions,
  type FakePublishStep,
  type FakeSendStep,
  type SendOncePublisher,
} from "./fake-publisher.js";
export {
  type FieldDefinitionFixtureRow,
  type FieldDefinitionOrderFixture,
  fieldDefinitionOrderFixture,
} from "./field-definition-fixtures.js";
export { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";
export {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  type InMemoryBrokerRepository,
  type InMemoryBrokerRepositoryOptions,
  type InMemoryImportRunRepository,
  type InMemoryListingRepository,
  type StoredListing,
} from "./import-repositories.js";
export { createInMemoryJobQueue, type EnqueuedJob, type InMemoryJobQueue } from "./job-queue.js";
export {
  createInMemoryLlmProvider,
  type InMemoryLlmProvider,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "./llm.js";
export {
  createInMemoryMediaFileSource,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  type InMemoryMediaFileSource,
  type InMemoryMediaRepository,
  type InMemoryMediaRepositoryOptions,
  type InMemoryMediaStorage,
  type InMemoryMediaStorageOptions,
  type MemoryFileOptions,
  memoryFile,
} from "./media.js";
export {
  createInMemoryMediaProcessor,
  type InMemoryMediaProcessor,
  type InMemoryMediaProcessorOptions,
  type MediaProcessorCall,
} from "./media-processor.js";
export {
  createInMemoryMetaDeletionRepository,
  type InMemoryMetaDeletionRepository,
} from "./meta-deletion.js";
export {
  createInMemoryPlatformAccountRepository,
  type InMemoryPlatformAccountRepository,
  type InMemoryPlatformAccountRepositoryOptions,
} from "./platform-accounts.js";
export {
  createInMemoryPlatformCatalogRepository,
  type InMemoryPlatformCatalogRepository,
} from "./platform-catalog.js";
export {
  createFakeCardRenderer,
  createFakeImageGenerator,
  createFakeStockPhotoProvider,
  createInMemoryPostImageRunRepository,
  fakeJpeg,
} from "./post-images.js";
export {
  createPostPublicationScenario,
  POST_SCENARIO_TOKEN,
  type PostPublicationScenario,
  type PostScenarioAccount,
  type PostScenarioText,
} from "./post-publication-scenario.js";
export {
  createInMemoryEditorialProfileRepository,
  createInMemoryPlanRunRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  type InMemoryPlanRunRepository,
  type InMemoryPostRepository,
} from "./posts.js";
export {
  createPublicationScenario,
  PORTAL_SCENARIO_TOKENS,
  PUBLICATION_SCENARIO_TOKEN,
  type PublicationScenario,
} from "./publication-scenario.js";
export {
  createInMemoryListingLock,
  createInMemoryPublicationRepository,
  type InMemoryPublicationRepository,
} from "./publications.js";
export {
  createInMemoryHtmlRenderer,
  createInMemorySlideTemplates,
  type HtmlRenderCall,
  type InMemoryHtmlRenderer,
  type InMemorySlideTemplates,
  type SlideTemplateCall,
} from "./slides.js";
export { createInMemoryUserRepositories, type InMemoryUserRepositories } from "./users.js";
export {
  createInMemoryWorkerHeartbeatRepository,
  type InMemoryWorkerHeartbeatRepository,
} from "./worker-heartbeats.js";
