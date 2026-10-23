// @vitest-environment jsdom
import type { PostKind } from "@agentsales/core";
import { createFakeStockPhotoProvider } from "@agentsales/core/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// F9.5-T25 (ADR-0038): «Conseguir imagen» en el detalle de un post, contra la API real en proceso:
// sin claves, solo las tarjetas y lo que falta; con la biblioteca, buscar y elegir; con la IA, la
// indicación propuesta y el tope.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const photo = (id: string, tags: string[]) => ({
  id,
  previewUrl: `https://pixabay.com/get/${id}_640.jpg`,
  pageUrl: `https://pixabay.com/photos/${id}/`,
  tags,
  width: 1280,
  height: 1600,
  author: "autora",
});

async function setup(options: { kind?: PostKind; keys?: boolean; capUsd?: number } = {}) {
  const pricing = { priceUsd: 0.04, monthlyCapUsd: options.capUsd ?? 2 };
  const h = harness({
    deps:
      options.keys === true
        ? {
            imageSources: {
              stock: createFakeStockPhotoProvider({
                photos: [photo("1", ["casa", "living"]), photo("2", ["mujer"])],
              }),
              ai: pricing,
            },
            imageAiPricing: pricing,
          }
        : {},
  });
  const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  const post = await h.deps.posts.create({
    brokerId: brand.id,
    topic: "Cómo fijar el precio",
    kind: options.kind ?? "image",
    status: "draft",
  });
  h.renderApp(`/contenido/${post.id}`);
  await screen.findByRole("heading", { name: "Cómo fijar el precio" });
  return { ...h, post };
}

const openPanel = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Conseguir imagen" }));
  return screen.findByRole("region", { name: "Conseguir imagen" });
};

describe("panel: conseguir imagen", () => {
  it("sin claves, ofrece solo las tarjetas y dice qué falta en la biblioteca y la IA", async () => {
    const s = await setup();
    const panel = await openPanel();
    expect(
      within(panel)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Tarjetas de la marca", "Biblioteca (Pixabay)", "Crear con IA"]);
    expect(await within(panel).findByRole("button", { name: "Hacer tarjetas" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "Biblioteca (Pixabay)" }));
    expect(await within(panel).findByText(/falta PIXABAY_API_KEY en el servidor/u)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "Crear con IA" }));
    expect(within(panel).getByText(/falta GEMINI_API_KEY en el servidor/u)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("tab", { name: "Tarjetas de la marca" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas" }));
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
    expect(await within(panel).findByText(/Consiguiendo la imagen \(Tarjetas\)/u)).toBeTruthy();
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "card", format: "4:5" });
  });

  it("un post de video hace el video de las tarjetas (9:16) y no ofrece fotos", async () => {
    const s = await setup({ kind: "video" });
    const panel = await openPanel();
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Hacer video de las tarjetas" }),
    );
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "card", format: "9:16" });
    fireEvent.click(within(panel).getByRole("tab", { name: "Biblioteca (Pixabay)" }));
    expect(within(panel).getByText(/Un post de video usa el video de las tarjetas/u)).toBeTruthy();
  });

  it("con la biblioteca: busca sin personas y elegir una foto la pide por su id", async () => {
    const s = await setup({ keys: true });
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByRole("tab", { name: "Biblioteca (Pixabay)" }));
    const search = await within(panel).findByRole("textbox", { name: "Buscar" });
    expect((search as HTMLInputElement).value).toBe("Cómo fijar el precio");
    fireEvent.change(search, { target: { value: "living" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Buscar" }));
    const results = await within(panel).findByRole("list", { name: "Resultados de la biblioteca" });
    const choices = within(results).getAllByRole("button");
    expect(choices).toHaveLength(1);
    fireEvent.click(choices[0] as HTMLElement);
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "stock", photoId: "1", query: "living", format: "4:5" });
  });

  it("con la IA: propone la indicación y, en el tope del mes, no deja crear", async () => {
    await setup({ keys: true, capUsd: 0.03 });
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByRole("tab", { name: "Crear con IA" }));
    const prompt = await within(panel).findByRole("textbox", { name: /Indicación para la IA/u });
    expect((prompt as HTMLTextAreaElement).value).toContain("Cómo fijar el precio");
    expect(
      within(panel).getByText("Llegaste al tope de imágenes con IA de este mes."),
    ).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Crear imagen" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("un post de solo texto no ofrece conseguir imagen", async () => {
    await setup({ kind: "text" });
    expect(screen.queryByRole("button", { name: "Conseguir imagen" })).toBeNull();
  });
});
