import { describe, expect, it } from "vitest";
import { httpStatusFor } from "./errors.js";

describe("httpStatusFor", () => {
  it.each([
    ["INVALID_TRANSITION", 409],
    ["JOB_PAYLOAD_INVALID", 500],
    ["QUEUE_UNAVAILABLE", 503],
    ["STORAGE_NOT_FOUND", 404],
    ["LISTING_NOT_FOUND", 404],
    ["IMPORT_INVALID_ROW", 400],
    ["INVALID_INPUT", 400],
    ["PUBLISH_RATE_LIMITED", 429],
    ["STORAGE_UNAVAILABLE", 503],
    ["STORAGE_ERROR", 500],
    ["SEED_FAILED", 500],
    ["ALGO_NUEVO", 500],
  ])("%s → %i", (code, status) => {
    expect(httpStatusFor(code)).toBe(status);
  });
});
