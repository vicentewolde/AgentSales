import { describe, expect, it } from "vitest";
import { httpStatusFor } from "./errors.js";

describe("httpStatusFor", () => {
  it.each([
    ["INVALID_TRANSITION", 409],
    ["LISTING_NOT_READY", 409],
    ["CONTENT_EDITED", 409],
    ["CONTENT_NOT_CURRENT", 409],
    ["CONTENT_RUN_ACTIVE", 409],
    ["CONTENT_LOCKED", 409],
    ["PUBLICATION_PENDING", 409],
    ["CONTENT_RUN_CONFLICT", 500],
    ["CONTENT_HASHTAGS_INVALID", 400],
    ["CONTENT_TITLE_INVALID", 400],
    ["CONTENT_RUN_NOT_FOUND", 404],
    ["REQUEST_TOO_LARGE", 413],
    ["JOB_PAYLOAD_INVALID", 500],
    ["IMPORT_RUN_INVALID", 500],
    ["LISTING_ROW_INVALID", 500],
    ["BROKER_ROW_INVALID", 500],
    ["REQUEST_INVALID", 400],
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
