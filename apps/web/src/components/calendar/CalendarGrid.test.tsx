// @vitest-environment jsdom
import type { CalendarEntryView } from "@agentsales/api/contracts";
import { chileDateStart } from "@agentsales/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarGrid } from "../../pages/CalendarPage.js";
import { DayPanel } from "./CalendarEntries.js";

afterEach(cleanup);

const DAY = "2026-10-20";

/** Una entrada del día a esa hora de Chile (pasada a UTC con el borde del día). */
const entry = (hour: number, over: Partial<CalendarEntryView> = {}): CalendarEntryView => ({
  publicationId: `pub-${hour}-${over.platform ?? "x"}`,
  kind: "published",
  at: new Date(chileDateStart(DAY).getTime() + hour * 3_600_000),
  platform: "instagram",
  format: "post",
  language: "es",
  status: "published",
  dryRun: true,
  mediaCount: 3,
  schedule: null,
  listingId: "l1",
  postId: null,
  title: `P-${hour}`,
  brokerId: "b1",
  brokerSlug: "corredor",
  externalUrl: null,
  ...over,
});

const renderGrid = (entries: CalendarEntryView[], onOpenDay = vi.fn()) => {
  render(
    <MemoryRouter>
      <CalendarGrid view="mes" anchor={DAY} today={DAY} entries={entries} onOpenDay={onOpenDay} />
    </MemoryRouter>,
  );
  return { day: screen.getByRole("listitem", { name: /martes 20 de octubre/ }), onOpenDay };
};

describe("la grilla del calendario con muchos posts", () => {
  it("con 12 entradas muestra 3, por hora, y «+9 más» abre el día", () => {
    const hours = [20, 9, 15, 11, 8, 13, 17, 10, 12, 14, 16, 18];
    const { day, onOpenDay } = renderGrid(hours.map((hour) => entry(hour)));
    const chips = within(day).getAllByRole("button", { name: /Instagram/ });
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.getAttribute("aria-label")?.slice(0, 5))).toEqual([
      "08:00",
      "09:00",
      "10:00",
    ]);
    fireEvent.click(within(day).getByRole("button", { name: /9 más/ }));
    expect(onOpenDay).toHaveBeenCalledWith(DAY, expect.any(HTMLElement));
  });

  it("con 3 o menos no hay «más»", () => {
    const { day } = renderGrid([entry(9), entry(10), entry(11)]);
    expect(within(day).queryByText(/más$/)).toBeNull();
  });

  it("el estado se dice con palabras y con una forma, no solo con color", () => {
    const { day } = renderGrid([
      entry(9, { status: "failed" }),
      entry(10, { status: "scheduled", kind: "scheduled", schedule: "overdue" }),
      entry(11, { status: "unpublished" }),
    ]);
    const names = within(day)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toContain("falló");
    expect(names[1]).toContain("atrasada");
    expect(names[2]).toContain("retirada");
    expect(day.textContent).toContain("✕");
    expect(day.textContent).toContain("!");
    expect(day.textContent).toContain("⊘");
  });
});

describe("el detalle del día", () => {
  it("lista todo con sus enlaces y se cierra con Escape", () => {
    const onClose = vi.fn();
    const entries = [9, 10, 11, 12, 13].map((hour) =>
      entry(hour, { externalUrl: `https://example.com/p${hour}` }),
    );
    render(
      <MemoryRouter>
        <DayPanel
          day={DAY}
          entries={entries}
          showBroker={false}
          onMove={vi.fn()}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole("dialog", { name: /martes 20 de octubre/ });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
    expect(within(dialog).getAllByRole("link", { name: "Ver" })).toHaveLength(5);
    expect(document.activeElement).toBe(within(dialog).getByRole("heading"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
