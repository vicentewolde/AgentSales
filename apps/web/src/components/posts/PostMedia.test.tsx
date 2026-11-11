// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// ADR-0042: el idioma de cada imagen de un post, en el detalle del post, contra la API real en
// proceso: el selector bajo cada foto, la ayuda y lo que queda guardado.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  const post = await h.deps.posts.create({
    brokerId: brand.id,
    topic: "Una imagen por idioma",
    kind: "image",
    status: "draft",
  });
  for (const [index, name] of ["en", "es"].entries()) {
    await h.deps.media.create({
      listingId: null,
      postId: post.id,
      brokerId: brand.id,
      kind: "image",
      storagePath: `posts/${post.id}/original/${name}.jpg`,
      mime: "image/jpeg",
      bytes: 10,
      checksum: `sha-${name}`,
      sortOrder: index,
      isCover: false,
    });
  }
  h.renderApp(`/contenido/${post.id}`);
  await screen.findByRole("heading", { name: "Una imagen por idioma" });
  return { ...h, post };
}

const languages = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.deps.media.listOriginals({ kind: "post", id: s.post.id })).map(
    (item) => item.language ?? null,
  );

describe("panel: el idioma de cada imagen", () => {
  it("cada foto tiene su selector (Todos, Inglés, Español) y la ayuda dice qué hace en X e Instagram", async () => {
    await setup();
    const first = (await screen.findByRole("combobox", {
      name: "Idioma de la foto 1",
    })) as HTMLSelectElement;
    expect([...first.options].map((option) => option.textContent)).toEqual([
      "Todos",
      "Inglés",
      "Español",
    ]);
    expect(first.value).toBe("");
    expect(screen.getByRole("combobox", { name: "Idioma de la foto 2" })).toBeTruthy();
    expect(
      screen.getByText(
        /en X cada idioma sale con su imagen; en Instagram van juntas en un carrusel/u,
      ),
    ).toBeTruthy();
  });

  it("elegir un idioma lo guarda y la vista se actualiza; «Todos» lo quita", async () => {
    const s = await setup();
    const first = (await screen.findByRole("combobox", {
      name: "Idioma de la foto 1",
    })) as HTMLSelectElement;
    fireEvent.change(first, { target: { value: "en" } });
    await waitFor(async () => expect(await languages(s)).toEqual(["en", null]));
    const second = (await screen.findByRole("combobox", {
      name: "Idioma de la foto 2",
    })) as HTMLSelectElement;
    await waitFor(() => expect(second.disabled).toBe(false));
    fireEvent.change(second, { target: { value: "es" } });
    await waitFor(async () => expect(await languages(s)).toEqual(["en", "es"]));
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Idioma de la foto 1" }) as HTMLSelectElement).value,
      ).toBe("en"),
    );
    const again = screen.getByRole("combobox", { name: "Idioma de la foto 1" });
    await waitFor(() => expect((again as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(again, { target: { value: "" } });
    await waitFor(async () => expect(await languages(s)).toEqual([null, "es"]));
  });
});
