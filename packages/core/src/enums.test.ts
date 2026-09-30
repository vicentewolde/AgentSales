import { describe, expect, it } from "vitest";
import {
  CLOSE_REASONS,
  CONTENT_STATUSES,
  CURRENCIES,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  LLM_PROVIDERS,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  PUBLISH_MODES,
} from "./enums.js";

// Valores de docs/02-modelo-datos.md y ADR-0003; si cambian, cambia también el doc.
describe("enums de dominio", () => {
  it("coinciden con el modelo de datos", () => {
    expect(PLATFORMS).toEqual(["instagram", "portal_inmobiliario", "fb_marketplace"]);
    expect(LISTING_STATUSES).toEqual(["draft", "ready", "active", "paused", "closed", "archived"]);
    expect(CURRENCIES).toEqual(["UF", "CLP"]);
    expect(OPERATIONS).toEqual(["sale", "rent"]);
    expect(PLATFORM_ACCOUNT_STATUSES).toEqual(["connected", "expired", "revoked", "error"]);
    expect(FIELD_TYPES).toEqual(["text", "number", "enum", "boolean", "date", "url", "list"]);
    expect(MEDIA_KINDS).toEqual(["image", "video"]);
    expect(MEDIA_ROLES).toEqual(["original", "processed", "rendered"]);
    expect(CONTENT_STATUSES).toEqual(["draft", "edited", "approved"]);
    expect(LISTING_SOURCES).toEqual(["xlsx", "google_sheets", "manual", "chat"]);
    expect(CLOSE_REASONS).toEqual(["sold", "rented", "withdrawn"]);
    expect(IMPORT_RUN_STATUSES).toEqual(["queued", "running", "succeeded", "failed"]);
  });

  it("dry-run es el primer modo de publicación y los proveedores de IA son los del ADR-0003", () => {
    expect(PUBLISH_MODES).toEqual(["dry-run", "live"]);
    expect(LLM_PROVIDERS).toEqual(["claude-cli", "anthropic-api", "fake"]);
  });
});
