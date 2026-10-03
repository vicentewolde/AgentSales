// Dobles de prueba de los puertos de core (`@agentsales/core/testing`). Solo para tests: Biome
// prohíbe importarlo desde código de aplicación.

export {
  createInMemoryContentRepositories,
  type InMemoryContentRepositories,
} from "./content.js";
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
