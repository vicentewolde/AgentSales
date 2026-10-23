// @vitest-environment jsdom
import { emptyEditorialProfileData, type Language, type PostKind } from "@agentsales/core";
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

async function setup(
  options: { kind?: PostKind; keys?: boolean; capUsd?: number; languages?: Language[] } = {},
) {
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
  if (options.languages !== undefined) {
    await h.deps.editorialProfiles.upsert(brand.id, {
      ...emptyEditorialProfileData(),
      languages: options.languages,
    });
  }
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
    expect(
      await within(panel).findByText(/Consiguiendo la imagen \(Tarjetas en español\)/u),
    ).toBeTruthy();
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "card", format: "4:5", language: "es" });
  });

  it("antes de hacer las tarjetas, dice cuántas saldrán y por qué", async () => {
    await setup({ kind: "carousel" });
    const panel = await openPanel();
    expect(await within(panel).findByText("Saldrán 2 tarjetas: portada y cierre.")).toBeTruthy();
  });

  /** Un post con una foto subida por el usuario y dos tarjetas de un pedido anterior. */
  async function withPreviousCards() {
    const s = await setup({ kind: "carousel" });
    const media = (checksum: string, sortOrder: number) =>
      s.deps.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.post.brokerId,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/${checksum}.jpg`,
        mime: "image/jpeg",
        bytes: 10,
        checksum,
        sortOrder,
        isCover: false,
      });
    const upload = await media("u".repeat(64), 0);
    const cards = [await media("c".repeat(64), 1), await media("d".repeat(64), 2)];
    const run = await s.deps.postImageRuns.create({
      postId: s.post.id,
      brokerId: s.post.brokerId,
      source: "card",
      request: { source: "card", format: "4:5" },
      createdBy: null,
    });
    await s.deps.postImageRuns.markRunning(run.id);
    await s.deps.postImageRuns.markSucceeded(
      run.id,
      cards.map((card) => card.id),
    );
    const remaining = async () =>
      (await s.deps.media.listOriginals({ kind: "post", id: s.post.id })).map((item) => item.id);
    return { ...s, upload, remaining };
  }

  it("si el post ya tiene tarjetas, avisa y por defecto pide reemplazarlas (el worker las quita al terminar)", async () => {
    const s = await withPreviousCards();
    const panel = await openPanel();
    expect(await within(panel).findByText(/Este post ya tiene 2 tarjetas/u)).toBeTruthy();
    const box = within(panel).getByRole("checkbox", { name: "Quitar las tarjetas anteriores" });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas" }));
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({
      source: "card",
      format: "4:5",
      language: "es",
      replaceCards: true,
    });
    // Hasta que el worker termina, el post conserva lo que tenía.
    expect(await s.remaining()).toHaveLength(3);
  });

  it("si desmarca la casilla, las tarjetas nuevas se suman y no se quita nada", async () => {
    const s = await withPreviousCards();
    const panel = await openPanel();
    fireEvent.click(
      await within(panel).findByRole("checkbox", { name: "Quitar las tarjetas anteriores" }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas" }));
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
    const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "card", format: "4:5", language: "es" });
    expect(await s.remaining()).toHaveLength(3);
  });

  it("«Solo quitar las tarjetas anteriores» pide confirmación y después las borra sin pedir otras", async () => {
    const s = await withPreviousCards();
    const panel = await openPanel();
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Solo quitar las tarjetas anteriores" }),
    );
    // Antes de confirmar no se borra nada; "Cancelar" lo deja como estaba.
    expect(s.requests).not.toContain(`DELETE /posts/${s.post.id}/images/cards`);
    fireEvent.click(within(panel).getByRole("button", { name: "Cancelar" }));
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    expect(await s.remaining()).toHaveLength(3);

    fireEvent.click(
      within(panel).getByRole("button", { name: "Solo quitar las tarjetas anteriores" }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Sí, quitarlas" }));
    await waitFor(async () => expect(await s.remaining()).toEqual([s.upload.id]));
    expect(s.requests).toContain(`DELETE /posts/${s.post.id}/images/cards`);
    await waitFor(() => expect(within(panel).queryByText(/Este post ya tiene/u)).toBeNull());
    expect(s.requests).not.toContain(`POST /posts/${s.post.id}/images`);
  });

  it("si una publicación ya usa las tarjetas, dice POST_CARDS_IN_USE en simple y no borra nada", async () => {
    const s = await withPreviousCards();
    const mediaIds = await s.remaining();
    await s.deps.postLock.run(s.post.id, ({ publications }) =>
      publications.create(
        {
          postId: s.post.id,
          platformAccountId: "cuenta-1",
          platform: "x",
          format: "post",
          contentId: "texto-1",
          mediaIds,
        },
        { actor: "operator" },
      ),
    );
    const panel = await openPanel();
    // Reemplazar: el pedido se niega de inmediato.
    fireEvent.click(await within(panel).findByRole("button", { name: "Hacer tarjetas" }));
    expect(await within(panel).findByText(/ya están en una publicación aprobada/u)).toBeTruthy();
    expect(await s.deps.postImageRuns.listByPost(s.post.id, 5)).toHaveLength(1);
    // Solo quitar: igual.
    fireEvent.click(
      within(panel).getByRole("button", { name: "Solo quitar las tarjetas anteriores" }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Sí, quitarlas" }));
    await waitFor(() => expect(s.requests).toContain(`DELETE /posts/${s.post.id}/images/cards`));
    expect(
      (await within(panel).findAllByText(/ya están en una publicación aprobada/u)).length,
    ).toBeGreaterThan(0);
    expect(await s.remaining()).toHaveLength(3);
  });

  describe("tarjetas en cada idioma", () => {
    it("con dos idiomas: elige el idioma (el principal primero) y pide las tarjetas de ese idioma", async () => {
      const s = await setup({ kind: "carousel", languages: ["en", "es"] });
      const panel = await openPanel();
      const select = await within(panel).findByRole("combobox", { name: "Idioma de las tarjetas" });
      expect(
        within(select)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["inglés", "español"]);
      // Cada idioma dice cuántas tarjetas saldrían.
      expect(await within(panel).findByText(/Saldrán 2 tarjetas: portada y cierre/u)).toBeTruthy();
      expect(within(panel).getByText(/En español: saldrían 2 tarjetas/u)).toBeTruthy();
      fireEvent.change(select, { target: { value: "es" } });
      fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas en español" }));
      await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
      const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
      expect(run?.request).toEqual({ source: "card", format: "4:5", language: "es" });
      expect(await within(panel).findByText(/Tarjetas en español/u)).toBeTruthy();
    });

    it("«Hacer las tarjetas de cada idioma» pide el primero y deja el otro para después", async () => {
      const s = await setup({ kind: "carousel", languages: ["en", "es"] });
      const panel = await openPanel();
      fireEvent.click(
        await within(panel).findByRole("button", { name: "Hacer las tarjetas de cada idioma" }),
      );
      await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
      const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
      expect(run?.request).toEqual({
        source: "card",
        format: "4:5",
        language: "en",
        thenLanguages: ["es"],
      });
    });

    it("con un solo idioma no hay selector ni botón de cada idioma", async () => {
      await setup({ kind: "carousel", languages: ["es"] });
      const panel = await openPanel();
      expect(await within(panel).findByRole("button", { name: "Hacer tarjetas" })).toBeTruthy();
      expect(within(panel).queryByRole("combobox", { name: "Idioma de las tarjetas" })).toBeNull();
      expect(
        within(panel).queryByRole("button", { name: "Hacer las tarjetas de cada idioma" }),
      ).toBeNull();
    });

    /** Tarjetas en español (dos) y una foto del usuario. */
    async function withSpanishCards(tagged = true) {
      const s = await setup({ kind: "carousel", languages: ["es", "en"] });
      const media = (checksum: string, sortOrder: number) =>
        s.deps.media.create({
          listingId: null,
          postId: s.post.id,
          brokerId: s.post.brokerId,
          kind: "image",
          storagePath: `posts/${s.post.id}/original/${checksum}.jpg`,
          mime: "image/jpeg",
          bytes: 10,
          checksum,
          sortOrder,
          isCover: false,
        });
      const upload = await media("u".repeat(64), 0);
      const cards = [await media("c".repeat(64), 1), await media("d".repeat(64), 2)];
      const run = await s.deps.postImageRuns.create({
        postId: s.post.id,
        brokerId: s.post.brokerId,
        source: "card",
        request: { source: "card", format: "4:5", ...(tagged ? { language: "es" as const } : {}) },
        createdBy: null,
      });
      await s.deps.postImageRuns.markRunning(run.id);
      await s.deps.postImageRuns.markSucceeded(
        run.id,
        cards.map((card) => card.id),
      );
      const remaining = async () =>
        (await s.deps.media.listOriginals({ kind: "post", id: s.post.id })).map((item) => item.id);
      return { ...s, upload, cards, remaining };
    }

    it("las tarjetas de un pedido anterior al idioma se dicen aparte y se rehacen en cualquier idioma", async () => {
      const s = await withSpanishCards(false);
      const panel = await openPanel();
      expect(
        await within(panel).findByText(
          /Este post ya tiene 2 tarjetas de un pedido anterior, sin idioma conocido/u,
        ),
      ).toBeTruthy();
      fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas en español" }));
      await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
      const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
      expect(run?.request).toEqual({
        source: "card",
        format: "4:5",
        language: "es",
        replaceCards: true,
      });
    });

    it("reemplazar cuenta y quita solo las del idioma que se hace", async () => {
      const s = await withSpanishCards();
      const panel = await openPanel();
      // Español (el primero): ya tiene 2.
      expect(
        await within(panel).findByText(/Este post ya tiene 2 tarjetas en español/u),
      ).toBeTruthy();
      fireEvent.change(within(panel).getByRole("combobox", { name: "Idioma de las tarjetas" }), {
        target: { value: "en" },
      });
      // Inglés: no tiene; avisa que las hay en otro idioma y no ofrece quitar las de inglés.
      expect(await within(panel).findByText(/ya tiene tarjetas en otro idioma/u)).toBeTruthy();
      expect(
        within(panel).queryByRole("button", { name: "Solo quitar las tarjetas en inglés" }),
      ).toBeNull();
      fireEvent.click(within(panel).getByRole("button", { name: "Hacer tarjetas en inglés" }));
      await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/images`));
      const [run] = await s.deps.postImageRuns.listByPost(s.post.id, 1);
      // En inglés no hay nada que reemplazar: las de español no se tocan.
      expect(run?.request).toEqual({ source: "card", format: "4:5", language: "en" });
      expect(await s.remaining()).toHaveLength(3);
    });

    it("«Solo quitar las tarjetas en español» quita ese idioma; «Quitar todas» las quita todas", async () => {
      const s = await withSpanishCards();
      const panel = await openPanel();
      fireEvent.click(
        await within(panel).findByRole("button", { name: "Solo quitar las tarjetas en español" }),
      );
      expect(within(panel).getByText(/Las de los otros idiomas se quedan/u)).toBeTruthy();
      fireEvent.click(within(panel).getByRole("button", { name: "Sí, quitarlas" }));
      await waitFor(async () => expect(await s.remaining()).toEqual([s.upload.id]));
    });

    it("un idioma sin texto no se ofrece: el panel dice que falta el texto y solo deja hacer el otro", async () => {
      const s = await setup({ kind: "carousel", languages: ["en", "es"] });
      const drafted = await s.contentRuns.create({ postId: s.post.id, texts: true });
      await s.contentRuns.markRunning(drafted.id);
      await s.contentRuns.markSucceeded(drafted.id, {
        report: { warnings: [] },
        contents: [
          {
            platform: "x",
            language: "es",
            title: null,
            body: "Hola a todos.",
            hashtags: [],
            llmProvider: "fake",
            llmModel: "fake",
            promptVersion: "v",
            rawOutput: null,
          },
        ],
      });
      const panel = await openPanel();
      expect(
        await within(panel).findByRole("button", { name: "Hacer tarjetas en español" }),
      ).toHaveProperty("disabled", false);
      // Inglés no se puede elegir (no hay selector con un solo idioma listo) ni pedir «de cada idioma».
      expect(within(panel).queryByRole("combobox", { name: "Idioma de las tarjetas" })).toBeNull();
      expect(
        within(panel).queryByRole("button", { name: "Hacer las tarjetas de cada idioma" }),
      ).toBeNull();
      expect(
        within(panel).getByText(/hace falta el texto en inglés: pídelo primero/u),
      ).toBeTruthy();
    });

    it("el cuadro de confirmación recibe el foco al abrirse", async () => {
      await withSpanishCards();
      const panel = await openPanel();
      fireEvent.click(
        await within(panel).findByRole("button", { name: "Quitar todas las tarjetas" }),
      );
      const dialog = within(panel).getByRole("alertdialog", {
        name: "Confirmar quitar las tarjetas",
      });
      expect(document.activeElement).toBe(dialog);
    });

    it("«Quitar todas las tarjetas» pide confirmación y quita las de todos los idiomas", async () => {
      const s = await withSpanishCards();
      const panel = await openPanel();
      fireEvent.click(
        await within(panel).findByRole("button", { name: "Quitar todas las tarjetas" }),
      );
      expect(
        within(panel).getByText(/Quitar todas las tarjetas anteriores del post/u),
      ).toBeTruthy();
      fireEvent.click(within(panel).getByRole("button", { name: "Sí, quitarlas" }));
      await waitFor(async () => expect(await s.remaining()).toEqual([s.upload.id]));
    });
  });

  it("un post de video hace el video de las tarjetas (9:16) y no ofrece fotos", async () => {
    await setup({ kind: "video" });
    const panel = await openPanel();
    // Sin el texto redactado no se puede: el botón espera y el panel dice qué falta.
    const button = await within(panel).findByRole("button", {
      name: "Hacer video de las tarjetas",
    });
    expect(button).toHaveProperty("disabled", true);
    expect(within(panel).getByText(/hace falta el texto en español: pídelo primero/u)).toBeTruthy();
    cleanup();
    const t = await setup({ kind: "video" });
    const drafted = await t.contentRuns.create({ postId: t.post.id, texts: true });
    await t.contentRuns.markRunning(drafted.id);
    await t.contentRuns.markSucceeded(drafted.id, {
      report: { warnings: [] },
      contents: [
        {
          platform: "x",
          language: "es",
          title: null,
          body: "Un video. Claves:\n- Mira el mercado\n- Revisa los gastos",
          hashtags: [],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "v",
          rawOutput: null,
        },
      ],
    });
    const ready = await openPanel();
    fireEvent.click(
      await within(ready).findByRole("button", { name: "Hacer video de las tarjetas" }),
    );
    await waitFor(() => expect(t.requests).toContain(`POST /posts/${t.post.id}/images`));
    const [made] = await t.deps.postImageRuns.listByPost(t.post.id, 1);
    expect(made?.request).toEqual({ source: "card", format: "9:16", language: "es" });
    fireEvent.click(within(ready).getByRole("tab", { name: "Biblioteca (Pixabay)" }));
    expect(within(ready).getByText(/Un post de video usa el video de las tarjetas/u)).toBeTruthy();
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
    expect(within(panel).getByText("1 foto: tócala para usarla.").getAttribute("role")).toBe(
      "status",
    );
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

  it("las pestañas se recorren con el teclado (flechas, Inicio y Fin) y solo la activa es tabulable", async () => {
    await setup();
    const panel = await openPanel();
    const tabs = within(panel).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(within(panel).getByRole("tabpanel").getAttribute("tabindex")).toBe("0");
    const [cards, library, ai] = tabs as [HTMLElement, HTMLElement, HTMLElement];
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowRight" });
    expect(document.activeElement).toBe(library);
    expect(library.getAttribute("aria-selected")).toBe("true");
    expect(library.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(library, { key: "End" });
    expect(document.activeElement).toBe(ai);
    fireEvent.keyDown(ai, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cards);
    fireEvent.keyDown(cards, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(ai);
    fireEvent.keyDown(ai, { key: "Home" });
    expect(document.activeElement).toBe(cards);
  });

  it("un post de solo texto no ofrece conseguir imagen", async () => {
    await setup({ kind: "text" });
    expect(screen.queryByRole("button", { name: "Conseguir imagen" })).toBeNull();
  });
});
