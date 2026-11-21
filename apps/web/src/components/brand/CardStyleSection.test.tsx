// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCardStyle } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// El pie de las láminas en «Estilo de imágenes» de Mi marca: el sitio y los usuarios de Instagram
// y X se guardan en el estilo; lo vacío sale de la marca o de sus cuentas.

afterEach(cleanup);

describe("Pie de las láminas en Mi marca", () => {
  it("muestra el pie de hoy y guarda el sitio y los usuarios en el estilo", async () => {
    const h = harness();
    const brand = await h.brokers.create(
      { ...brokerData("propia"), instagramHandle: "propia", website: null },
      { kind: "brand" },
    );
    const raw = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../../../../../docs/marca/agentpey/estilo.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const { footer: _, ...withoutFooter } = raw;
    await h.deps.cardStyles.save(brand.id, parseCardStyle(withoutFooter));
    h.signInAsBroker(brand.id);
    h.renderApp("/mi-marca");
    const form = await screen.findByRole("form", { name: "Pie de las láminas" });
    expect(within(form).getByText(/Hoy: Instagram propia\./)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Sitio"), { target: { value: "propia.cl" } });
    fireEvent.change(within(form).getByLabelText("Usuario de X"), {
      target: { value: "propiax" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar el pie" }));
    await waitFor(async () =>
      expect((await h.deps.cardStyles.get(brand.id))?.style.footer).toEqual({
        website: "propia.cl",
        instagram: null,
        x: "propiax",
      }),
    );
    expect(
      await within(form).findByText(/Hoy: propia\.cl · Instagram propia · X propiax\./),
    ).toBeTruthy();
  });
});
