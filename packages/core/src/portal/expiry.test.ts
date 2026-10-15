import { describe, expect, it } from "vitest";
import type { RemoteState } from "../publication.js";
import { portalExpiry } from "./expiry.js";

const remote = (stopTime: string | null, extra: Partial<RemoteState> = {}): RemoteState => ({
  status: "active",
  subStatus: [],
  stopTime,
  expirationTime: null,
  checkedAt: "2026-10-15T12:00:00.000Z",
  ...extra,
});

describe("portalExpiry", () => {
  it("cuenta los días de calendario en hora de Chile", () => {
    // 22:00 en Chile del 15 (UTC-3): todavía es el 15 allá, aunque en UTC sea el 16.
    const now = new Date("2026-10-16T01:00:00.000Z");
    expect(portalExpiry(remote("2026-10-22T12:00:00.000-03:00"), now)).toMatchObject({
      daysLeft: 7,
      soon: true,
      expired: false,
    });
    expect(portalExpiry(remote("2026-10-23T12:00:00.000-03:00"), now)).toMatchObject({
      daysLeft: 8,
      soon: false,
    });
    expect(portalExpiry(remote("2026-10-15T23:30:00.000-03:00"), now)).toMatchObject({
      daysLeft: 0,
      soon: true,
    });
  });

  it("vencido: pasó stop_time o Mercado Libre lo cerró como vencido", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(portalExpiry(remote("2026-10-19T12:00:00.000-03:00"), now)).toMatchObject({
      expired: true,
      soon: false,
    });
    expect(
      portalExpiry(
        remote("2026-11-30T12:00:00.000-03:00", { status: "closed", subStatus: ["expired"] }),
        now,
      ),
    ).toMatchObject({ expired: true });
  });

  it("null sin estado remoto o sin stop_time", () => {
    expect(portalExpiry(null, new Date())).toBeNull();
    expect(portalExpiry(remote(null), new Date())).toBeNull();
  });
});
