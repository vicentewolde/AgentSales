// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import type { ImportReport, NewImportRun } from "@agentsales/core";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { IMPORT_POLL_MS, QUEUED_WARNING_MS } from "../queries/imports.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const newRun = (fileName = "propiedades.xlsx", dryRun = false): NewImportRun => ({
  source: "xlsx",
  fileName,
  dryRun,
  input: { xlsxPath: `/staging/${fileName}`, mediaDir: null, broker: null },
});

/** Reporte con una fila creada (enlazada a su aviso), una con error y una advertencia. */
const reportFor = (listingId: string): ImportReport => ({
  headers: { unknown: ["vista_al_mar"], missing: [], duplicated: [] },
  broker: { slug: "marca", outcome: "created", issues: [], warnings: [] },
  rows: [
    {
      rowNumber: 3,
      externalRef: "P-001",
      outcome: "created",
      listingId,
      errors: [],
      warnings: ["Sin fotos: queda en borrador"],
    },
    {
      rowNumber: 4,
      externalRef: "P-002",
      outcome: "failed",
      listingId: null,
      errors: [
        { column: "precio", key: "precio", code: "FIELD_REQUIRED", message: "Falta el precio" },
      ],
      warnings: [],
    },
  ],
  media: { filesUploaded: 2, filesExisting: 0, filesSkipped: 1, filesFailed: 0 },
});

type Harness = ReturnType<typeof harness>;

/** Hace de worker: deja la carga terminada con un aviso nuevo y una fila con error. */
async function finishRun(h: Harness, runId: string) {
  const broker = await h.brokers.create(brokerData("marca"));
  const listing = await h.listings.create(newListing(broker.id, "P-001"));
  await h.importRuns.markRunning(runId);
  await h.importRuns.recordListingsResult(runId, {
    brokerId: broker.id,
    counts: { rowsTotal: 2, rowsCreated: 1, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 1 },
    report: reportFor(listing.id),
  });
  await h.importRuns.markSucceeded(runId);
  return listing;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const fileInput = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe("panel: Importar", () => {
  it("envía el Excel, el zip, el corredor y la simulación, y abre la carga", async () => {
    const h = harness();
    await h.brokers.create(brokerData("mi-corredor"));
    h.renderApp("/importar");

    const select = (await screen.findByLabelText("Corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(fileInput(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.change(fileInput(/Fotos y videos/), {
      target: { files: [new File(["zip"], "medios.zip")] },
    });
    fireEvent.change(select, { target: { value: "mi-corredor" } });
    fireEvent.click(screen.getByLabelText(/Solo simular/));
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect(await screen.findByRole("heading", { name: "propiedades.xlsx" })).toBeTruthy();
    expect(h.uploads).toEqual([
      {
        file: { name: "propiedades.xlsx", size: 1 },
        media: { name: "medios.zip", size: 3 },
        broker: "mi-corredor",
        dryRun: "true",
      },
    ]);
    expect(screen.getByText("en cola (simulación)")).toBeTruthy();
    expect(screen.getByText("En cola…")).toBeTruthy();
  });

  it("sin zip ni corredor, manda solo el Excel", async () => {
    const h = harness();
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    await screen.findByRole("heading", { name: "propiedades.xlsx" });
    expect(h.uploads[0]).toEqual({
      file: { name: "propiedades.xlsx", size: 1 },
      media: null,
      broker: null,
      dryRun: "false",
    });
  });

  it.each([
    [[], [], "Elige el Excel con las propiedades."],
    [[new File(["x"], "notas.txt")], [], "El archivo debe ser un Excel (.xlsx)."],
    [[new File(["x"], "p.xlsx")], [new File(["x"], "fotos.rar")], "deben venir en un .zip"],
  ])("revisa los archivos antes de subir (%#)", async (files, media, message) => {
    const h = harness();
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files },
    });
    fireEvent.change(fileInput(/Fotos y videos/), { target: { files: media } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(h.uploads).toEqual([]);
  });

  it("un error de la API al subir se muestra con su código", async () => {
    const h = harness({
      intercept: (method, path) =>
        method === "POST" && path === "/imports"
          ? Response.json(
              { error: { code: "REQUEST_TOO_LARGE", message: "La subida pasa de 512 MB" } },
              { status: 413 },
            )
          : undefined,
    });
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "REQUEST_TOO_LARGE: La subida pasa de 512 MB",
    );
  });

  it("muestra el historial de cargas con su estado y enlace", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun("enero.xlsx", true));
    h.renderApp("/importar");

    const historial = await screen.findByRole("region", { name: "Cargas anteriores" });
    const row = (await within(historial).findByText("enero.xlsx")).closest("tr") as HTMLElement;
    expect(within(row).getByText("en cola (simulación)")).toBeTruthy();
    expect(within(row).getByRole("link").getAttribute("href")).toBe(`/importar/${run.id}`);
  });
});

