import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import {
  approveBlockedReason,
  editBlockedReason,
  needsLiveConfirm,
  portalPublishBlockedReason,
  prepareBlockedReason,
  publicationActions,
  publishBlockedReason,
  publishButtonText,
  retryBlockedReason,
  safeExternalUrl,
  unapproveBlockedReason,
  waitStart,
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
  remoteState: null,
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

  it("preparar: también con las programadas o esperando el clic final", () => {
    for (const status of ["scheduled", "awaiting_manual_confirm"] as const) {
      expect(prepareBlockedReason([publication({ status })])).not.toBeNull();
    }
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
  const none = {
    retry: false,
    cancel: false,
    retire: false,
    pause: false,
    resume: false,
    close: false,
    sync: false,
  };

  it("reintentar la fallida, descartar la aprobada o fallida, retirar la publicada", () => {
    expect(publicationActions(publication({ status: "approved" }))).toEqual({
      ...none,
      cancel: true,
    });
    expect(publicationActions(publication({ status: "failed" }))).toEqual({
      ...none,
      retry: true,
      cancel: true,
    });
    expect(publicationActions(publication({ status: "published" }))).toEqual({
      ...none,
      retire: true,
    });
    expect(publicationActions(publication({ status: "publishing" }))).toEqual(none);
  });

  it("Portal (F4-T22): pausar la publicada, reactivar la pausada, cerrar las dos; Actualizar solo en vivo; nunca retirar", () => {
    const portal = (status: PublicationView["status"], dryRun = false) =>
      publicationActions(publication({ platform: "portal_inmobiliario", status, dryRun }));
    expect(portal("published")).toEqual({ ...none, pause: true, close: true, sync: true });
    expect(portal("paused")).toEqual({ ...none, resume: true, close: true, sync: true });
    expect(portal("published", true)).toEqual({ ...none, pause: true, close: true });
    expect(portal("unpublished")).toEqual(none);
    expect(portal("failed")).toEqual({ ...none, retry: true, cancel: true });
  });
});

describe("portalPublishBlockedReason (F4-T22)", () => {
  const ready = { ready: true, issues: [] };
  it("un texto aprobado con errores en su revisión, o un aviso al que le falta algo, bloquean", () => {
    const withErrors = content({
      platform: "portal_inmobiliario",
      checks: [{ code: "NUMBER_NOT_IN_DATA", severity: "error", message: "Un número no calza" }],
    });
    expect(portalPublishBlockedReason(withErrors, ready)).toContain("quita la aprobación");
    expect(
      portalPublishBlockedReason(content({ platform: "portal_inmobiliario" }), {
        ready: false,
        issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null, message: "Falta el WhatsApp" }],
      }),
    ).toContain("Falta información para Portal");
    expect(
      portalPublishBlockedReason(content({ platform: "portal_inmobiliario" }), ready),
    ).toBeNull();
    expect(portalPublishBlockedReason(undefined, null)).toBeNull();
  });
});

describe("modo, espera y enlace", () => {
  it("se confirma en vivo y también si no se sabe el modo; solo la simulación conocida no pregunta", () => {
    expect(needsLiveConfirm("live")).toBe(true);
    expect(needsLiveConfirm(undefined)).toBe(true);
    expect(needsLiveConfirm("dry-run")).toBe(false);
    expect(publishButtonText("instagram", undefined)).toBe("Publicar en Instagram");
    expect(publishButtonText("instagram", "live")).toContain("en vivo");
    expect(publishButtonText("portal_inmobiliario", "dry-run")).toBe(
      "Publicar en Portal Inmobiliario (simulación)",
    );
  });

  it("la espera cuenta desde el más reciente entre el último cambio y el clic", () => {
    const before = new Date(NOW.getTime() - 60_000);
    expect(waitStart(NOW, null)).toEqual(NOW);
    expect(waitStart(before, NOW)).toEqual(NOW);
    expect(waitStart(NOW, before)).toEqual(NOW);
  });

  it("el enlace de una publicada solo si es https", () => {
    expect(safeExternalUrl("https://www.instagram.com/p/x/")).toBe(
      "https://www.instagram.com/p/x/",
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("http://instagram.com/p/x/")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});
