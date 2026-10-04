// @vitest-environment jsdom
import { AppError, RUN_WAIT as WAIT } from "@agentsales/core";
import {
  contentDefinitionsFixture,
  createInMemoryJobQueue,
  createInMemoryLlmProvider,
  LLM_ERRORS,
} from "@agentsales/core/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentSetup,
  createInMemoryFieldDefinitionRepository,
  harness,
} from "../../../test/harness.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** La API en proceso con las mismas definiciones que usa la corrida (la revisión las necesita). */
async function setup(
  options: Parameters<typeof contentSetup>[1] = {},
  harnessOptions: Parameters<typeof harness>[0] = {},
) {
  const h = harness({
    ...harnessOptions,
    deps: {
      fieldDefinitions: createInMemoryFieldDefinitionRepository(contentDefinitionsFixture()),
      ...harnessOptions.deps,
    },
  });
  const content = await contentSetup(h, options);
  /** Una corrida pedida y terminada, como la dejaría el worker. */
  const prepared = async (texts = true) => {
    await h.contentRuns.create({ listingId: content.listing.id, texts });
    await content.prepare();
  };
  const open = async () => {
    h.renderApp(`/propiedades/${content.listing.id}`);
    return screen.findByRole("region", { name: "Contenido" });
  };
  return { ...h, ...content, prepared, open };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

describe("panel: sección Contenido", () => {
  it("sin contenido invita a prepararlo", async () => {
    const t = await setup();
    const section = await t.open();

    expect(
      await within(section).findByText(
        "Todavía no hay contenido. Prepáralo para ver cómo se vería en cada canal.",
      ),
    ).toBeTruthy();
    const prepare = within(section).getByRole("button", { name: "Preparar contenido" });
    expect((prepare as HTMLButtonElement).disabled).toBe(false);
    expect(within(section).queryByRole("tablist")).toBeNull();
  });

  it("una corrida en curso muestra su etapa y, al terminar, la vista previa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await setup();
    const section = await t.open();
    await within(section).findByText(/Todavía no hay contenido/);

    fireEvent.click(within(section).getByRole("button", { name: "Preparar contenido" }));
    expect(await within(section).findByText("Preparando: en cola…")).toBeTruthy();
    const run = await t.contentRuns.latest(t.listing.id);
    expect(run).toMatchObject({ status: "queued", texts: true });
    // Mientras corre, no se puede pedir otra.
    expect(
      (within(section).getByRole("button", { name: "Preparar contenido" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await t.contentRuns.markRunning(run?.id ?? "");
    await t.contentRuns.setStage(run?.id ?? "", "renders");
    await advance(WAIT.pollMs);
    expect(
      await within(section).findByText("Preparando: armando la portada y la ficha…"),
    ).toBeTruthy();
    const stages = within(section).getByRole("list", { name: "Etapas" });
    expect(within(stages).getByText(/procesando fotos y videos/).textContent).toMatch(/^✓/);

    await t.prepare();
    await advance(WAIT.pollMs);
    expect(await within(section).findByRole("tablist", { name: "Canales" })).toBeTruthy();
    expect(within(section).queryByText(/Preparando/)).toBeNull();
    // La galería pasa a usar las miniaturas que armó la corrida.
    await waitFor(() => {
      const photo = screen.getByRole("img", { name: "Foto 1 de P-001" }) as HTMLImageElement;
      expect(photo.src).toContain("/processed/thumb/");
    });
  });

  it("avisa si sigue en cola a los 20 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await setup();
    const section = await t.open();
    await within(section).findByText(/Todavía no hay contenido/);

    fireEvent.click(within(section).getByRole("button", { name: "Rehacer imágenes" }));
    await within(section).findByText("Preparando: en cola…");
    expect(await t.contentRuns.latest(t.listing.id)).toMatchObject({ texts: false });
    await advance(WAIT.queuedWarningMs + WAIT.pollMs);
    expect(
      await within(section).findByText("Sigue en cola: ¿está corriendo el worker? (pnpm dev)"),
    ).toBeTruthy();
  });

  it("una corrida fallida muestra su error en lenguaje simple", async () => {
    const t = await setup();
    await t.contentRuns.create({ listingId: t.listing.id, texts: true });
    // La corrida queda en failed y el error sube al worker, que lo registra.
    await expect(
      t.prepare(createInMemoryLlmProvider([{ error: LLM_ERRORS.authRequired() }])),
    ).rejects.toMatchObject({ code: "LLM_AUTH_REQUIRED" });

    const section = await t.open();
    const alert = await within(section).findByText("La última preparación falló");
    const box = alert.parentElement as HTMLElement;
    expect(within(box).getByText(/La CLI de Claude no tiene sesión/)).toBeTruthy();
    expect(within(box).getByText("Código: LLM_AUTH_REQUIRED")).toBeTruthy();
    // Las imágenes alcanzaron a armarse: se ven aunque falten los textos.
    expect(within(section).getByRole("list", { name: "Carrusel de Instagram" })).toBeTruthy();
  });

  it("Instagram: carrusel, caption con ver más, reel y revisión", async () => {
    const t = await setup({ video: true });
    await t.prepared();
    const section = await t.open();

    await within(section).findByRole("tablist", { name: "Canales" });
    expect(tab("Instagram").getAttribute("aria-selected")).toBe("true");
    // Portada, las 2 fotos que no son la de portada y la ficha.
    const carousel = within(section).getByRole("list", { name: "Carrusel de Instagram" });
    expect(within(carousel).getAllByRole("img")).toHaveLength(4);
    expect(within(section).getByLabelText("Reel de Instagram")).toBeTruthy();

    const caption = () => within(section).getByRole("region", { name: "Caption de Instagram" });
    expect(caption().textContent).toMatch(/…ver más$/);
    fireEvent.click(within(section).getByRole("button", { name: "ver más" }));
    expect(caption().textContent).toContain("#");
    expect(
      within(
        within(section).getByRole("region", { name: "Revisión editorial de Instagram" }),
      ).getByText("✓ Revisión editorial sin problemas"),
    ).toBeTruthy();
  });

  it("Portal y Marketplace: título, descripción y fotos 4:3", async () => {
    const t = await setup();
    await t.prepared();
    const section = await t.open();
    await within(section).findByRole("tablist", { name: "Canales" });

    fireEvent.click(tab("Portal Inmobiliario"));
    const portal = within(section).getByRole("tabpanel");
    expect(within(portal).getByRole("heading", { name: /en venta .* en Ñuñoa/ })).toBeTruthy();
    expect(within(portal).getByText(/Características:/)).toBeTruthy();
    expect(within(portal).getAllByRole("img", { name: /para Portal Inmobiliario/ })).toHaveLength(
      3,
    );

    fireEvent.click(tab("Facebook Marketplace"));
    const marketplace = within(section).getByRole("tabpanel");
    expect(
      within(marketplace).getAllByRole("img", { name: /para Facebook Marketplace/ }),
    ).toHaveLength(3);
    expect(within(marketplace).getByText(/\+56911112222/)).toBeTruthy();
  });

  it("la revisión muestra errores en rojo y advertencias en ámbar, y marca la pestaña", async () => {
    const t = await setup();
    await t.prepared();
    const [, portal] = await t.contents.listCurrent(t.listing.id);
    await t.contents.update(portal?.id ?? "", {
      body: "Un departamento increíble en Calle Inventada 123.",
    });
    const section = await t.open();
    await within(section).findByRole("tablist", { name: "Canales" });

    expect(tab("Portal Inmobiliario").textContent).toContain("(la revisión tiene errores)");
    expect(tab("Instagram").textContent).not.toContain("errores");
    fireEvent.click(tab("Portal Inmobiliario"));
    const checks = within(section).getByRole("region", {
      name: "Revisión editorial de Portal Inmobiliario",
    });
    const items = within(checks).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.split(":")[0])).toEqual(
      expect.arrayContaining(["Error", "Advertencia"]),
    );
    expect(items.find((item) => item.textContent?.startsWith("Error"))?.className).toContain("red");
    expect(items.find((item) => item.textContent?.startsWith("Advertencia"))?.className).toContain(
      "amber",
    );
  });

  it("con textos editados a mano pregunta antes de reemplazarlos", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await setup();
    await t.prepared();
    const [instagram] = await t.contents.listCurrent(t.listing.id);
    await t.contents.update(instagram?.id ?? "", { body: "Lo escribí yo.", status: "edited" });
    const section = await t.open();
    await within(section).findByRole("tablist", { name: "Canales" });

    fireEvent.click(within(section).getByRole("button", { name: "Preparar contenido" }));
    expect(await within(section).findByText("Hay textos editados a mano")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Rehacer solo imágenes" }));

    await within(section).findByText("Preparando: en cola…");
    expect(await t.contentRuns.latest(t.listing.id)).toMatchObject({
      status: "queued",
      texts: false,
    });
    expect(within(section).queryByText("Hay textos editados a mano")).toBeNull();
  });

  it("una propiedad en borrador no deja preparar y explica por qué", async () => {
    const t = await setup();
    t.listings.setStatus(t.listing.id, "draft");
    const section = await t.open();

    expect(within(section).getByText(/tiene que estar lista, pausada o publicada/)).toBeTruthy();
    expect(
      (within(section).getByRole("button", { name: "Preparar contenido" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('con textos editados, "Reemplazar mis textos" pide la corrida con replaceEdits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await setup();
    await t.prepared();
    const [instagram] = await t.contents.listCurrent(t.listing.id);
    await t.contents.update(instagram?.id ?? "", { body: "Lo escribí yo.", status: "edited" });
    const section = await t.open();
    await within(section).findByRole("tablist", { name: "Canales" });

    fireEvent.click(within(section).getByRole("button", { name: "Preparar contenido" }));
    fireEvent.click(await within(section).findByRole("button", { name: "Reemplazar mis textos" }));
    await within(section).findByText("Preparando: en cola…");
    expect(await t.contentRuns.latest(t.listing.id)).toMatchObject({ texts: true });

    await t.prepare();
    await advance(WAIT.pollMs);
    await waitFor(async () => {
      const [current] = await t.contents.listCurrent(t.listing.id);
      expect(current?.status).toBe("draft");
    });
  });

  it("al abrir con una corrida en curso la muestra y no deja pedir otra", async () => {
    const t = await setup();
    const run = await t.contentRuns.create({ listingId: t.listing.id, texts: true });
    await t.contentRuns.markRunning(run.id);
    await t.contentRuns.setStage(run.id, "media");
    const section = await t.open();

    expect(await within(section).findByText("Preparando: procesando fotos y videos…")).toBeTruthy();
    expect(
      (within(section).getByRole("button", { name: "Preparar contenido" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("tras fallas seguidas deja de consultar y deja consultar de nuevo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    const t = await setup(
      {},
      {
        intercept: (_method, path) => {
          if (down && path.startsWith("/content-runs/")) throw new TypeError("fetch failed");
          return undefined;
        },
      },
    );
    const section = await t.open();
    await within(section).findByText(/Todavía no hay contenido/);
    fireEvent.click(within(section).getByRole("button", { name: "Preparar contenido" }));
    await within(section).findByText("Preparando: en cola…");

    down = true;
    await advance(WAIT.pollMs * 10);
    expect(
      await within(section).findByText(
        "Dejé de consultar: la API no respondió varias veces seguidas.",
      ),
    ).toBeTruthy();

    down = false;
    await t.prepare();
    fireEvent.click(within(section).getByRole("button", { name: "Consultar de nuevo" }));
    expect(await within(section).findByRole("tablist", { name: "Canales" })).toBeTruthy();
  });

  it("si no se puede pedir (cola caída), lo explica con su sugerencia", async () => {
    const t = await setup(
      {},
      {
        deps: {
          queue: createInMemoryJobQueue({
            fail: () =>
              new AppError("QUEUE_UNAVAILABLE", "No se pudo conectar a la cola", {
                retriable: true,
              }),
          }),
        },
      },
    );
    const section = await t.open();
    await within(section).findByText(/Todavía no hay contenido/);

    fireEvent.click(within(section).getByRole("button", { name: "Preparar contenido" }));
    expect(await within(section).findByText(/No se pudo conectar a la cola/)).toBeTruthy();
  });

  it("no muestra lo privado del aviso ni el modelo de la IA", async () => {
    const notes = "el dueño acepta bajar hasta cinco mil quinientos";
    const t = await setup({ video: true, internalNotes: notes });
    await t.prepared();
    const section = await t.open();
    await within(section).findByRole("tablist", { name: "Canales" });

    for (const name of ["Instagram", "Portal Inmobiliario", "Facebook Marketplace"]) {
      fireEvent.click(tab(name));
      const text = section.textContent ?? "";
      expect(text).not.toContain("quinientos");
      expect(text).not.toContain("Calle Inventada");
      expect(text).not.toContain("modelo-falso");
    }
    // La galería: miniatura en las fotos y como portada de los videos.
    const video = screen.getByLabelText("Video 4 de P-001") as HTMLVideoElement;
    expect(video.poster).toContain("/processed/thumb/");
  });
});