describe("panel: una carga", () => {
  it("consulta cada 2 s mientras corre y deja de consultar al terminar", async () => {
    // El reloj también avanza solo, para que cargue la página (`React.lazy`); los saltos de 2 s y
    // de 20 s se dan a mano.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    const run = await h.importRuns.create(newRun());
    h.renderApp(`/importar/${run.id}`);
    const polls = () => h.requests.filter((r) => r === `GET /imports/${run.id}`).length;

    expect(await screen.findByText("En cola…")).toBeTruthy();
    expect(polls()).toBe(1);

    await h.importRuns.markRunning(run.id);
    await advance(IMPORT_POLL_MS);
    expect(screen.getByText("Procesando el Excel y los medios…")).toBeTruthy();
    expect(polls()).toBe(2);

    await finishRun(h, run.id);
    await advance(IMPORT_POLL_MS);
    expect(screen.getByText("terminada")).toBeTruthy();
    expect(polls()).toBe(3);

    await advance(IMPORT_POLL_MS * 5);
    expect(polls()).toBe(3);
  });

  it("si sigue en cola a los 20 s avisa que revise el worker", async () => {
    // El reloj también avanza solo, para que cargue la página (`React.lazy`); los saltos de 2 s y
    // de 20 s se dan a mano.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    const run = await h.importRuns.create(newRun());
    h.renderApp(`/importar/${run.id}`);
    await screen.findByText("En cola…");

    await advance(QUEUED_WARNING_MS - IMPORT_POLL_MS);
    expect(screen.queryByText(/Sigue en cola/)).toBeNull();

    await advance(IMPORT_POLL_MS);
    expect(screen.getByText("Sigue en cola: ¿está corriendo el worker? (pnpm dev)")).toBeTruthy();
  });

  it("al terminar muestra el resumen, las filas, los errores por fila y columna y las advertencias", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun());
    const listing = await finishRun(h, run.id);
    h.renderApp(`/importar/${run.id}`);

    await screen.findByText("terminada");
    const count = (label: string) =>
      screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(count("Creadas")).toBe("1");
    expect(count("Con error")).toBe("1");
    expect(count("Fotos y videos")).toBe("subidos 2 · ya estaban 0 · omitidos 1 · con error 0");
    expect(screen.getByText("Corredor: marca (creado)")).toBeTruthy();
    expect(screen.getByText(/Columnas desconocidas.*vista_al_mar/)).toBeTruthy();

    const errores = screen.getByRole("region", { name: "Errores (1)" });
    const cells = within(errores)
      .getAllByRole("row")
      .map((row) =>
        within(row)
          .queryAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(cells).toContainEqual(["4", "P-002", "precio", "Falta el precio"]);

    const filas = screen.getByRole("region", { name: "Filas (2)" });
    expect(within(filas).getByRole("link", { name: "P-001" }).getAttribute("href")).toBe(
      `/propiedades/${listing.id}`,
    );
    expect(within(filas).getByText("con error")).toBeTruthy();
    expect(screen.getByText("Fila 3 (P-001): Sin fotos: queda en borrador")).toBeTruthy();
  });

  it("una carga que falló muestra el motivo", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun());
    await h.importRuns.markFailed(run.id, {
      code: "BROKER_INVALID",
      message: "La hoja Corredor tiene errores",
    });
    h.renderApp(`/importar/${run.id}`);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "BROKER_INVALID: La hoja Corredor tiene errores",
    );
    expect(screen.getByText("falló")).toBeTruthy();
  });

  it("al terminar una carga, Propiedades muestra lo recién cargado sin esperar la caché", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun());
    h.renderApp("/propiedades");
    await screen.findByText(/Todavía no hay propiedades/);

    // Navega a la carga (la lista de propiedades queda en caché, vacía).
    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    fireEvent.click(within(menu).getByRole("link", { name: "Importar" }));
    await finishRun(h, run.id);
    fireEvent.click(
      await within(await screen.findByRole("region", { name: "Cargas anteriores" })).findByRole(
        "link",
      ),
    );
    await screen.findByText("terminada");

    fireEvent.click(screen.getByRole("link", { name: "Ver las propiedades →" }));
    expect(await screen.findByRole("link", { name: /P-001/ })).toBeTruthy();
  });

  it.each([
    ["no existe", () => randomUUID()],
    ["no es un uuid", () => "abc"],
  ])("un id que %s dice que la carga no existe", async (_label, id) => {
    harness().renderApp(`/importar/${id()}`);

    expect(await screen.findByText("Esta carga no existe.")).toBeTruthy();
  });
});
