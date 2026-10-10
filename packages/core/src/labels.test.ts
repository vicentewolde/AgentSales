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
  IMPORT_BROKER_OUTCOME_TEXT,
  IMPORT_ROW_OUTCOME_TEXT,
  IMPORT_RUN_STATUS_TEXT,
  LISTING_STATUS_TEXT,
  manualConfirmCommands,
  marketplaceConnectCommand,
  mercadoLibreConnectCommands,
  OPERATION_TEXT,
  PLATFORM_ACCOUNT_STATUS_TEXT,
  PUBLICATION_ACTOR_TEXT,
  PUBLICATION_FORMAT_TEXT,
  PUBLICATION_STATUS_TEXT,
  PUBLISH_ATTEMPT_RESULT_TEXT,
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
