import type { PlatformAccountView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { accountDateText, expiryState, oauthErrorText, visibleAccounts } from "./accounts.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const account = (overrides: Partial<PlatformAccountView> = {}): PlatformAccountView => ({
  id: "a",
  brokerId: "b",
  platform: "instagram",
  displayName: "@corredora",
  status: "connected",
  tokenExpiresAt: new Date(NOW.getTime() + 30 * DAY),
  tokenExpiryEstimated: false,
  connectedAt: NOW,
  tokenRefreshedAt: null,
  accountType: "BUSINESS",
  permissions: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("expiryState", () => {
  it.each([
    [11 * DAY, { kind: "ok", days: 11 }],
    [10 * DAY, { kind: "soon", days: 10 }],
    [12 * HOUR, { kind: "soon", days: 1 }],
    [1, { kind: "soon", days: 1 }],
    [0, { kind: "expired" }],
    [-HOUR, { kind: "expired" }],
  ])("con %i ms de vigencia: %o", (left, expected) => {
    expect(expiryState(account({ tokenExpiresAt: new Date(NOW.getTime() + left) }), NOW)).toEqual(
      expected,
    );
  });

  it("una cuenta no conectada no avisa; sin fecha, unknown", () => {
    expect(expiryState(account({ status: "expired" }), NOW)).toEqual({ kind: "inactive" });
    expect(expiryState(account({ tokenExpiresAt: null }), NOW)).toEqual({ kind: "unknown" });
  });
});

describe("oauthErrorText", () => {
  it("los códigos conocidos tienen su texto; uno desconocido se nombra solo si parece un código", () => {
    expect(oauthErrorText("OAUTH_STATE_INVALID")).toContain("venció o se abrió desde otra pestaña");
    expect(oauthErrorText("IG_AUTH_INVALID")).toContain("Instagram no aceptó la conexión");
    expect(oauthErrorText("IG_OTRO")).toBe("No se pudo conectar Instagram (IG_OTRO).");
    expect(oauthErrorText("<b>hola</b>")).toBe("No se pudo conectar Instagram.");
  });
});

describe("visibleAccounts", () => {
  it("las no desconectadas; si todas lo están, la que cambió más recientemente", () => {
    const old = account({
      id: "vieja",
      status: "revoked",
      updatedAt: new Date(NOW.getTime() + HOUR),
    });
    const recent = account({ id: "nueva", status: "revoked", updatedAt: NOW });
    const live = account({ id: "viva" });
    expect(visibleAccounts([old, live]).map((a) => a.id)).toEqual(["viva"]);
    expect(visibleAccounts([recent, old]).map((a) => a.id)).toEqual(["vieja"]);
    expect(visibleAccounts([])).toEqual([]);
  });
});

describe("accountDateText", () => {
  it("en hora de Chile, aunque en UTC ya sea otro día", () => {
    expect(accountDateText(new Date("2026-10-07T02:00:00Z"))).toBe("6 de octubre de 2026");
  });
});
