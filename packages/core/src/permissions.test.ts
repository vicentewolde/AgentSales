import { describe, expect, it } from "vitest";
import { ALL_SCOPE, brokerScope, inScope, scopedBrokerId } from "./access.js";
import { assertCan, can, PERMISSIONS, type Permission, scopeOf } from "./permissions.js";

// F7-T03 (spec F7 §4.5): cada fila de la tabla de permisos, y el alcance de cada rol.

const admin = { role: "admin" as const, brokerId: null };
const broker = { role: "broker" as const, brokerId: "b1" };

/** La tabla §4.5: lo que el corredor puede hacer con lo suyo. */
const BROKER_CAN: Readonly<Record<Permission, boolean>> = {
  "listings.manage": true,
  "marketplace.confirm": true,
  "brand.edit": true,
  "broker.view": true,
  "accounts.manage": false,
  "instagram.connect": true,
  "broker.settings": false,
  "brokers.create": false,
  "users.manage": false,
  "system.view": false,
};

describe("permisos (§4.5)", () => {
  it.each(PERMISSIONS)("%s: el administrador siempre; el corredor según la tabla", (permission) => {
    expect(can(admin, permission, "b1")).toBe(true);
    expect(can(admin, permission, "b2")).toBe(true);
    expect(can(admin, permission)).toBe(true);
    expect(can(broker, permission, "b1")).toBe(BROKER_CAN[permission]);
    // Nunca con lo de otro corredor, ni sin decir de qué corredor es.
    expect(can(broker, permission, "b2")).toBe(false);
    expect(can(broker, permission, null)).toBe(false);
    expect(can(broker, permission)).toBe(false);
  });

  it("un corredor sin corredor (imposible por la base) no puede nada", () => {
    const orphan = { role: "broker" as const, brokerId: null };
    for (const permission of PERMISSIONS) {
      expect(can(orphan, permission, null)).toBe(false);
      expect(can(orphan, permission)).toBe(false);
    }
  });

  it("assertCan da FORBIDDEN", () => {
    expect(() => assertCan(broker, "accounts.manage", "b1")).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(() => assertCan(broker, "listings.manage", "b1")).not.toThrow();
  });
});

describe("alcance (ADR-0022)", () => {
  it("el administrador ve todo; el corredor, lo suyo", () => {
    expect(scopeOf(admin)).toEqual(ALL_SCOPE);
    expect(scopeOf(broker)).toEqual(brokerScope("b1"));
    expect(inScope(ALL_SCOPE, null)).toBe(true);
    expect(inScope(brokerScope("b1"), "b1")).toBe(true);
    expect(inScope(brokerScope("b1"), "b2")).toBe(false);
    expect(inScope(brokerScope("b1"), null)).toBe(false);
    expect(scopedBrokerId(ALL_SCOPE)).toBeUndefined();
    expect(scopedBrokerId(brokerScope("b1"))).toBe("b1");
  });

  it("un corredor sin corredor nunca se abre a todo", () => {
    expect(() => scopeOf({ role: "broker", brokerId: null })).toThrow(
      expect.objectContaining({ code: "USER_ROW_INVALID" }),
    );
  });
});
