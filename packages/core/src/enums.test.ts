import { describe, expect, it } from "vitest";
import {
  BRIEF_ORIGINS,
  BROKER_KINDS,
  CLOSE_REASONS,
  CONTENT_STATUSES,
  CURRENCIES,
  DEFAULT_LANGUAGE,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  isListingPlatform,
  isTerminalImportRun,
  LANGUAGES,
  LISTING_PLATFORMS,
  LISTING_SOURCES,
  LISTING_STATUSES,
  LLM_PROVIDERS,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLAN_RUN_STATUSES,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORM_SHORT_NAMES,
  PLATFORMS,
  POST_KINDS,
  POST_SOURCES,
  POST_STATUSES,
  POST_UPLOAD_STATUSES,
  PUBLISH_MODES,
} from "./enums.js";

// Valores de docs/02-modelo-datos.md y ADR-0003; si cambian, cambia también el doc.
describe("enums de dominio", () => {
  it("coinciden con el modelo de datos", () => {
    expect(PLATFORMS).toEqual([
      "instagram",
      "portal_inmobiliario",
      "fb_marketplace",
      "x",
      "linkedin",
      "discord",
      "tiktok",
    ]);
    expect(LISTING_PLATFORMS).toEqual(["instagram", "portal_inmobiliario", "fb_marketplace"]);
    expect(BROKER_KINDS).toEqual(["broker", "brand"]);
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
    expect(IMPORT_RUN_STATUSES).toEqual([
      "awaiting_upload",
      "queued",
      "running",
      "succeeded",
      "failed",
    ]);
  });

  it("los posts, sus planes, subidas e idiomas coinciden con el modelo de datos (F9)", () => {
    expect(POST_STATUSES).toEqual(["idea", "draft", "ready", "archived"]);
    expect(POST_KINDS).toEqual(["text", "image", "carousel", "video"]);
    expect(POST_SOURCES).toEqual(["manual", "ai"]);
    expect(BRIEF_ORIGINS).toEqual(["operator", "ai"]);
    expect(PLAN_RUN_STATUSES).toEqual(["queued", "running", "succeeded", "failed"]);
    // `uploaded` (F9-T17) va al final: se agregó con `ALTER TYPE … ADD VALUE` (migración 0017).
    expect(POST_UPLOAD_STATUSES).toEqual(["pending", "completed", "abandoned", "uploaded"]);
    expect(LANGUAGES).toEqual(["es", "en"]);
    expect(DEFAULT_LANGUAGE).toBe("es");
  });

  it("dry-run es el primer modo de publicación y los proveedores de IA son los del ADR-0003", () => {
    expect(PUBLISH_MODES).toEqual(["dry-run", "live"]);
    expect(LLM_PROVIDERS).toEqual(["claude-cli", "anthropic-api", "fake"]);
  });

  it("cada plataforma tiene un nombre corto para la CLI, y las de avisos son las de F2 a F8", () => {
    expect(Object.values(PLATFORM_SHORT_NAMES).sort()).toEqual([...PLATFORMS].sort());
    expect(PLATFORMS.filter(isListingPlatform)).toEqual([...LISTING_PLATFORMS]);
  });

  it("una carga es terminal solo en succeeded o failed", () => {
    expect(IMPORT_RUN_STATUSES.filter(isTerminalImportRun)).toEqual(["succeeded", "failed"]);
  });
});
