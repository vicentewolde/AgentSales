import { describe, expect, it } from "vitest";
import {
  IMPORT_RUN_STATUSES,
  LISTING_STATUSES,
  OPERATIONS,
  PLATFORM_ACCOUNT_STATUSES,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
} from "./enums.js";
import { IMPORT_BROKER_OUTCOMES, IMPORT_ROW_OUTCOMES } from "./import-run.js";
import {
  accountDisconnectText,
  IMPORT_BROKER_OUTCOME_TEXT,
  IMPORT_ROW_OUTCOME_TEXT,
  IMPORT_RUN_STATUS_TEXT,
  LISTING_STATUS_TEXT,
  manualConfirmCommands,
  manualWaitingText,
  marketplaceConnectCommand,
  mercadoLibreConnectCommands,
  OPERATION_TEXT,
  PLATFORM_ACCOUNT_STATUS_TEXT,
  PUBLICATION_ACTOR_TEXT,
  PUBLICATION_FORMAT_TEXT,
  PUBLICATION_STATUS_TEXT,
  PUBLISH_ATTEMPT_RESULT_TEXT,
  publicationEventDetail,
  publicationFormatText,
  remoteStatusText,
  tokenStdinCommand,
} from "./labels.js";
import { PUBLICATION_ACTORS, PUBLISH_ATTEMPT_RESULTS } from "./publication.js";

