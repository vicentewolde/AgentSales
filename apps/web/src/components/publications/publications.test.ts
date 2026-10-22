import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import {
  accountMissingReason,
  approveBlockedReason,
  editBlockedReason,
  hasSomethingToPublish,
  needsLiveConfirm,
  platformsToPublish,
  prepareBlockedReason,
  publicationActions,
  publicationModeOf,
  publishBlockedReason,
  publishButtonText,
  readinessPublishBlockedReason,
  retryBlockedReason,
  safeExternalUrl,
  unapproveBlockedReason,
  waitStart,
} from "./publications.js";

const NOW = new Date("2026-10-06T12:00:00Z");

const content = (overrides: Partial<ContentView> = {}): ContentView => ({
  id: "texto-1",
  platform: "instagram",
  language: "es",
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
  postId: null,
  platformAccountId: "a-1",
  platform: "instagram",
  format: "post",
  language: "es",
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
  relistedFrom: null,
  schedule: null,
  errorAdvice: null,
  expiry: null,
  createdAt: NOW,
  updatedAt: NOW,
  remoteState: null,
  manual: null,
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
    expect(editBlockedReason(content(), [publication({ status: "published" })])).toBe(
      "Ya se publicó o está por publicarse con este texto. Para cambiarlo, primero retira o descarta esas publicaciones.",
    );
    expect(
      editBlockedReason(content({ platform: "portal_inmobiliario" }), [
        publication({ status: "approved" }),
      ]),
    ).toBe(
      "Ya se publicó o está por publicarse con este texto. Para cambiarlo, primero cierra o descarta esas publicaciones.",
    );
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
    // Marketplace (F5-T13): una que espera el clic final también bloquea (primero se dice si salió).
    expect(
      unapproveBlockedReason(content(), [publication({ status: "awaiting_manual_confirm" })]),
    ).toContain("clic final");
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
    confirm: false,
    schedule: false,
    reschedule: false,
    unschedule: false,
    publishNow: false,
    update: false,
    relist: false,
  };

  it("reintentar la fallida, descartar la aprobada o fallida, retirar la publicada", () => {
    expect(publicationActions(publication({ status: "approved" }))).toEqual({
      ...none,
      cancel: true,
      schedule: true,
    });
    expect(publicationActions(publication({ status: "failed" }))).toEqual({
      ...none,
      retry: true,
      cancel: true,
      schedule: true,
    });
    // F6-T12: una programada se reprograma, desprograma, publica ahora o descarta.
    expect(publicationActions(publication({ status: "scheduled" }))).toEqual({
      ...none,
      reschedule: true,
      unschedule: true,
      publishNow: true,
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
    // F6-T12: Actualizar aviso (publicada o pausada) y Republicar (cerrada o vencida).
    expect(portal("published")).toEqual({
      ...none,
      pause: true,
      close: true,
      sync: true,
      update: true,
    });
    expect(portal("paused")).toEqual({
      ...none,
      resume: true,
      close: true,
      sync: true,
      update: true,
    });
    expect(portal("published", true)).toEqual({ ...none, pause: true, close: true, update: true });
    // Republicar (`canRelist`, core): cerrada, sin republicación viva y la propiedad lista o activa.
    expect(portal("unpublished")).toEqual(none);
    const closed = publication({ platform: "portal_inmobiliario", status: "unpublished" });
    expect(publicationActions(closed, { listingStatus: "ready", relisted: new Set() }).relist).toBe(
      true,
    );
    expect(
      publicationActions(closed, { listingStatus: "closed", relisted: new Set() }).relist,
    ).toBe(false);
    expect(
      publicationActions(closed, { listingStatus: "active", relisted: new Set([closed.id]) })
        .relist,
    ).toBe(false);
    expect(portal("failed")).toEqual({ ...none, retry: true, cancel: true, schedule: true });
  });

  it("Marketplace (F5-T13): esperando el clic, solo lo publiqué o no (nunca descartar); publicada, retirar", () => {
    const marketplace = (status: PublicationView["status"]) =>
      publicationActions(publication({ platform: "fb_marketplace", status }));
    expect(marketplace("awaiting_manual_confirm")).toEqual({ ...none, confirm: true });
    expect(marketplace("published")).toEqual({ ...none, retire: true });
    expect(marketplace("failed")).toEqual({ ...none, retry: true, cancel: true, schedule: true });
  });
});

describe("readinessPublishBlockedReason (F4-T22)", () => {
  const ready = { ready: true, issues: [] };
  it("un texto aprobado con errores en su revisión, o un aviso al que le falta algo, bloquean", () => {
    const withErrors = content({
      platform: "portal_inmobiliario",
      checks: [{ code: "NUMBER_NOT_IN_DATA", severity: "error", message: "Un número no calza" }],
    });
    expect(readinessPublishBlockedReason(withErrors, ready)).toContain("quita la aprobación");
    expect(
      readinessPublishBlockedReason(content({ platform: "portal_inmobiliario" }), {
        ready: false,
        issues: [{ code: "PORTAL_WHATSAPP_MISSING", field: null, message: "Falta el WhatsApp" }],
      }),
    ).toContain("Falta información para Portal");
    expect(
      readinessPublishBlockedReason(content({ platform: "portal_inmobiliario" }), ready),
    ).toBeNull();
    expect(readinessPublishBlockedReason(undefined, null)).toBeNull();
    // Marketplace (F5-T13): la misma regla, nombrando el canal.
    expect(
      readinessPublishBlockedReason(
        content({ platform: "fb_marketplace" }),
        { ready: false, issues: [{ code: "UF_SOURCE_NOT_CONFIGURED", field: null, message: "x" }] },
        "Marketplace",
      ),
    ).toContain("Falta información para Marketplace");
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

describe("algo por publicar (F9.5-T02)", () => {
  it("un texto aprobado sin publicaciones, o con una aprobada o fallida; si todo salió, nada", () => {
    expect(hasSomethingToPublish([content()], [])).toBe(true);
    expect(hasSomethingToPublish([content()], [publication({ status: "approved" })])).toBe(true);
    expect(hasSomethingToPublish([content()], [publication({ status: "failed" })])).toBe(true);
    for (const status of ["published", "publishing", "scheduled", "outcome_unknown"] as const) {
      expect(hasSomethingToPublish([content()], [publication({ status })])).toBe(false);
    }
    // Una descartada o una retirada no cuenta: al publicar nace otra.
    expect(hasSomethingToPublish([content()], [publication({ status: "cancelled" })])).toBe(true);
    expect(hasSomethingToPublish([content()], [publication({ status: "unpublished" })])).toBe(true);
    expect(
      hasSomethingToPublish(
        [content()],
        [publication({ status: "unpublished" }), publication({ status: "published" })],
      ),
    ).toBe(false);
    // Sin texto aprobado, nada; las publicaciones de otro texto no cuentan.
    expect(hasSomethingToPublish([content({ status: "draft" })], [])).toBe(false);
    expect(
      hasSomethingToPublish([content()], [publication({ status: "published", contentId: "otro" })]),
    ).toBe(true);
  });

  it("platformsToPublish: por red, con todos sus idiomas; sin las publicaciones, todas", () => {
    const contents = [
      content({ id: "x-es", platform: "x" }),
      content({ id: "x-en", platform: "x", language: "en" }),
      content({ id: "d-es", platform: "discord" }),
    ];
    const publications = [
      publication({ contentId: "x-es", platform: "x", status: "published" }),
      publication({ contentId: "x-en", platform: "x", status: "published" }),
      publication({ contentId: "d-es", platform: "discord", status: "published" }),
    ];
    expect(platformsToPublish(["x", "discord"], contents, undefined)).toEqual(["x", "discord"]);
    expect(platformsToPublish(["x", "discord"], contents, publications)).toEqual([]);
    // El inglés de X todavía no sale: X tiene algo por publicar.
    expect(
      platformsToPublish(["x", "discord"], contents, [
        publications[0] as PublicationView,
        publications[2] as PublicationView,
      ]),
    ).toEqual(["x"]);
  });
});

describe("el modo que se muestra (D4 del spec F9.5)", () => {
  it("aprobada: no fijado (vale el del sistema); publicada y fallida que empezó en vivo: fijado", () => {
    expect(publicationModeOf(publication({ status: "approved" })).modeFixed).toBe(false);
    expect(publicationModeOf(publication({ status: "published" })).modeFixed).toBe(true);
    expect(
      publicationModeOf(publication({ status: "failed", dryRun: false, startedLive: true })),
    ).toEqual({ dryRun: false, modeFixed: true });
    expect(publicationModeOf(publication({ status: "failed", startedLive: false })).modeFixed).toBe(
      false,
    );
  });
});

describe("accountMissingReason (F9.5-T20)", () => {
  const account = (
    overrides: Partial<{
      brokerId: string;
      platform: "instagram" | "fb_marketplace";
      status: "connected" | "revoked" | "expired";
    }> = {},
  ) => ({
    brokerId: "corredor-1",
    platform: "instagram" as const,
    status: "connected" as const,
    ...overrides,
  });

  it("con la cuenta conectada del corredor en ese canal no bloquea", () => {
    expect(accountMissingReason("instagram", [account()], "corredor-1")).toBeNull();
  });

  it("sin cuenta, o desconectada, o de otro corredor, o de otra red: dice qué conectar", () => {
    const reason = "Conecta tu cuenta de Instagram en Cuentas para publicar.";
    expect(accountMissingReason("instagram", [], "corredor-1")).toBe(reason);
    expect(accountMissingReason("instagram", [account({ status: "revoked" })], "corredor-1")).toBe(
      reason,
    );
    expect(accountMissingReason("instagram", [account({ brokerId: "otro" })], "corredor-1")).toBe(
      reason,
    );
    expect(
      accountMissingReason("instagram", [account({ platform: "fb_marketplace" })], "corredor-1"),
    ).toBe(reason);
    expect(accountMissingReason("fb_marketplace", [account()], "corredor-1")).toBe(
      "Conecta tu cuenta de Facebook en Cuentas para publicar.",
    );
  });

  it("mientras no se sabe (cuentas sin cargar o corredor sin dato), no bloquea", () => {
    expect(accountMissingReason("instagram", undefined, "corredor-1")).toBeNull();
    expect(accountMissingReason("instagram", [], undefined)).toBeNull();
  });
});
