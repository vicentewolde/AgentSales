// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

// F9.5-T22 (ADR-0036): lo que todavía no tiene modo fijado muestra el de su MARCA, y la pregunta de
// «¿publicar en vivo?» sale según la marca (de más si no se sabe, nunca de menos).

afterEach(cleanup);

const item = (format: "carrusel" | "reel") =>
  screen.findByRole("article", { name: `Publicación ${format}` });

async function brandOff() {
  const setup = await publicationSetup({ publishMode: "live" });
  const listing = await setup.t.listings.get(setup.t.listingId);
  const brokerId = listing?.brokerId ?? "";
  await setup.t.brokers.setLiveEnabled(brokerId, false);
  return { setup, brokerId };
}

describe("el modo de la marca en la propiedad (F9.5-T22)", () => {
  it("con el servidor en vivo y la marca apagada: dice «simulación» y publica sin preguntar", async () => {
    const { setup } = await brandOff();
    const section = await setup.open();

    const button = await within(section).findByRole("button", {
      name: "Publicar en Instagram (simulación)",
    });
    expect(within(section).queryByRole("button", { name: /\(en vivo\)/ })).toBeNull();
    expect(within(await item("carrusel")).queryByText("en vivo")).toBeNull();

    fireEvent.click(button);

    await waitFor(() =>
      expect(setup.t.publications.all().every((p) => p.status === "publishing")).toBe(true),
    );
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(setup.t.publications.all().every((p) => p.dryRun)).toBe(true);
  });

  it("si la marca se encendió después de abrir la página, pregunta igual antes de publicar", async () => {
    const { setup, brokerId } = await brandOff();
    const section = await setup.open();
    const button = await within(section).findByRole("button", {
      name: "Publicar en Instagram (simulación)",
    });

    await setup.t.brokers.setLiveEnabled(brokerId, true);
    fireEvent.click(button);

    expect((await within(section).findByRole("alert")).textContent).toContain(
      "se publicará de verdad en Instagram",
    );
    expect(setup.t.queue.jobs).toEqual([]);
  });
});
