// Dobles de prueba de los puertos de core (`@agentsales/core/testing`). Solo para tests: Biome
// prohíbe importarlo desde código de aplicación.
export {
  type FieldDefinitionFixtureRow,
  type FieldDefinitionOrderFixture,
  fieldDefinitionOrderFixture,
} from "./field-definition-fixtures.js";
export { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";
