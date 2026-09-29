import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  LISTING_STATUSES,
  LLM_PROVIDERS,
  OPERATIONS,
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
  });

  it("dry-run es el primer modo de publicación y los proveedores de IA son los del ADR-0003", () => {
    expect(PUBLISH_MODES).toEqual(["dry-run", "live"]);
    expect(LLM_PROVIDERS).toEqual(["claude-cli", "anthropic-api", "fake"]);
  });
});
