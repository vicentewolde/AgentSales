// @vitest-environment jsdom
import type { Publication } from "@agentsales/core";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type Setup = Awaited<ReturnType<typeof publicationSetup>>;

const item = (format: "carrusel" | "reel") =>
  screen.findByRole("article", { name: `Publicación ${format}` });

/** Hace de worker: termina cada una en curso con `published` (y su enlace) o `failed`. */
async function finish(
  t: Setup["t"],
  outcome: (publication: Publication) => "published" | "failed" = () => "published",
) {
  for (const publication of t.publications.all()) {
    if (publication.status !== "publishing") continue;
    await t.publications.transition(
      publication.id,
      outcome(publication) === "published"
        ? {
            from: "publishing",
            to: "published",
            changes: {
              publishedAt: new Date(),
              externalId: `ig-${publication.format}`,
              externalUrl: `https://www.instagram.com/p/${publication.format}/`,
            },
          }
        : {
            from: "publishing",
            to: "failed",
            changes: {
              lastError: {
                code: "IG_MEDIA_REJECTED",
                message: "Instagram rechazó una imagen del carrusel",
                retriable: false,
              },
            },
          },
      { actor: "system" },
    );
  }
}

describe("panel: aprobar", () => {
  it("aprobar el texto de Instagram abre el carrusel y el reel; quitar la aprobación los descarta", async () => {
    const setup = await publicationSetup({ approve: false });
    const section = await setup.open();

    fireEvent.click(await within(section).findByRole("button", { name: "Aprobar Instagram" }));

    expect(await within(section).findByText("Aprobado")).toBeTruthy();
    expect(within(await item("carrusel")).getByText("aprobada")).toBeTruthy();
    expect(within(await item("reel")).getByText("aprobada")).toBeTruthy();
    const events = await setup.t.publications.listEvents(setup.t.byFormat("post")?.id ?? "");
    expect(events[0]?.actor).toBe("operator");

    fireEvent.click(
      await within(section).findByRole("button", { name: "Quitar aprobación de Instagram" }),
    );
    expect(await within(section).findByRole("button", { name: "Aprobar Instagram" })).toBeTruthy();
    expect(setup.t.publications.all().every((p) => p.status === "cancelled")).toBe(true);
    expect(await within(section).findByText("Descartadas y retiradas (2)")).toBeTruthy();
  });

  it("un texto con errores no se aprueba y dice por qué", async () => {
    const setup = await publicationSetup({ approve: false });
    await setup.t.contents.update(await setup.t.instagramId(), {
      body: "Departamento con 99 estacionamientos",
      status: "edited",
    });
    const section = await setup.open();

    const approve = await within(section).findByRole("button", { name: "Aprobar Instagram" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(section).getByText("La revisión tiene errores: corrígelos para poder aprobar."),
    ).toBeTruthy();
  });
});

describe("panel: publicar", () => {
  it("en simulación publica, sondea hasta published y muestra el enlace", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setup = await publicationSetup();
    const section = await setup.open();

    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (simulación)" }),
    );
    expect(within(await item("carrusel")).getByText("publicando")).toBeTruthy();
    expect(setup.t.queue.jobs.map((job) => job.name)).toContain("publication.publish");

    await finish(setup.t);
    await advance(2_000);

    const carrusel = await item("carrusel");
    expect(await within(carrusel).findByText("publicada")).toBeTruthy();
    expect(
      within(carrusel).getByRole("link", { name: "Ver en Instagram" }).getAttribute("href"),
    ).toBe("https://www.instagram.com/p/post/");
    expect(carrusel.textContent).toContain("Simulación: no se envió nada a Instagram.");
    // Con todo publicado, ya no hay nada que publicar.
    expect(within(section).queryByRole("button", { name: /Publicar en Instagram/ })).toBeNull();
  });

  it("una fallida muestra su error y Reintentar la vuelve a publicar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setup = await publicationSetup();
    const section = await setup.open();
    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (simulación)" }),
    );
    await item("carrusel");

    await finish(setup.t, (p) => (p.format === "post" ? "failed" : "published"));
    await advance(2_000);

    const carrusel = await item("carrusel");
    expect(
      await within(carrusel).findByText("Instagram rechazó una imagen del carrusel"),
    ).toBeTruthy();
    fireEvent.click(within(carrusel).getByRole("button", { name: "Reintentar" }));
    expect(await within(await item("carrusel")).findByText("publicando")).toBeTruthy();

    await finish(setup.t);
    await advance(2_000);
    expect(await within(await item("carrusel")).findByText("publicada")).toBeTruthy();
  });

  it("con la API en vivo pide confirmación antes de publicar", async () => {
    const setup = await publicationSetup({ publishMode: "live" });
    const section = await setup.open();

    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (en vivo)" }),
    );
    expect(setup.t.queue.jobs).toEqual([]);
    const confirm = await within(section).findByRole("alert");
    expect(confirm.textContent).toContain("se publicará de verdad en Instagram");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(setup.t.queue.jobs).toEqual([]);

    fireEvent.click(
      within(section).getByRole("button", { name: "Publicar en Instagram (en vivo)" }),
    );
    fireEvent.click(await within(section).findByRole("button", { name: "Sí, publicar en vivo" }));

    expect(await within(await item("carrusel")).findByText("en vivo")).toBeTruthy();
    expect(setup.t.publications.all().every((p) => p.dryRun === false)).toBe(true);
  });

  it("una fallida que empezó en vivo no se reintenta en simulación y dice por qué", async () => {
    const setup = await publicationSetup();
    const id = setup.t.byFormat("post")?.id ?? "";
    await setup.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "system" },
    );
    await setup.t.publications.saveProgress(id, {
      attemptStartedAt: new Date().toISOString(),
      childIds: [],
      containerId: "c-1",
    });
    await setup.t.publications.transition(
      id,
      {
        from: "publishing",
        to: "failed",
        changes: {
          lastError: { code: "IG_UNAVAILABLE", message: "Instagram no respondió", retriable: true },
        },
      },
      { actor: "system" },
    );
    await setup.open();

    const carrusel = await item("carrusel");
    expect(
      (within(carrusel).getByRole("button", { name: "Reintentar" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(carrusel.textContent).toContain("Ya empezó en vivo en Instagram");
  });
});

