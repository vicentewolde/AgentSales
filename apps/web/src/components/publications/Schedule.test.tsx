// @vitest-environment jsdom
import {
  chileInputValue,
  formatChileTime,
  type NewListing,
  type Publication,
} from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessOptions, publicationSetup } from "../../../test/harness.js";

// F6-T12 (spec F6 §4.3 y §4.7): programar, Portal y el consejo del error en el panel, sobre la
// API en proceso (nunca una plataforma real).

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

type Setup = Awaited<ReturnType<typeof publicationSetup>>;

/** Abre Contenido y devuelve la tarjeta de una publicación ("carrusel", "reel" o "aviso"). */
async function card(s: Setup, format: string, tab?: RegExp) {
  const section = await s.open();
  if (tab !== undefined) fireEvent.click(await within(section).findByRole("tab", { name: tab }));
  return within(section).findByRole("article", { name: `Publicación ${format}` });
}

/** Lleva una publicación a `scheduled` a la hora dada (como si la hubiera programado otro). */
async function scheduledAt(t: Setup["t"], id: string, at: Date) {
  await t.publications.transition(
    id,
    { from: "approved", to: "scheduled", changes: { dryRun: true, scheduledAt: at } },
    { actor: "operator" },
  );
}

/** Escribe la hora en el selector y envía el formulario. */
function submitAt(container: HTMLElement, at: Date | string, button = /^Programar|^Reprogramar/) {
  const input = within(container).getByLabelText("Fecha y hora (Chile)");
  fireEvent.change(input, { target: { value: typeof at === "string" ? at : chileInputValue(at) } });
  fireEvent.click(within(container).getByRole("button", { name: button }));
}

