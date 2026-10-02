import { describe, expect, it } from "vitest";
import { shouldRetry } from "./App.js";
import { ApiError } from "./api/client.js";

describe("shouldRetry", () => {
  it("reintenta una vez las fallas pasajeras", () => {
    expect(shouldRetry(0, new ApiError("La API no responde", "UNREACHABLE"))).toBe(true);
    expect(shouldRetry(0, new ApiError("DB_UNAVAILABLE: x", "DB_UNAVAILABLE", 503))).toBe(true);
    expect(shouldRetry(1, new ApiError("La API no responde", "UNREACHABLE"))).toBe(false);
  });

  it("no reintenta un 4xx", () => {
    expect(shouldRetry(0, new ApiError("LISTING_NOT_FOUND: x", "LISTING_NOT_FOUND", 404))).toBe(
      false,
    );
  });
});
