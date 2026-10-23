// @vitest-environment jsdom
import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9.5-T26: la bienvenida de «Hoy» (el saludo por nombre en hora de Chile, la frase del día y la
// portada de una propiedad, o la ilustración), con lo que ya traen `/agenda` y `/tracking`.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Cell = TrackingResponse["rows"][number]["cells"]["instagram"][number];
const published = (id: string, publishedAt: Date): Cell => ({
  id,
  format: "post",
  language: "es",
  status: "published",
  dryRun: true,
  modeFixed: true,
  mediaCount: 1,
  externalUrl: null,
  scheduledAt: null,
  schedule: null,
  expiry: null,
  lastError: null,
  errorAdvice: null,
  manualTask: false,
  publishedAt,
  updatedAt: publishedAt,
});

const row = (coverUrl: string | null, cells: Cell[]): TrackingResponse["rows"][number] => ({
  listing: {
    id: "l1",
    brokerId: "b",
    externalRef: "P-001",
    status: "active",
    closeReason: null,
    operation: "sale",
    propertyType: "Departamento",
    comuna: "Providencia",
  },
  coverUrl,
  cells: { instagram: cells, portal_inmobiliario: [], fb_marketplace: [] },
});

async function setup(tracking: TrackingResponse, agenda: AgendaResponse = { items: [] }) {
  const h = harness({
    intercept: (method, path) => {
      if (method !== "GET") return undefined;
      if (path === "/agenda" || path.startsWith("/agenda?")) return Response.json(agenda);
      if (path === "/tracking" || path.startsWith("/tracking?")) return Response.json(tracking);
      return undefined;
    },
  });
  const broker = await h.brokers.create(brokerData("mio"));
  h.signInAsBroker(broker.id);
  return h;
}

describe("la bienvenida de Hoy (F9.5-T26)", () => {
  it("saluda por el nombre en hora de Chile y resume el día", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:30:00-03:00"));
    const h = await setup({ rows: [], posts: [] });
    h.renderApp("/");

    expect(await screen.findByText("Buenas tardes, Corredor")).toBeTruthy();
    expect(
      await screen.findByText(
        "Hoy no tienes nada pendiente. En los próximos 7 días no hay nada programado.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Jueves,? 22 de octubre$/)).toBeTruthy();
  });

  it("la portada de una propiedad da la bienvenida, con su nombre como texto alternativo", async () => {
    const h = await setup({ rows: [row("https://r2.test/portada.jpg", [])], posts: [] });
    h.renderApp("/");

    const cover = await screen.findByRole("img", { name: "Departamento en Providencia" });
    expect(cover.getAttribute("src")).toBe("https://r2.test/portada.jpg");
    expect(screen.getByText("Departamento en Providencia · Publicada")).toBeTruthy();
  });

  it("sin portadas, la ilustración de hogar (decorativa)", async () => {
    const h = await setup({ rows: [row(null, [])], posts: [] });
    h.renderApp("/");

    expect(
      await screen.findByText(
        "Cuando cargues una propiedad con fotos, su portada te da la bienvenida aquí.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Departamento en Providencia" })).toBeNull();
  });

  it("cada publicación reciente lleva su insignia de publicada", async () => {
    const h = await setup({
      rows: [row(null, [published("a", new Date(Date.now() - 60_000))])],
      posts: [],
    });
    h.renderApp("/");

    const recent = await screen.findByRole("region", { name: "Publicado hace poco" });
    const items = await within(recent).findAllByRole("listitem");
    expect(within(items[0] as HTMLElement).getByText("Publicada")).toBeTruthy();
  });

  it("no pide nada más que /agenda y /tracking (más el marco)", async () => {
    const h = await setup({ rows: [row("https://r2.test/portada.jpg", [])], posts: [] });
    h.renderApp("/");

    await screen.findByRole("img", { name: "Departamento en Providencia" });
    await waitFor(() => expect(h.requests).toContain("GET /tracking"));
    // El corredor ve lo suyo por su sesión, sin elegir: la portada no pide listados ni medios.
    const frame = ["/auth/me", "/brokers", "/health"];
    const page = h.requests.filter(
      (request) => !frame.some((path) => request.startsWith(`GET ${path}`)),
    );
    expect(new Set(page)).toEqual(new Set(["GET /agenda", "GET /tracking"]));
  });
});
