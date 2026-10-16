// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

// F6-T13 (spec F6 §4.8 y §4.10): el interruptor de `auto_publish` y el aviso del banner en el panel, sobre
// la API en proceso.

afterEach(cleanup);

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