describe("panel: descartar, retirar y bitácora", () => {
  it("descartar pide confirmación", async () => {
    const setup = await publicationSetup();
    await setup.open();

    const reel = await item("reel");
    fireEvent.click(within(reel).getByRole("button", { name: "Descartar" }));
    fireEvent.click(within(reel).getByRole("button", { name: "No" }));
    expect(setup.t.byFormat("reel")?.status).toBe("approved");

    fireEvent.click(within(await item("reel")).getByRole("button", { name: "Descartar" }));
    fireEvent.click(within(await item("reel")).getByRole("button", { name: "Sí, descartar" }));
    expect(await screen.findByText("Descartadas y retiradas (1)")).toBeTruthy();
    expect(setup.t.byFormat("reel")?.status).toBe("cancelled");
  });

  it("retirar una publicada en vivo exige marcar que se borró a mano", async () => {
    const setup = await publicationSetup();
    const id = setup.t.byFormat("post")?.id ?? "";
    await setup.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "system" },
    );
    await finish(setup.t);
    await setup.open();

    const carrusel = await item("carrusel");
    fireEvent.click(within(carrusel).getByRole("button", { name: "Marcar como retirada" }));
    const confirm = within(carrusel)
      .getAllByRole("button", { name: "Marcar como retirada" })
      .at(-1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(carrusel).getByRole("checkbox"));
    fireEvent.click(confirm as HTMLButtonElement);

    expect(await screen.findByText("Descartadas y retiradas (1)")).toBeTruthy();
    const events = await setup.t.publications.listEvents(id);
    expect(events.at(-1)).toMatchObject({
      toStatus: "unpublished",
      actor: "operator",
      payload: { removedByHand: true },
    });
  });

  it("la bitácora muestra quién hizo cada cambio", async () => {
    const setup = await publicationSetup();
    await setup.open();

    const carrusel = await item("carrusel");
    fireEvent.click(within(carrusel).getByRole("button", { name: "Ver bitácora" }));
    const log = await within(carrusel).findByRole("list", { name: "Bitácora" });
    expect(log.textContent).toContain("panel: nace → aprobada");
  });
});

describe("panel: bloqueos", () => {
  it("con publicaciones pendientes no deja preparar ni editar el texto, y dice por qué", async () => {
    const setup = await publicationSetup();
    const section = await setup.open();

    const prepare = await within(section).findByRole("button", { name: "Preparar contenido" });
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    expect(within(section).getByText(/Hay publicaciones aprobadas que no han salido/)).toBeTruthy();
    const editButtons = within(section).getAllByRole("button", { name: "Editar" });
    expect((editButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(section).getAllByText(/Este texto tiene publicaciones activas/).length,
    ).toBeGreaterThan(0);
  });
});
