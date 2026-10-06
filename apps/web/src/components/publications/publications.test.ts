import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import {
  approveBlockedReason,
  editBlockedReason,
  prepareBlockedReason,
  publicationActions,
  publishBlockedReason,
  retryBlockedReason,
  unapproveBlockedReason,
} from "./publications.js";

const NOW = new Date("2026-10-06T12:00:00Z");

const content = (overrides: Partial<ContentView> = {}): ContentView => ({
  id: "texto-1",
  platform: "instagram",
  title: null,
  body: "Departamento en Ñuñoa",
  hashtags: [],
  status: "approved",
  checks: [],
  promptVersion: "v1",
  updatedAt: NOW,
  ...overrides,
});

const publication = (overrides: Partial<PublicationView> = {}): PublicationView => ({
  id: "p-1",
  listingId: "l-1",
  platformAccountId: "a-1",
  platform: "instagram",
  format: "post",
  contentId: "texto-1",
  mediaIds: [],
  status: "approved",
  dryRun: true,
  startedLive: false,
  attempts: 0,
  lastError: null,
  externalUrl: null,
  scheduledAt: null,
  publishedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("bloqueos", () => {
  it("preparar: solo con publicaciones pendientes", () => {
    expect(prepareBlockedReason([publication({ status: "published" })])).toBeNull();
    for (const status of ["approved", "publishing", "failed"] as const) {
      expect(prepareBlockedReason([publication({ status })])).not.toBeNull();
    }
  });

  it("editar: con una publicación activa de ese texto (pendiente o publicada), no de otro", () => {
    expect(editBlockedReason(content(), [publication({ status: "published" })])).not.toBeNull();
    expect(editBlockedReason(content(), [publication({ status: "cancelled" })])).toBeNull();
    expect(
      editBlockedReason(content(), [publication({ status: "approved", contentId: "otro" })]),
    ).toBeNull();
  });

  it("aprobar: aviso preparable, sin corrida y sin errores en la revisión", () => {
    expect(approveBlockedReason(content(), "ready", false)).toBeNull();
    expect(approveBlockedReason(content(), "draft", false)).not.toBeNull();
    expect(approveBlockedReason(content(), "ready", true)).toContain("preparando");
    const withErrors = content({
      checks: [{ code: "TOO_LONG", severity: "error", message: "largo" }],
    });
    expect(approveBlockedReason(withErrors, "ready", false)).toContain("errores");
  });

  it("quitar la aprobación: no con una publicación de ese texto en curso", () => {
    expect(
      unapproveBlockedReason(content(), [publication({ status: "publishing" })]),
    ).not.toBeNull();
    expect(unapproveBlockedReason(content(), [publication({ status: "failed" })])).toBeNull();
  });

  it("publicar: aviso listo o activo y sin corrida", () => {
    expect(publishBlockedReason("ready", false)).toBeNull();
    expect(publishBlockedReason("active", false)).toBeNull();
    expect(publishBlockedReason("paused", false)).not.toBeNull();
    expect(publishBlockedReason("ready", true)).not.toBeNull();
  });

  it("reintentar: no en simulación si ya empezó en vivo", () => {
    const started = publication({ status: "failed", startedLive: true, dryRun: false });
    expect(retryBlockedReason(started, "dry-run")).toContain("Ya empezó en vivo");
    expect(retryBlockedReason(started, "live")).toBeNull();
    expect(retryBlockedReason(publication({ status: "failed" }), "dry-run")).toBeNull();
  });
});

describe("publicationActions", () => {
  it("reintentar la fallida, descartar la aprobada o fallida, retirar la publicada", () => {
    expect(publicationActions(publication({ status: "approved" }))).toEqual({
      retry: false,
      cancel: true,
      retire: false,
    });
    expect(publicationActions(publication({ status: "failed" }))).toEqual({
      retry: true,
      cancel: true,
      retire: false,
    });
    expect(publicationActions(publication({ status: "published" }))).toEqual({
      retry: false,
      cancel: false,
      retire: true,
    });
    expect(publicationActions(publication({ status: "publishing" }))).toEqual({
      retry: false,
      cancel: false,
      retire: false,
    });
  });
});
