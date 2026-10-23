// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { harness } from "../../test/harness.js";

// F9.5-T26: en el celular, el menú principal se abre con «Menú» y se cierra al cambiar de página
// o con Escape. (Sin CSS en jsdom, el menú se ve siempre: se prueba el estado del botón.)

afterEach(cleanup);

function setup() {
  const h = harness({
    intercept: (method, path) => {
      if (method !== "GET") return undefined;
      if (path.startsWith("/agenda")) return Response.json({ items: [] });
      if (path.startsWith("/tracking")) return Response.json({ rows: [], posts: [] });
      return undefined;
    },
  });
  h.renderApp("/");
  return h;
}

const toggle = () =>
  within(screen.getByRole("navigation", { name: "Menú principal" })).getByRole("button", {
    name: "Menú",
  });

describe("el menú del celular (F9.5-T26)", () => {
  it("abre y cierra, y apunta al menú que controla", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Hoy" });
    const button = toggle();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    const controlled = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(controlled).not.toBeNull();
    expect(
      within(controlled as HTMLElement).getByRole("link", { name: "Propiedades" }),
    ).toBeTruthy();
    expect(controlled?.className).toContain("hidden");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(controlled?.className).not.toContain("hidden");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("se cierra con Escape", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Hoy" });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("se cierra al ir a otra página", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Hoy" });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    fireEvent.click(within(menu).getByRole("link", { name: "Propiedades" }));
    await screen.findByRole("heading", { level: 1, name: "Propiedades" });
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("false"));
  });
});
