import { describe, expect, it } from "vitest";
import { httpStatusFor } from "./errors.js";

describe("httpStatusFor", () => {
  it.each([
    ["INVALID_TRANSITION", 409],
    // Al conectar una cuenta (F3-T13).
    ["IG_AUTH_INVALID", 400],
    ["IG_PERMISSION_DENIED", 400],
    ["IG_REQUEST_REJECTED", 400],
    ["IG_UNEXPECTED_RESPONSE", 502],
    ["IG_UNAVAILABLE", 503],
    ["IG_RATE_LIMITED", 429],
    ["OAUTH_STATE_INVALID", 400],
    ["ACCOUNT_NOT_FOUND", 404],
    // Al refrescar a pedido (F3-T14).
    ["ACCOUNT_NOT_CONNECTED", 409],
    ["ACCOUNT_REFRESH_UNSUPPORTED", 409],
    // Al refrescar Mercado Libre a pedido (F4-T08): el candado ocupado se reintenta en un momento,
    // y unas credenciales guardadas sin `refresh_token` son un fallo del servidor.
    ["ACCOUNT_LOCK_TIMEOUT", 503],
    ["CREDENTIALS_INVALID", 500],
    // Aprobar y publicar (F3-T15).
    ["CONTENT_HAS_ERRORS", 409],
    ["CONTENT_NOT_READY", 409],
    ["CONTENT_NOT_APPROVED", 409],
    ["PUBLICATION_IN_PROGRESS", 409],
    ["PUBLICATION_CONFLICT", 409],
    ["NOTHING_TO_PUBLISH", 409],
    ["REMOVAL_NOT_CONFIRMED", 409],
    ["PUBLISH_MODE_LOCKED", 409],
    ["PORTAL_NOT_READY", 409],
    ["PUBLICATION_NOT_FOUND", 404],
    ["QUEUE_UNAVAILABLE", 503],
    ["PUBLICATION_EVENT_INVALID", 500],
    ["PUBLICATION_REFERENCE_INVALID", 500],
    ["PUBLICATION_PROGRESS_INVALID", 500],
    ["CREDENTIALS_UNREADABLE", 500],
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
