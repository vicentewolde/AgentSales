// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// F9.7 B5 y B7: «Láminas» en el detalle de un carrusel: editar los textos y el enlace del PDF.

afterEach(cleanup);

describe("Láminas en el detalle del post", () => {
  it("edita la portada, ve la revisión y ofrece el PDF para LinkedIn", async () => {
    const h = harness();
    const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
    const post = await h.deps.posts.create({
      brokerId: brand.id,
      topic: "Tema",
      kind: "carousel",
      status: "draft",
    });
    h.renderApp(`/contenido/${post.id}`);
    const section = await screen.findByRole("region", { name: "Láminas" }, { timeout: 4_000 });
    const group = await within(section).findByRole("group", { name: "Láminas en español" });
    fireEvent.change(within(group).getByLabelText(/Titular/), {
      target: { value: "Con 4.321 clientes" },
    });
    fireEvent.click(within(group).getByRole("button", { name: /Guardar las láminas/ }));
    await waitFor(async () =>
      expect((await h.deps.cardTexts.list(post.id)).map((text) => text.headline)).toEqual([
        "Con 4.321 clientes",
      ]),
    );
    await waitFor(() =>
      expect(
        within(section).getByRole("group", { name: "Láminas en español" }).textContent,
      ).toContain("La cifra «4.321»"),
    );
    const link = within(section).getByRole("link", { name: /Descargar PDF para LinkedIn/ });
    expect(link.getAttribute("href")).toBe(`/api/posts/${post.id}/linkedin-pdf?language=es`);
  });
});
