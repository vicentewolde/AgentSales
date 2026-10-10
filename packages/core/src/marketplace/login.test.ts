import { describe, expect, it } from "vitest";
import {
  currentMarketplaceLoginError,
  type MarketplaceLoginAccount,
  marketplaceLoginErrorText,
  marketplaceLoginOutcome,
} from "./login.js";

const BROKER = "broker-1";
const REQUESTED = new Date("2026-10-10T12:00:00Z");
const at = (minutes: number) => new Date(REQUESTED.getTime() + minutes * 60_000);

const account = (extra: Partial<MarketplaceLoginAccount> = {}): MarketplaceLoginAccount => ({
  brokerId: BROKER,
  platform: "fb_marketplace",
  status: "connected",
  sessionCheckedAt: at(-60),
  lastLoginError: null,
  ...extra,
});

const outcome = (accounts: MarketplaceLoginAccount[]) =>
  marketplaceLoginOutcome(accounts, { brokerId: BROKER, requestedAt: REQUESTED });

describe("marketplaceLoginOutcome (spec F5 §4.2)", () => {
  it("sigue esperando sin cuentas, o con una sesión y un error de antes del pedido", () => {
    expect(outcome([])).toEqual({ outcome: "pending" });
    expect(
      outcome([account({ lastLoginError: { code: "MARKETPLACE_LOGIN_TIMEOUT", at: at(-5) } })]),
    ).toEqual({ outcome: "pending" });
  });

  it("conectada: la sesión se revisó desde el pedido y la cuenta quedó conectada", () => {
    expect(outcome([account({ sessionCheckedAt: at(2) })])).toEqual({ outcome: "connected" });
    // Una revocada con una revisión nueva no cuenta como conectada.
    expect(outcome([account({ status: "revoked", sessionCheckedAt: at(2) })])).toEqual({
      outcome: "pending",
    });
  });

  it("falló: un error de inicio de sesión desde el pedido, también en una cuenta desconectada", () => {
    expect(
      outcome([
        account({
          status: "revoked",
          lastLoginError: { code: "MARKETPLACE_LOGIN_TIMEOUT", at: at(10) },
        }),
      ]),
    ).toEqual({ outcome: "failed", code: "MARKETPLACE_LOGIN_TIMEOUT" });
  });

  it("gana lo más reciente entre la sesión y el error", () => {
    expect(
      outcome([
        account({
          sessionCheckedAt: at(3),
          lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: at(1) },
        }),
      ]),
    ).toEqual({ outcome: "connected" });
    expect(
      outcome([
        account({ sessionCheckedAt: at(1) }),
        account({
          status: "revoked",
          lastLoginError: { code: "MARKETPLACE_WINDOW_CLOSED", at: at(3) },
        }),
      ]),
    ).toEqual({ outcome: "failed", code: "MARKETPLACE_WINDOW_CLOSED" });
  });

  it("no mira cuentas de otro corredor ni de otra plataforma", () => {
    expect(
      outcome([
        account({ brokerId: "otro", sessionCheckedAt: at(2) }),
        account({ platform: "instagram", sessionCheckedAt: at(2) }),
      ]),
    ).toEqual({ outcome: "pending" });
  });
});

describe("marketplaceLoginOutcome · bordes", () => {
  it("una sesión vista justo a la hora del pedido cuenta; un empate entre sesión y error es conectada", () => {
    expect(outcome([account({ sessionCheckedAt: at(0) })])).toEqual({ outcome: "connected" });
    expect(
      outcome([
        account({
          sessionCheckedAt: at(2),
          lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: at(2) },
        }),
      ]),
    ).toEqual({ outcome: "connected" });
  });
});

describe("currentMarketplaceLoginError", () => {
  const error = { code: "MARKETPLACE_LOGIN_TIMEOUT", at: at(5) };
  it("solo vale si es más nuevo que la última sesión vista", () => {
    expect(currentMarketplaceLoginError({ sessionCheckedAt: at(1), lastLoginError: error })).toBe(
      error,
    );
    expect(currentMarketplaceLoginError({ sessionCheckedAt: null, lastLoginError: error })).toBe(
      error,
    );
    expect(
      currentMarketplaceLoginError({ sessionCheckedAt: at(5), lastLoginError: error }),
    ).toBeNull();
    expect(
      currentMarketplaceLoginError({ sessionCheckedAt: at(9), lastLoginError: error }),
    ).toBeNull();
    expect(
      currentMarketplaceLoginError({ sessionCheckedAt: at(1), lastLoginError: null }),
    ).toBeNull();
  });
});

describe("marketplaceLoginErrorText", () => {
  it("explica los códigos conocidos y nombra el código de los demás", () => {
    expect(marketplaceLoginErrorText("MARKETPLACE_LOGIN_TIMEOUT")).toMatch(/10 minutos/);
    expect(marketplaceLoginErrorText("MARKETPLACE_PROFILE_BUSY")).toMatch(/ocupado/);
    expect(marketplaceLoginErrorText("ALGO_NUEVO")).toBe(
      "No se pudo iniciar sesión en Facebook (ALGO_NUEVO)",
    );
  });
});