describe("textos para el operador", () => {
  it("cubren todos los valores de cada enum, sin repetirse", () => {
    for (const [values, text] of [
      [LISTING_STATUSES, LISTING_STATUS_TEXT],
      [OPERATIONS, OPERATION_TEXT],
      [IMPORT_RUN_STATUSES, IMPORT_RUN_STATUS_TEXT],
      [IMPORT_BROKER_OUTCOMES, IMPORT_BROKER_OUTCOME_TEXT],
      [IMPORT_ROW_OUTCOMES, IMPORT_ROW_OUTCOME_TEXT],
      [PUBLICATION_STATUSES, PUBLICATION_STATUS_TEXT],
      [PUBLICATION_FORMATS, PUBLICATION_FORMAT_TEXT],
      [PLATFORM_ACCOUNT_STATUSES, PLATFORM_ACCOUNT_STATUS_TEXT],
      [PUBLISH_ATTEMPT_RESULTS, PUBLISH_ATTEMPT_RESULT_TEXT],
      [PUBLICATION_ACTORS, PUBLICATION_ACTOR_TEXT],
    ] as const) {
      const labels = values.map((value) => (text as Record<string, string>)[value]);
      expect(labels.every((label) => typeof label === "string" && label.length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(values.length);
    }
  });

  it("tokenStdinCommand: el slug tal cual, o entre comillas si trae otra cosa", () => {
    expect(tokenStdinCommand("vp-propiedades")).toBe(
      "pbpaste | pnpm -s cli accounts connect instagram --broker vp-propiedades --token-stdin",
    );
    expect(tokenStdinCommand("a b'; rm")).toContain("--broker 'a b'\\''; rm' --token-stdin");
  });

  it("mercadoLibreConnectCommands: el enlace y pegar la dirección, con el mismo slug", () => {
    expect(mercadoLibreConnectCommands("agentsales-pruebas")).toEqual({
      authorize: "pnpm -s cli accounts connect mercadolibre --broker agentsales-pruebas",
      paste:
        "pbpaste | pnpm -s cli accounts connect mercadolibre --broker agentsales-pruebas --url-stdin",
    });
    expect(mercadoLibreConnectCommands("a b").paste).toContain("--broker 'a b' --url-stdin");
  });

  it("manualWaitingText y accountDisconnectText (spec F5 §4.12)", () => {
    expect(manualWaitingText(null)).toBe("formulario listo: di si lo publicaste");
    // F7: a mano no hay ventana de Chromium.
    const byHand = { simulated: false, windowClosedAt: null, byHand: true };
    expect(manualWaitingText(byHand)).toMatch(/^publícalo tú/);
    expect(manualWaitingText(byHand)).not.toMatch(/Chromium|ventana/);
    expect(manualWaitingText({ ...byHand, simulated: true })).toMatch(/^simulación: publícalo tú/);
    expect(manualWaitingText({ simulated: true, windowClosedAt: null })).toMatch(/^simulación/);
    expect(manualWaitingText({ simulated: false, windowClosedAt: new Date() })).toBe(
      "la ventana se cerró: ¿lo publicaste?",
    );
    expect(manualWaitingText({ simulated: false, windowClosedAt: null })).toMatch(/Chromium/);
    expect(accountDisconnectText("fb_marketplace")).toMatch(/perfil de Chromium/);
    expect(accountDisconnectText("instagram")).toMatch(/reconectarla/);
    // F7: la cuenta a mano no tiene perfil que borrar.
    expect(accountDisconnectText("fb_marketplace", "manual")).toMatch(/a mano/);
    expect(accountDisconnectText("fb_marketplace", "manual")).not.toMatch(/Chromium/);
  });

  it("marketplaceConnectCommand y manualConfirmCommands (spec F5 §4.12)", () => {
    expect(marketplaceConnectCommand("agentsales-pruebas")).toBe(
      "pnpm -s cli accounts connect marketplace --broker agentsales-pruebas",
    );
    expect(manualConfirmCommands("pub-1")).toEqual({
      confirm: "pbpaste | pnpm -s cli publications confirm pub-1 --url-stdin",
      notPublished: "pnpm -s cli publications not-published pub-1",
    });
  });
});

describe("publicationFormatText (F4-T20)", () => {
  it("en Portal el formato es el aviso; en Instagram, carrusel o reel", () => {
    expect(publicationFormatText("portal_inmobiliario", "post")).toBe("aviso");
    expect(publicationFormatText("fb_marketplace", "post")).toBe("aviso");
    expect(publicationFormatText("instagram", "post")).toBe("carrusel");
    expect(publicationFormatText("instagram", "reel")).toBe("reel");
  });
});

describe("remoteStatusText (estado en Mercado Libre, F4-T16)", () => {
  const text = (status: string, subStatus: string[] = []) =>
    remoteStatusText({ status, subStatus });

  it("nombra los estados de la nota §4.4 y lo que informa Mercado Libre por su cuenta", () => {
    expect(text("active")).toBe("activo");
    expect(text("paused")).toBe("pausado");
    expect(text("closed")).toBe("cerrado");
    expect(text("closed", ["expired"])).toBe("vencido");
    expect(text("closed", ["deleted"])).toBe("eliminado");
    expect(text("under_review")).toBe("en revisión");
    expect(text("not_yet_active")).toBe("por activarse");
    expect(text("paused", ["picture_download_pending"])).toBe("procesando fotos");
    expect(text("not_yet_active", ["picture_download_pending"])).toBe("procesando fotos");
    expect(text("under_review", ["picture_download_pending"])).toBe("fotos rechazadas: revísalas");
  });

  it("una pausa con motivo es de Mercado Libre; la otra grafía de procesar fotos también vale", () => {
    expect(
      remoteStatusText({
        status: "paused",
        subStatus: [],
        reason: { code: "ABANDONED_ITEM_REX_DEN", message: "La reportaron como no disponible" },
      }),
    ).toBe("pausado por Mercado Libre");
    expect(text("paused", ["picture_downloading_pending"])).toBe("procesando fotos");
  });

  it("un estado desconocido se muestra tal cual, sin adivinar", () => {
    expect(text("payment_required")).toBe("otro estado (payment_required)");
  });
});

describe("publicationEventDetail (F6)", () => {
  it("la hora programada con su motivo, la que tenía al desprogramar y si lo hizo la propiedad", () => {
    expect(
      publicationEventDetail({
        type: "status_changed",
        payload: { mode: "dry-run", scheduledAt: "2026-10-19T13:00:00.000Z", reason: "batch" },
      }),
    ).toBe("para el 2026-10-19 10:00 (programada en lote)");
    expect(
      publicationEventDetail({
        type: "status_changed",
        payload: { unscheduled: "2026-10-19T13:00:00.000Z", byListing: true },
      }),
    ).toBe("desprogramada (era el 2026-10-19 10:00) · lo hizo la propiedad");
    expect(
      publicationEventDetail({ type: "status_changed", payload: { due: true, code: "X" } }),
    ).toBe("a la hora no se pudo empezar (X)");
    expect(
      publicationEventDetail({ type: "status_changed", payload: { mode: "live" } }),
    ).toBeNull();
  });

  it("reprogramar y actualizar en Portal", () => {
    expect(
      publicationEventDetail({
        type: "schedule_changed",
        payload: {
          from: "2026-10-19T13:00:00.000Z",
          to: "2026-10-20T14:30:00.000Z",
          mode: "dry-run",
        },
      }),
    ).toBe("reprogramada: 2026-10-19 10:00 → 2026-10-20 11:30");
    expect(
      publicationEventDetail({ type: "manual_edit", payload: { mode: "live", fields: ["price"] } }),
    ).toBe("actualizada en Portal: price");
    expect(publicationEventDetail({ type: "sync", payload: {} })).toBeNull();
  });
});