describe("programar una publicación", () => {
  it("programa en hora de Chile, la muestra y la desprograma", async () => {
    const s = await publicationSetup();
    const item = await card(s, "carrusel");
    const at = inHours(3);

    fireEvent.click(within(item).getByRole("button", { name: "Programar el carrusel" }));
    expect(within(item).getByText(/Se programa en simulación/)).toBeTruthy();
    submitAt(item, at);

    await waitFor(() =>
      expect(item.textContent).toContain(`Programada para el ${formatChileTime(at)}`),
    );
    const post = s.t.byFormat("post") as Publication;
    expect(post).toMatchObject({ status: "scheduled", dryRun: true });
    expect(within(item).getByRole("button", { name: "Reprogramar el carrusel" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Publicar ahora el carrusel" })).toBeTruthy();

    fireEvent.click(within(item).getByRole("button", { name: "Desprogramar el carrusel" }));
    await waitFor(() => expect(s.t.byFormat("post")?.status).toBe("approved"));
  });

  it("en vivo pide confirmar antes de programar", async () => {
    const s = await publicationSetup({ publishMode: "live" });
    const item = await card(s, "carrusel");

    fireEvent.click(within(item).getByRole("button", { name: "Programar el carrusel" }));
    expect(within(item).getByText(/Se programa en vivo/)).toBeTruthy();
    submitAt(item, inHours(2));

    expect(s.t.byFormat("post")?.status).toBe("approved");
    fireEvent.click(await within(item).findByRole("button", { name: "Sí, programar en vivo" }));
    await waitFor(() =>
      expect(s.t.byFormat("post")).toMatchObject({ status: "scheduled", dryRun: false }),
    );
  });

  it("con la página en simulación vuelve a leer el modo justo antes: si la API pasó a vivo, pide confirmar", async () => {
    // La API pasa a vivo con la página ya abierta (en simulación): solo cambia lo que responde /health.
    let apiLive = false;
    const intercept: HarnessOptions["intercept"] = (method, path) => {
      if (method !== "GET" || path !== "/health" || !apiLive) return undefined;
      return Response.json({
        status: "ok",
        publishMode: "live",
        version: "x",
        checks: {
          db: { ok: true, latencyMs: 1 },
          storage: { ok: true, latencyMs: 1 },
          queue: { ok: true, latencyMs: 1 },
        },
      });
    };
    const s = await publicationSetup({ intercept });
    const item = await card(s, "carrusel");

    fireEvent.click(within(item).getByRole("button", { name: "Programar el carrusel" }));
    expect(within(item).getByText(/Se programa en simulación/)).toBeTruthy();
    apiLive = true;
    submitAt(item, inHours(2));

    expect(await within(item).findByRole("button", { name: "Sí, programar en vivo" })).toBeTruthy();
    expect(s.t.byFormat("post")?.status).toBe("approved");
  });

  it("publicar ahora una programada la empieza (en simulación, sin preguntar)", async () => {
    const s = await publicationSetup();
    await scheduledAt(s.t, s.t.byFormat("post")?.id ?? "", inHours(5));
    const item = await card(s, "carrusel");

    fireEvent.click(within(item).getByRole("button", { name: "Publicar ahora el carrusel" }));

    await waitFor(() => expect(s.t.byFormat("post")?.status).toBe("publishing"));
  });

  it("una hora que no existe en Chile se explica sin enviar nada", async () => {
    const s = await publicationSetup();
    const item = await card(s, "carrusel");

    fireEvent.click(within(item).getByRole("button", { name: "Programar el carrusel" }));
    submitAt(item, "2026-09-06T00:30");

    expect((await within(item).findByRole("alert")).textContent).toContain("no existen en Chile");
    expect(s.requests.some((request) => request.includes("/schedule"))).toBe(false);
  });

  it("atrasada (más de 12 h) y Marketplace 'te toca'", async () => {
    const s = await publicationSetup();
    await scheduledAt(s.t, s.t.byFormat("post")?.id ?? "", new Date(Date.now() - 13 * HOUR));
    const item = await card(s, "carrusel");
    expect(item.textContent).toContain("Atrasada");
    expect(within(item).getByRole("button", { name: "Publicar ahora el carrusel" })).toBeTruthy();

    cleanup();
    const m = await publicationSetup({ platform: "fb_marketplace" });
    await scheduledAt(m.t, m.t.publications.all()[0]?.id ?? "", new Date(Date.now() - 20 * HOUR));
    const reminder = await card(m, "aviso", /Marketplace/);
    expect(reminder.textContent).toContain("Te toca");
    expect(reminder.textContent).not.toContain("Atrasada");
  });

  it("una fallida muestra qué hacer bajo el error", async () => {
    const s = await publicationSetup();
    const id = s.t.byFormat("reel")?.id ?? "";
    await s.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await s.t.publications.transition(
      id,
      {
        from: "publishing",
        to: "failed",
        changes: {
          lastError: { code: "IG_AUTH_INVALID", message: "Token rechazado", retriable: false },
        },
      },
      { actor: "system" },
    );
    const item = await card(s, "reel");
    expect(item.textContent).toContain("Token rechazado");
    expect(item.textContent).toContain("Qué hacer:");
  });
});

describe("programar el canal", () => {
  it("programa el canal y dice para cuándo", async () => {
    const s = await publicationSetup();
    const section = await s.open();
    const at = inHours(4);

    fireEvent.click(await within(section).findByRole("button", { name: "Programar Instagram" }));
    submitAt(section, at, /^Programar Instagram/);

    expect((await within(section).findByText(/Programado para el/)).textContent).toContain(
      formatChileTime(at),
    );
    expect(s.t.publications.all().every((p) => p.status === "scheduled")).toBe(true);
  });
});

describe("Portal: Actualizar aviso, Republicar y vencimiento", () => {
  async function portal(
    publishMode: "dry-run" | "live",
    options: { closed?: boolean; stopInDays?: number } = {},
  ) {
    const s = await publicationSetup({ platform: "portal_inmobiliario", publishMode });
    const id = s.t.publications.all()[0]?.id ?? "";
    const live = publishMode === "live";
    await s.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: !live } },
      { actor: "system" },
    );
    const remoteState = {
      status: options.closed ? "closed" : "active",
      subStatus: options.closed ? ["expired"] : [],
      stopTime: new Date(Date.now() + (options.stopInDays ?? 120) * 24 * HOUR).toISOString(),
      expirationTime: null,
      checkedAt: new Date().toISOString(),
    };
    await s.t.publications.transition(
      id,
      {
        from: "publishing",
        to: "published",
        changes: {
          externalId: live ? "MLC1234567890" : `dry-run:${id}`,
          ...(live ? { remoteState } : {}),
        },
      },
      { actor: "system" },
    );
    if (options.closed) {
      await s.t.publications.transition(
        id,
        { from: "published", to: "unpublished", changes: live ? { remoteState } : {} },
        { actor: "system" },
      );
    }
    return { s, id };
  }

  it("Actualizar aviso sin cambios lo explica (409)", async () => {
    const { s } = await portal("dry-run");
    const item = await card(s, "aviso", /Portal Inmobiliario/);

    fireEvent.click(within(item).getByRole("button", { name: /Actualizar el aviso del aviso/ }));

    expect((await within(item).findByRole("alert")).textContent).toContain(
      "PORTAL_NOTHING_TO_UPDATE",
    );
  });

  it("Republicar en vivo pide confirmar con el motivo de la API y crea la nueva", async () => {
    const { s, id } = await portal("live", { closed: true, stopInDays: -1 });
    const section = await s.open();
    fireEvent.click(await within(section).findByRole("tab", { name: /Portal Inmobiliario/ }));
    fireEvent.click(await within(section).findByText(/Descartadas y retiradas/));
    const item = await within(section).findByRole("article", { name: "Publicación aviso" });
    expect(item.textContent).toContain("El aviso venció: republícalo.");

    fireEvent.click(within(item).getByRole("button", { name: "Republicar el aviso" }));
    fireEvent.click(await within(item).findByRole("button", { name: "Sí, republicar en vivo" }));

    await waitFor(() =>
      expect(s.t.publications.all().some((p) => p.relistedFrom === id)).toBe(true),
    );
  });

  it("vence en N días", async () => {
    const { s } = await portal("live", { stopInDays: 3 });
    const item = await card(s, "aviso", /Portal Inmobiliario/);
    expect(item.textContent).toMatch(/Vence en [23] días/);
  });
});

