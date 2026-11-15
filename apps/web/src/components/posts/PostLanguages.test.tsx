// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PostLanguagesField, PostLanguagesNotice, postLanguagesValue } from "./PostLanguages.js";

// «Idiomas de este post» (2026-11-15).

afterEach(cleanup);

const formWith = (...languages: string[]) => {
  const form = new FormData();
  for (const language of languages) form.append("languages", language);
  return form;
};

describe("postLanguagesValue", () => {
  it("igual a los de la marca o sin marcar: null; si no, lo marcado", () => {
    expect(postLanguagesValue(formWith("es"), ["es"])).toBeNull();
    expect(postLanguagesValue(formWith("en", "es"), ["es", "en"])).toBeNull();
    expect(postLanguagesValue(formWith(), ["es"])).toBeNull();
    expect(postLanguagesValue(formWith("es"), ["es", "en"])).toEqual(["es"]);
    expect(postLanguagesValue(formWith("es", "en"), ["es"])).toEqual(["es", "en"]);
  });
});

describe("PostLanguagesField", () => {
  it("marca los idiomas del post o, sin los suyos, los de la marca", () => {
    render(<PostLanguagesField post={{ languages: null }} brandLanguages={["es"]} />);
    expect((screen.getByRole("checkbox", { name: "Español" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: "Inglés" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByText(/los de la marca \(español\)/)).toBeTruthy();
  });
});

describe("PostLanguagesNotice", () => {
  it("dice cuántos textos se ocultaron y cuáles aprobados de un idioma quitado se mantienen", () => {
    render(
      <PostLanguagesNotice
        languages={["es"]}
        hiddenTexts={2}
        contents={[
          { platform: "x", language: "es" },
          { platform: "linkedin", language: "en" },
        ]}
      />,
    );
    expect(screen.getByText(/2 textos ocultos/)).toBeTruthy();
    expect(screen.getByText(/LinkedIn en inglés/)).toBeTruthy();
  });

  it("sin nada oculto ni fuera de idioma, no muestra nada", () => {
    const { container } = render(
      <PostLanguagesNotice languages={["es"]} hiddenTexts={0} contents={[]} />,
    );
    expect(container.textContent).toBe("");
  });
});
