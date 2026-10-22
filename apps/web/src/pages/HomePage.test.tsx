// @vitest-environment jsdom
import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import { AGENDA_KIND_TEXT, formatChileTime } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9.5-T03: la portada «Hoy» con `/agenda` y `/tracking` simulados (el alcance de esas rutas ya
// está probado en la API): los tres bloques, los vacíos, el corredor del selector y que no pide
// nada más. `/estado` sigue con la salud del sistema (D11).

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Item = AgendaResponse["items"][number];
const item = (extra: Partial<Item>): Item => ({
  kind: "upcoming",
  action: "none",
  listingId: "l1",
  postId: null,
  externalRef: "P-001",
  title: "P-001",
  accountId: null,
  brokerSlug: null,
  platform: "instagram",
  format: "post",
  publicationId: "p1",
  at: new Date(Date.now() + 2 * HOUR),
  dryRun: true,
  modeFixed: true,
  mediaCount: 1,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
  ...extra,
});

type Cell = TrackingResponse["rows"][number]["cells"]["instagram"][number];
const cell = (extra: Partial<Cell>): Cell => ({
  id: "c",
  format: "post",
  language: "es",
  status: "published",
  dryRun: false,
  modeFixed: true,
  mediaCount: 1,
  externalUrl: null,
  scheduledAt: null,
  schedule: null,
  expiry: null,
  lastError: null,
  errorAdvice: null,
  manualTask: false,
  publishedAt: null,
  updatedAt: new Date(),
  ...extra,
});

const ago = (ms: number) => new Date(Date.now() - ms);

const agenda: AgendaResponse = {
  items: [
    item({
      kind: "outcome_unknown",
      action: "resolve",
      listingId: null,
      postId: "post-1",
      title: "Bastidores de la semana",
      externalRef: null,
      platform: "x",
      publicationId: "p-x",
      at: ago(HOUR),
    }),
    item({
      kind: "failed",
      action: "retry",
      publicationId: "p-fail",
      code: "IG_AUTH_INVALID",
      advice: "Vuelve a conectar la cuenta",
      at: ago(2 * HOUR),
    }),
    // Sin consejo: el código, como error.
    item({
      kind: "stuck",
      action: "requeue",
      publicationId: "p-stuck",
      listingId: "l4",
      externalRef: "P-004",
      title: "P-004",
      code: "SIN_CONSEJO",
      at: ago(3 * HOUR),
    }),
    item({
      kind: "needs_review",
      action: "review",
      listingId: "l2",
      externalRef: "P-002",
      title: "P-002",
      platform: "portal_inmobiliario",
      publicationId: null,
      at: null,
    }),
    item({
      kind: "token_expiring",
      action: "reconnect",
      listingId: null,
      externalRef: null,
      title: "@corredor",
      accountId: "acc-1",
      platform: "instagram",
      publicationId: null,
      daysLeft: 3,
      at: new Date(Date.now() + 3 * DAY),
    }),
    item({
      kind: "upcoming",
      publicationId: "p-later",
      externalRef: "P-003",
      title: "P-003",
      listingId: "l3",
      at: new Date(Date.now() + 3 * DAY),
    }),
    item({
      kind: "upcoming",
      publicationId: "p-soon",
      listingId: null,
      postId: "post-2",
      title: "Consejos para vender",
      externalRef: null,
      platform: "linkedin",
      at: new Date(Date.now() + 2 * HOUR),
    }),
    // El respaldo al día no pide nada: no entra en «Te toca».
    item({
      kind: "backup",
      action: "none",
      listingId: null,
      externalRef: null,
      title: null,
      platform: null,
      format: null,
      publicationId: null,
      dryRun: null,
      at: ago(HOUR),
    }),
  ],
};

const listingRow = (
  id: string,
  externalRef: string,
  instagram: Cell[],
): TrackingResponse["rows"][number] => ({
  listing: {
    id,
    brokerId: "b",
    externalRef,
    status: "active",
    closeReason: null,
    operation: "sale",
    propertyType: null,
    comuna: null,
  },
  coverUrl: null,
  cells: { instagram, portal_inmobiliario: [], fb_marketplace: [] },
});

const tracking: TrackingResponse = {
  rows: [
    listingRow("l1", "P-001", [
      cell({
        id: "pub-ig",
        publishedAt: ago(DAY),
        externalUrl: "https://www.instagram.com/p/abc/",
      }),
      // Hace más de 7 días: fuera.
      cell({ id: "pub-old", format: "reel", publishedAt: ago(10 * DAY) }),
    ]),
    // Sin `publishedAt` o sin publicar: fuera.
    listingRow("l2", "P-002", [
      cell({ id: "pub-none", status: "approved" }),
      cell({ id: "pub-unpub", status: "unpublished", publishedAt: ago(DAY) }),
    ]),
  ],
  posts: [
    {
      post: {
        id: "post-3",
        brokerId: "b",
        topic: "Lo que aprendí",
        status: "ready",
        kind: "text",
        plannedAt: null,
      },
      cells: {
        instagram: [],
        // Un enlace que no es `https` no se vuelve enlace.
        x: [
          cell({
            id: "pub-x",
            dryRun: true,
            publishedAt: ago(2 * HOUR),
            externalUrl: "javascript:alert(1)",
          }),
        ],
        linkedin: [],
        discord: [],
        tiktok: [],
      },
    },
  ],
};

function setup(responses: { agenda: AgendaResponse; tracking: TrackingResponse }) {
  return harness({
    intercept: (method, path) => {
      if (method !== "GET") return undefined;
      if (path === "/agenda" || path.startsWith("/agenda?")) return Response.json(responses.agenda);
      if (path === "/tracking" || path.startsWith("/tracking?"))
        return Response.json(responses.tracking);
      return undefined;
    },
  });
}

const block = (name: string) => screen.getByRole("region", { name });
const figure = (label: string) =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("la portada Hoy (F9.5-T03)", () => {
  it("muestra lo que te toca, lo próximo y lo publicado hace poco, con sus enlaces", async () => {
    setup({ agenda, tracking }).renderApp("/");

    const todo = await screen.findByRole("region", { name: "Te toca" });
    await within(todo).findByText("Bastidores de la semana", { exact: false });
    const todoItems = within(todo).getAllByRole("listitem");
    expect(todoItems).toHaveLength(5);
    // Cada una con su insignia y su enlace al detalle.
    expect(
      within(todoItems[0] as HTMLElement).getByText(AGENDA_KIND_TEXT.outcome_unknown),
    ).toBeTruthy();
    expect(
      within(todo)
        .getByRole("link", { name: /Bastidores de la semana/ })
        .getAttribute("href"),
    ).toBe("/contenido/post-1");
    expect(within(todo).getByText(AGENDA_KIND_TEXT.failed)).toBeTruthy();
    // Con consejo, el consejo y no el código; sin consejo, el código.
    expect(within(todo).queryByText(/IG_AUTH_INVALID/)).toBeNull();
    expect(within(todo).getByText("Error: SIN_CONSEJO")).toBeTruthy();
    expect(within(todo).getByText("Vuelve a conectar la cuenta")).toBeTruthy();
    expect(within(todo).getByRole("link", { name: "P-002" }).getAttribute("href")).toBe(
      "/propiedades/l2",
    );
    expect(within(todo).getByText(AGENDA_KIND_TEXT.needs_review)).toBeTruthy();
    expect(within(todo).getByRole("link", { name: "@corredor" }).getAttribute("href")).toBe(
      "/cuentas",
    );
    expect(within(todo).getByText(/vence en 3 días/)).toBeTruthy();
    expect(within(todo).queryByText(/respaldo/i)).toBeNull();

    // Próximas: la más cercana primero, con la hora de Chile y la red.
    const upcoming = block("Próximas");
    const upcomingItems = within(upcoming).getAllByRole("listitem");
    expect(upcomingItems.map((li) => li.querySelector("a")?.textContent)).toEqual([
      "Consejos para vender (post)",
      "P-003",
    ]);
    const soon = agenda.items.find((i) => i.publicationId === "p-soon")?.at as Date;
    expect(upcomingItems[0]?.textContent).toContain(`${formatChileTime(soon)} · LinkedIn`);
    expect(
      within(upcoming)
        .getByRole("link", { name: /Consejos para vender/ })
        .getAttribute("href"),
    ).toBe("/contenido/post-2");

    // Publicado hace poco: solo las publicadas de los últimos 7 días, la más reciente primero.
    const recent = block("Publicado hace poco");
    const recentItems = within(recent).getAllByRole("listitem");
    expect(recentItems.map((li) => li.querySelector("a")?.textContent)).toEqual([
      "Lo que aprendí (post)",
      "P-001",
    ]);
    const external = within(recent).getByRole("link", { name: "Ver en Instagram" });
    expect(external.getAttribute("href")).toBe("https://www.instagram.com/p/abc/");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(within(recent).queryByRole("link", { name: /Ver en X/ })).toBeNull();
    // El modo de cada una: la de X fue una simulación; la de Instagram, en vivo.
    expect(recentItems[0]?.textContent).toContain("simulación");
    expect(recentItems[1]?.textContent).toContain("en vivo");
    expect(recentItems[1]?.textContent).not.toContain("simulación");

    // El resumen de arriba.
    expect(figure("Te toca")).toBe("5");
    expect(figure("Próximas (7 días)")).toBe("2");
    expect(figure("Publicadas en 7 días")).toBe("2");
  });

  it("cada publicación dice su formato: carrusel, reel o imagen (F9.5-T20)", async () => {
    // El mismo aviso con el carrusel y el reel en cada bloque: no son dos filas idénticas.
    const when = new Date(Date.now() + 2 * HOUR);
    const formats = {
      agenda: {
        items: [
          item({ publicationId: "a", format: "post", mediaCount: 5, at: when }),
          item({ publicationId: "b", format: "reel", mediaCount: 1, at: when }),
          item({ publicationId: "c", format: "post", mediaCount: 1, at: when }),
          item({
            kind: "failed",
            action: "retry",
            publicationId: "d",
            format: "reel",
            mediaCount: 1,
            code: "SIN_CONSEJO",
            at: ago(HOUR),
          }),
        ],
      },
      tracking: {
        rows: [
          listingRow("l1", "P-001", [
            cell({ id: "r1", format: "post", mediaCount: 4, publishedAt: ago(HOUR) }),
            cell({ id: "r2", format: "reel", publishedAt: ago(2 * HOUR) }),
          ]),
        ],
        posts: [],
      },
    } satisfies { agenda: AgendaResponse; tracking: TrackingResponse };
    setup(formats).renderApp("/");

    const upcoming = await screen.findByRole("region", { name: "Próximas" });
    const texts = (await within(upcoming).findAllByRole("listitem")).map((li) => li.textContent);
    expect(texts.some((text) => text?.includes("Instagram · carrusel"))).toBe(true);
    expect(texts.some((text) => text?.includes("Instagram · reel"))).toBe(true);
    expect(texts.some((text) => text?.includes("Instagram · imagen"))).toBe(true);

    const todo = block("Te toca");
    expect(todo.textContent).toContain("Instagram · reel");

    const recent = block("Publicado hace poco");
    const recentTexts = within(recent)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(recentTexts[0]).toContain("Instagram · carrusel");
    expect(recentTexts[1]).toContain("Instagram · reel");
  });

  it("sin nada, cada bloque lo dice con un vacío amable", async () => {
    setup({ agenda: { items: [] }, tracking: { rows: [], posts: [] } }).renderApp("/");

    expect(await screen.findByText("Nada pendiente")).toBeTruthy();
    expect(within(block("Próximas")).getByText("Nada programado esta semana")).toBeTruthy();
    expect(within(block("Publicado hace poco")).getByText("Todavía nada esta semana")).toBeTruthy();
    expect(figure("Te toca")).toBe("0");
    expect(figure("Publicadas en 7 días")).toBe("0");
  });

  it("pide solo /agenda y /tracking, con el corredor del selector", async () => {
    const h = setup({ agenda: { items: [] }, tracking: { rows: [], posts: [] } });
    await h.brokers.create(brokerData("mio"));
    h.renderApp("/");

    await screen.findByText("Nada pendiente");
    const selector = (await screen.findByLabelText("Ver corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(selector).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(selector, { target: { value: "mio" } });

    await waitFor(() => {
      expect(h.requests).toContain("GET /agenda?broker=mio");
      expect(h.requests).toContain("GET /tracking?broker=mio");
    });
    // Lo de la portada: la agenda y la matriz (sin `archived`). Lo demás es del marco (la
    // sesión, los corredores del selector y el modo del banner).
    const frame = ["/auth/me", "/brokers", "/health"];
    const page = h.requests.filter(
      (request) => !frame.some((path) => request.startsWith(`GET ${path}`)),
    );
    expect(new Set(page)).toEqual(
      new Set([
        "GET /agenda",
        "GET /tracking",
        "GET /agenda?broker=mio",
        "GET /tracking?broker=mio",
      ]),
    );
  });

  it("«Hoy» es la portada para todos; «Estado» solo en el menú del administrador", async () => {
    const h = setup({ agenda: { items: [] }, tracking: { rows: [], posts: [] } });
    const broker = await h.brokers.create(brokerData("mio"));
    h.signInAsBroker(broker.id);
    h.renderApp("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Hoy" })).toBeTruthy();
    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    expect(within(menu).getByRole("link", { name: "Hoy" }).getAttribute("href")).toBe("/");
    await within(menu).findByRole("link", { name: "Mi marca" });
    expect(within(menu).queryByRole("link", { name: "Estado" })).toBeNull();
  });

  it("/estado sigue mostrando la salud del sistema (D11)", async () => {
    harness().renderApp("/estado");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Estado del sistema" }),
    ).toBeTruthy();
    await screen.findByRole("region", { name: "Base de datos" });
  });
});
