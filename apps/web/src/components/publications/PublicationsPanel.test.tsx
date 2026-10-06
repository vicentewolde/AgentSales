// @vitest-environment jsdom
import { type HealthReport, type Publication, type PublishMode, RUN_WAIT } from "@agentsales/core";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Un poco más que el intervalo de sondeo: alcanza para una consulta más. */
const TICK = RUN_WAIT.pollMs + 500;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type Setup = Awaited<ReturnType<typeof publicationSetup>>;

const item = (format: "carrusel" | "reel") =>
  screen.findByRole("article", { name: `Publicación ${format}` });

const health = (publishMode: PublishMode): Response =>
  Response.json({
    status: "ok",
    publishMode,
    version: "0.0.1",
    checks: {
      db: { ok: true, latencyMs: 1 },
      storage: { ok: true, latencyMs: 1 },
      queue: { ok: true, latencyMs: 1 },
    },
  } satisfies HealthReport);

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

/** Deja el carrusel fallido, pedido en simulación o en vivo (y con progreso si empezó en vivo). */
async function failedPost(t: Setup["t"], options: { live: boolean }) {
  const id = t.byFormat("post")?.id ?? "";
  await t.publications.transition(
    id,
    {
      from: "approved",
      to: "publishing",
      changes: { dryRun: !options.live, incrementAttempts: true },
    },
    { actor: "system" },
  );
  if (options.live) {
    await t.publications.saveProgress(id, {
      attemptStartedAt: new Date().toISOString(),
      childIds: [],
      containerId: "c-1",
    });
  }
  await t.publications.transition(
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
  return id;
}

describe("panel: aprobar", () => {
  it("aprobar el texto de Instagram abre el carrusel y el reel; quitar la aprobación los descarta", async () => {
    const setup = await publicationSetup({ approve: false });
    const section = await setup.open();

    fireEvent.click(await within(section).findByRole("button", { name: "Aprobar Instagram" }));

    expect(await within(section).findByText("Aprobado")).toBeTruthy();
    expect(await within(await item("carrusel")).findByText("aprobada")).toBeTruthy();
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

  it("con una preparación de solo imágenes en curso no se aprueba", async () => {
    const setup = await publicationSetup({ approve: false });
    await setup.t.contentRuns.create({ listingId: setup.t.listingId, texts: false });
    const section = await setup.open();

    const approve = await within(section).findByRole("button", { name: "Aprobar Instagram" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(section).getAllByText("Se está preparando el contenido: espera a que termine.").length,
    ).toBeGreaterThan(0);
  });

  it("no se quita la aprobación con una publicación en curso", async () => {
    const setup = await publicationSetup();
    await setup.t.publications.transition(
      setup.t.byFormat("reel")?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    const section = await setup.open();

    const unapprove = await within(section).findByRole("button", {
      name: "Quitar aprobación de Instagram",
    });
    expect((unapprove as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(section).getByText("Hay una publicación en curso: espera a que termine."),
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
    expect(await within(await item("carrusel")).findByText("publicando")).toBeTruthy();
    expect(setup.t.queue.jobs.map((job) => job.name)).toContain("publication.publish");

    await finish(setup.t);
    await advance(TICK);

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
    await within(await item("carrusel")).findByText("publicando");

    await finish(setup.t, (p) => (p.format === "post" ? "failed" : "published"));
    await advance(TICK);

    const carrusel = await item("carrusel");
    expect(
      await within(carrusel).findByText("Instagram rechazó una imagen del carrusel"),
    ).toBeTruthy();
    fireEvent.click(within(carrusel).getByRole("button", { name: "Reintentar el carrusel" }));
    expect(await within(await item("carrusel")).findByText("publicando")).toBeTruthy();

    await finish(setup.t);
    await advance(TICK);
    expect(await within(await item("carrusel")).findByText("publicada")).toBeTruthy();
  });

  it("con la API en vivo pide confirmación antes de publicar", async () => {
    const setup = await publicationSetup({ publishMode: "live" });
    const section = await setup.open();

    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (en vivo)" }),
    );
    const confirm = await within(section).findByRole("alert");
    expect(confirm.textContent).toContain("se publicará de verdad en Instagram");
    expect(setup.t.queue.jobs).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(setup.t.queue.jobs).toEqual([]);

    fireEvent.click(
      within(section).getByRole("button", { name: "Publicar en Instagram (en vivo)" }),
    );
    fireEvent.click(await within(section).findByRole("button", { name: "Sí, publicar en vivo" }));

    expect(await within(await item("carrusel")).findByText("en vivo")).toBeTruthy();
    expect(setup.t.publications.all().every((p) => p.dryRun === false)).toBe(true);
  });

  it("si la API pasó a vivo después de abrir la página, pide confirmación igual", async () => {
    let mode: PublishMode = "dry-run";
    const setup = await publicationSetup({
      publishMode: "live",
      intercept: (_method, path) => (path === "/health" ? health(mode) : undefined),
    });
    const section = await setup.open();
    const button = await within(section).findByRole("button", {
      name: "Publicar en Instagram (simulación)",
    });

    mode = "live";
    fireEvent.click(button);

    expect((await within(section).findByRole("alert")).textContent).toContain(
      "se publicará de verdad en Instagram",
    );
    expect(setup.t.queue.jobs).toEqual([]);
  });

  it("sin saber el modo de la API no deja publicar", async () => {
    const setup = await publicationSetup({
      intercept: (_method, path) => {
        if (path === "/health") throw new Error("red caída");
        return undefined;
      },
    });
    const section = await setup.open();

    const button = await within(section).findByRole("button", { name: "Publicar en Instagram" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      await within(section).findByText(
        "Todavía no se sabe si la API está en simulación o en vivo.",
      ),
    ).toBeTruthy();
  });

  it("Reintentar con la API en vivo pide confirmación, aunque la fallida fuera una simulación", async () => {
    const setup = await publicationSetup({ publishMode: "live" });
    await failedPost(setup.t, { live: false });
    await setup.open();

    const carrusel = await item("carrusel");
    fireEvent.click(
      await within(carrusel).findByRole("button", { name: "Reintentar el carrusel" }),
    );
    const confirm = await within(carrusel).findByRole("alert");
    expect(confirm.textContent).toContain("se publicará de verdad en Instagram");
    expect(setup.t.queue.jobs).toEqual([]);

    fireEvent.click(within(confirm).getByRole("button", { name: "Sí, reintentar en vivo" }));
    expect(await within(await item("carrusel")).findByText("publicando")).toBeTruthy();
    expect(setup.t.byFormat("post")?.dryRun).toBe(false);
  });

  it("una fallida que empezó en vivo no se reintenta en simulación y dice por qué", async () => {
    const setup = await publicationSetup();
    await failedPost(setup.t, { live: true });
    const section = await setup.open();

    const carrusel = await item("carrusel");
    const retry = await within(carrusel).findByRole("button", { name: "Reintentar el carrusel" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(carrusel.textContent).toContain("Ya empezó en vivo en Instagram");
    // Tampoco el canal entero (la API respondería PUBLISH_MODE_LOCKED).
    const publish = within(section).getByRole("button", {
      name: "Publicar en Instagram (simulación)",
    });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
  });

  it("sin cuenta conectada explica que hay que conectarla en Cuentas", async () => {
    const setup = await publicationSetup({ approve: false });
    await setup.t.platformAccounts.disconnect(setup.t.account?.id ?? "");
    const section = await setup.open();

    fireEvent.click(await within(section).findByRole("button", { name: "Aprobar Instagram" }));
    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (simulación)" }),
    );

    expect((await within(section).findByRole("alert")).textContent).toContain(
      "ACCOUNT_NOT_CONNECTED",
    );
    expect(within(section).getByRole("link", { name: "Cuentas" }).getAttribute("href")).toBe(
      "/cuentas",
    );
  });

  it("Volver a encolar una en curso la vuelve a poner en la cola", async () => {
    const setup = await publicationSetup();
    await setup.t.publications.transition(
      setup.t.byFormat("reel")?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    await setup.open();

    fireEvent.click(
      await within(await item("reel")).findByRole("button", { name: "Volver a encolar el reel" }),
    );

    await vi.waitFor(() =>
      expect(setup.t.queue.jobs.map((job) => job.data)).toEqual([
        { publicationId: setup.t.byFormat("reel")?.id },
      ]),
    );
  });
});

describe("panel: sondeo", () => {
  it("tras 3 fallas seguidas deja de consultar y lo dice; al salir de la página no consulta más", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    const setup = await publicationSetup({
      intercept: (method, path) => {
        if (down && method === "GET" && /^\/publications\/[^/]+$/.test(path)) {
          throw new Error("red caída");
        }
        return undefined;
      },
    });
    const section = await setup.open();
    fireEvent.click(
      await within(section).findByRole("button", { name: "Publicar en Instagram (simulación)" }),
    );
    await within(await item("carrusel")).findByText("publicando");
    // Una consulta buena primero: el aviso de "dejé de consultar" es sobre una publicación ya vista.
    await advance(TICK);

    down = true;
    for (let i = 0; i < 6; i += 1) await advance(TICK);

    expect(
      (await screen.findAllByText(/Dejé de consultar: la API no respondió/)).length,
    ).toBeGreaterThan(0);
    cleanup();
    const before = setup.requests.length;
    await advance(TICK * 3);
    expect(setup.requests.length).toBe(before);
  });
});

describe("panel: descartar, retirar y bitácora", () => {
  it("descartar pide confirmación", async () => {
    const setup = await publicationSetup();
    await setup.open();

    const reel = await item("reel");
    fireEvent.click(await within(reel).findByRole("button", { name: "Descartar el reel" }));
    fireEvent.click(within(reel).getByRole("button", { name: "No" }));
    expect(setup.t.byFormat("reel")?.status).toBe("approved");

    fireEvent.click(
      await within(await item("reel")).findByRole("button", { name: "Descartar el reel" }),
    );
    fireEvent.click(within(await item("reel")).getByRole("button", { name: "Sí, descartar" }));
    expect(await screen.findByText("Descartadas y retiradas (1)")).toBeTruthy();
    expect(setup.t.byFormat("reel")?.status).toBe("cancelled");
  });

  it("retirar una publicada en vivo exige marcar que se borró a mano, y la casilla se reinicia al cancelar", async () => {
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
    const open = async () =>
      fireEvent.click(
        await within(carrusel).findByRole("button", { name: "Marcar como retirado el carrusel" }),
      );
    const confirm = () =>
      within(carrusel).getByRole("button", {
        name: "Sí, marcar como retirada",
      }) as HTMLButtonElement;

    await open();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(within(carrusel).getByRole("checkbox"));
    expect(confirm().disabled).toBe(false);
    fireEvent.click(within(carrusel).getByRole("button", { name: "Cancelar" }));
    await open();
    expect((within(carrusel).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(confirm().disabled).toBe(true);

    fireEvent.click(within(carrusel).getByRole("checkbox"));
    fireEvent.click(confirm());

    expect(await screen.findByText("Descartadas y retiradas (1)")).toBeTruthy();
    const events = await setup.t.publications.listEvents(id);
    expect(events.at(-1)).toMatchObject({
      toStatus: "unpublished",
      actor: "operator",
      payload: { removedByHand: true },
    });
  });

  it("retirar una simulación no pide la casilla", async () => {
    const setup = await publicationSetup();
    const id = setup.t.byFormat("post")?.id ?? "";
    await setup.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    await finish(setup.t);
    await setup.open();

    const carrusel = await item("carrusel");
    fireEvent.click(
      await within(carrusel).findByRole("button", { name: "Marcar como retirado el carrusel" }),
    );
    expect(within(carrusel).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(carrusel).getByRole("button", { name: "Sí, marcar como retirada" }));

    expect(await screen.findByText("Descartadas y retiradas (1)")).toBeTruthy();
    expect((await setup.t.publications.listEvents(id)).at(-1)?.payload).toMatchObject({
      removedByHand: false,
    });
  });

  it("la bitácora muestra quién hizo cada cambio", async () => {
    const setup = await publicationSetup();
    await setup.open();

    const carrusel = await item("carrusel");
    const toggle = await within(carrusel).findByRole("button", { name: "Bitácora del carrusel" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const log = await within(carrusel).findByRole("list", { name: "Bitácora" });
    expect(log.textContent).toContain("panel: nace → aprobada");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
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
