// @vitest-environment jsdom
import type { AgendaResponse } from "@agentsales/api/contracts";
import { AGENDA_KIND_TEXT } from "@agentsales/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSetup } from "../../test/harness.js";
import { Agenda } from "./TrackingPage.js";

// F6-T13 (spec F6 §4.8 a §4.10): Seguimiento, las acciones de la propiedad y `auto_publish` en el
// panel, sobre la API en proceso.

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

type Item = AgendaResponse["items"][number];
const item = (extra: Partial<Item>): Item => ({
  kind: "upcoming",
  action: "none",
  listingId: "l1",
  externalRef: "P1",
  platform: "instagram",
  format: "post",
  publicationId: "p1",
  at: new Date("2026-10-19T13:00:00.000Z"),
  dryRun: true,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
  ...extra,
});

describe("la agenda", () => {
  it("muestra las clases en su orden, con el consejo y el respaldo", () => {
    render(
      <MemoryRouter>
        <Agenda
          items={[
            item({ kind: "failed", action: "retry", code: "IG_AUTH_INVALID", advice: "Reconecta" }),
            item({ kind: "overdue", action: "publish", publicationId: "p2" }),
            item({
              kind: "backup",
              action: "backup",
              listingId: null,
              externalRef: null,
              platform: null,
              format: null,
              publicationId: null,
              at: null,
              dryRun: null,
              stale: true,
            }),
            item({ kind: "upcoming", publicationId: "p3" }),
          ]}
        />
      </MemoryRouter>,
    );

    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      `${AGENDA_KIND_TEXT.overdue} (1)`,
      `${AGENDA_KIND_TEXT.failed} (1)`,
      `${AGENDA_KIND_TEXT.upcoming} (1)`,
      `${AGENDA_KIND_TEXT.backup} (1)`,
    ]);
    const failed = screen.getByRole("region", { name: AGENDA_KIND_TEXT.failed });
    expect(failed.textContent).toContain("IG_AUTH_INVALID");
    expect(failed.textContent).toContain("Reconecta");
    const backup = screen.getByRole("region", { name: AGENDA_KIND_TEXT.backup });
    expect(backup.textContent).toContain("nunca");
    expect(backup.textContent).toContain("más de 48 h");
  });
});

describe("la página Seguimiento", () => {
  it("muestra la agenda y la matriz, con enlace al detalle", async () => {
    const s = await publicationSetup();
    const listing = await s.t.listings.get(s.t.listingId);
    await s.t.publications.transition(
      s.t.byFormat("post")?.id ?? "",
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt: new Date(Date.now() + 5 * HOUR) },
      },
      { actor: "operator" },
    );
    s.renderApp("/seguimiento");

    const upcoming = await screen.findByRole("region", { name: AGENDA_KIND_TEXT.upcoming });
    expect(upcoming.textContent).toContain(listing?.externalRef ?? "");
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: new RegExp(listing?.externalRef ?? "") });
    expect(row.textContent).toContain("programada");
    expect(
      within(row)
        .getByRole("link", { name: listing?.externalRef ?? "" })
        .getAttribute("href"),
    ).toBe(`/propiedades/${s.t.listingId}`);
  });
});

describe("acciones de la propiedad", () => {
  it("pausar con algo programado muestra el motivo de la API y, al confirmar, pausa y dice qué cambió", async () => {
    const s = await publicationSetup();
    await s.t.publications.transition(
      s.t.byFormat("post")?.id ?? "",
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt: new Date(Date.now() + 5 * HOUR) },
      },
      { actor: "operator" },
    );
    s.renderApp(`/propiedades/${s.t.listingId}`);

    const group = await screen.findByRole("group", { name: "Acciones de la propiedad" });
    fireEvent.click(within(group).getByRole("button", { name: "Pausar" }));
    const confirm = await screen.findByText(/Pausar la propiedad pausa su aviso de Portal/);
    expect(confirm).toBeTruthy();
    expect((await s.t.listings.get(s.t.listingId))?.status).toBe("ready");

    fireEvent.click(screen.getByRole("button", { name: "Sí, pausar" }));

    const result = await screen.findByText(/La propiedad quedó pausada/);
    expect(result.closest("[role=status]")?.textContent).toContain("Instagram carrusel: aprobada");
    expect(s.t.byFormat("post")?.status).toBe("approved");
  });

  it("vendida confirma siempre y deja en vivo Instagram como tarea a mano", async () => {
    const s = await publicationSetup({ publishMode: "live" });
    const post = s.t.byFormat("post")?.id ?? "";
    await s.t.publications.transition(
      post,
      { from: "approved", to: "publishing", changes: { dryRun: false } },
      { actor: "system" },
    );
    await s.t.publications.transition(
      post,
      { from: "publishing", to: "published", changes: { externalId: "ig-1" } },
      { actor: "system" },
    );
    await s.t.listings.changeStatus(s.t.listingId, "ready", "active");
    s.renderApp(`/propiedades/${s.t.listingId}`);

    const group = await screen.findByRole("group", { name: "Acciones de la propiedad" });
    fireEvent.click(within(group).getByRole("button", { name: "Vendida" }));
    expect(screen.getByText(/¿Marcar la propiedad como vendida\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sí, vendida" }));

    const tasks = await screen.findByText("Tareas a mano");
    expect(tasks.parentElement?.textContent).toContain("Instagram carrusel");
    expect(await s.t.listings.get(s.t.listingId)).toMatchObject({
      status: "closed",
      closeReason: "sold",
    });
  });
});

describe("auto_publish en Cuentas y el aviso en vivo", () => {
  it("activarlo pide confirmar en rojo con la API en vivo; después el banner lo destaca", async () => {
    const s = await publicationSetup({ publishMode: "live" });
    s.renderApp("/cuentas");

    const toggle = await screen.findByRole("checkbox", { name: /Publicación automática/ });
    fireEvent.click(toggle);
    expect((await screen.findByText(/publicará sin tu revisión/)).textContent).toContain(
      "La API está en vivo",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sí, activar" }));

    await waitFor(async () => {
      const listing = await s.t.listings.get(s.t.listingId);
      expect((await s.t.brokers.findById(listing?.brokerId ?? ""))?.autoPublish).toBe(true);
    });
    expect(
      await screen.findByText(/Publicación automática EN VIVO: publica sin tu revisión/),
    ).toBeTruthy();

    fireEvent.click(await screen.findByRole("checkbox", { name: /Publicación automática/ }));
    await waitFor(async () => {
      const listing = await s.t.listings.get(s.t.listingId);
      expect((await s.t.brokers.findById(listing?.brokerId ?? ""))?.autoPublish).toBe(false);
    });
  });
});