describe("programar seleccionadas (lista de propiedades)", () => {
  it("programa las elegidas y dice qué pasó con cada una, también la que no se pudo", async () => {
    const s = await publicationSetup();
    const listing = await s.t.listings.get(s.t.listingId);
    if (listing === null) throw new Error("falta el aviso");
    const { id: _id, status: _s, closeReason: _c, createdAt: _a, updatedAt: _u, ...data } = listing;
    const other = await s.t.listings.create({
      ...data,
      externalRef: "SIN-TEXTO",
      sourceHash: "x",
    } as NewListing);
    await s.t.listings.promoteToReady(other.id);
    s.renderApp("/propiedades");

    fireEvent.click(
      await screen.findByLabelText(`Seleccionar ${listing.externalRef} para programar`),
    );
    fireEvent.click(screen.getByLabelText("Seleccionar SIN-TEXTO para programar"));
    fireEvent.click(screen.getByRole("button", { name: "Programar seleccionadas" }));
    const batch = screen.getByRole("region", { name: "Programar seleccionadas" });
    fireEvent.change(within(batch).getByLabelText("Minutos entre una propiedad y la siguiente"), {
      target: { value: "30" },
    });
    submitAt(batch, inHours(5), /^Programar 2 propiedad/);

    const result = await within(batch).findByRole("status");
    expect(result.textContent).toContain(`${listing.externalRef} · Instagram: programada para el`);
    expect(result.textContent).toContain("SIN-TEXTO");
    expect(result.textContent).toContain("no se programó");
  });
});
