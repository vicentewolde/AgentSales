// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

// F6-T13 (spec F6 §4.8 y §4.10): las acciones de la propiedad y `auto_publish` en el panel, sobre
// la API en proceso.

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

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

  it.each([
    ["paused", "Reanudar", /se reanudó/, "ready"],
    ["closed", "Reabrir", /se reabrió/, "ready"],
    ["closed", "Archivar", /quedó archivada/, "archived"],
  ] as const)("desde %s, %s (sin nada que confirmar)", async (from, button, done, to) => {
    const s = await publicationSetup({ approve: false });
    s.t.listings.setStatus(s.t.listingId, from);
    s.renderApp(`/propiedades/${s.t.listingId}`);

    const group = await screen.findByRole("group", { name: "Acciones de la propiedad" });
    fireEvent.click(within(group).getByRole("button", { name: button }));

    expect(await screen.findByText(done)).toBeTruthy();
    expect((await s.t.listings.get(s.t.listingId))?.status).toBe(to);
  });

  it("arrendada y retirada confirman; cancelar no cambia nada y devuelve el foco", async () => {
    const s = await publicationSetup({ approve: false });
    s.renderApp(`/propiedades/${s.t.listingId}`);

    const group = await screen.findByRole("group", { name: "Acciones de la propiedad" });
    fireEvent.click(within(group).getByRole("button", { name: "Retirada" }));
    expect(screen.getByText(/¿Marcar la propiedad como retirada\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Retirada"));
    expect((await s.t.listings.get(s.t.listingId))?.status).toBe("ready");

    fireEvent.click(screen.getByRole("button", { name: "Arrendada" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, arrendada" }));
    await waitFor(async () =>
      expect(await s.t.listings.get(s.t.listingId)).toMatchObject({
        status: "closed",
        closeReason: "rented",
      }),
    );
  });

  it("un error que no es de confirmar se muestra y deja los botones", async () => {
    const s = await publicationSetup();
    const post = s.t.byFormat("post")?.id ?? "";
    await s.t.publications.transition(
      post,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await s.t.publications.transition(
      post,
      { from: "publishing", to: "published", changes: { externalId: "x" } },
      { actor: "system" },
    );
    s.t.listings.setStatus(s.t.listingId, "paused");
    s.renderApp(`/propiedades/${s.t.listingId}`);

    const group = await screen.findByRole("group", { name: "Acciones de la propiedad" });
    fireEvent.click(within(group).getByRole("button", { name: "Archivar" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "LISTING_HAS_LIVE_PUBLICATIONS",
    );
    expect(screen.getByRole("group", { name: "Acciones de la propiedad" })).toBeTruthy();
  });
});
