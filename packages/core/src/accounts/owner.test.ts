import { describe, expect, it } from "vitest";
import { accountOwnedBy } from "./owner.js";

describe("accountOwnedBy", () => {
  it("es del corredor cuando la cuenta lleva su id", () => {
    expect(accountOwnedBy({ brokerId: "broker-a" }, "broker-a")).toBe(true);
  });

  it("no es del corredor cuando la cuenta es de otro", () => {
    expect(accountOwnedBy({ brokerId: "broker-b" }, "broker-a")).toBe(false);
  });
});
