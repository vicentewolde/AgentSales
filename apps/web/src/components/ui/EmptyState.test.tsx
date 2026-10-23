// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState.js";
import { ArmchairIllustration, HomeIllustration } from "./illustrations.js";

// F9.5-T26: los estados vacíos con una ilustración de hogar, decorativa para los lectores de
// pantalla (el texto dice qué pasa).

afterEach(cleanup);

describe("EmptyState con ilustración (F9.5-T26)", () => {
  it("por defecto lleva la casa, decorativa", () => {
    const { container } = render(<EmptyState title="Todavía no hay propiedades." />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 160 120");
    expect(screen.getByText("Todavía no hay propiedades.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("acepta otra ilustración y el ícono de lo que falta", () => {
    const { container } = render(
      <EmptyState
        illustration={<ArmchairIllustration className="w-36" />}
        icon={<span data-testid="icono" />}
        title="Todavía nada esta semana"
      />,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.getAttribute("class")).toBe("w-36");
    expect(screen.getByTestId("icono")).toBeTruthy();
  });

  it.each([
    ["la casa", HomeIllustration],
    ["el sillón", ArmchairIllustration],
  ])("%s es decorativa y no toma el foco", (_name, Illustration) => {
    const { container } = render(<Illustration />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });
});
