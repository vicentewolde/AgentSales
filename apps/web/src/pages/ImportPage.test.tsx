// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { type ImportReport, type NewImportRun, RUN_WAIT } from "@agentsales/core";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { UploadFailure } from "../api/upload.js";

const { pollMs: IMPORT_POLL_MS, queuedWarningMs: QUEUED_WARNING_MS } = RUN_WAIT;

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
  const latestRun = async (h: Harness) => (await h.importRuns.list(1, { kind: "all" }))[0];

  it("sube el Excel y el zip a R2 con el corredor y la simulación, empieza la carga y la abre", async () => {
    const h = harness();
    await h.brokers.create(brokerData("mi-corredor"));
    h.renderApp("/importar");

    const select = (await screen.findByLabelText("Corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(fileInput(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.change(fileInput(/Fotos y videos \(\.zip\)/), {
      target: { files: [new File(["zip"], "medios.zip")] },
    });
    fireEvent.change(select, { target: { value: "mi-corredor" } });
    fireEvent.click(screen.getByLabelText(/Solo simular/));
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect(await screen.findByRole("heading", { name: "propiedades.xlsx" })).toBeTruthy();
    const run = await latestRun(h);
    expect(run).toMatchObject({
      status: "queued",
      dryRun: true,
      input: {
        broker: "mi-corredor",
        dryRun: true,
        xlsx: { name: "propiedades.xlsx", size: 1 },
        media: { kind: "zip", name: "medios.zip", size: 3 },
      },
    });
    // Los dos archivos llegaron a R2 (el doble) y la API solo recibió JSON.
    expect(h.transfers.map((t) => t.size).sort()).toEqual([1, 3]);
    expect(await h.storage.list(`imports/${run?.id}/`)).toHaveLength(2);
    expect(h.requests).toContain(`POST /imports/${run?.id}/start`);
    expect(screen.getByText("en cola (simulación)")).toBeTruthy();
    expect(screen.getByText("En cola…")).toBeTruthy();
  });

  it("sin medios ni corredor, sube solo el Excel", async () => {
    const h = harness();
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    await screen.findByRole("heading", { name: "propiedades.xlsx" });
    expect((await latestRun(h))?.input).toMatchObject({ broker: null, dryRun: false, media: null });
    expect(h.transfers).toHaveLength(1);
  });

  it("una carpeta sube cada archivo con su ruta, sin los ocultos de macOS", async () => {
    const h = harness();
    h.renderApp("/importar");
    const inFolder = (path: string, content: string) => {
      const file = new File([content], path.split("/").pop() ?? path);
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      return file;
    };

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByLabelText("Una carpeta"));
    fireEvent.change(fileInput(/Carpeta de fotos y videos/), {
      target: {
        files: [inFolder("medios/P001/foto.jpg", "foto"), inFolder("medios/.DS_Store", "basura")],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    await screen.findByRole("heading", { name: "propiedades.xlsx" });
    const run = await latestRun(h);
    expect(run?.input).toMatchObject({
      media: { kind: "folder", name: "medios", files: [{ path: "P001/foto.jpg", size: 4 }] },
    });
    expect((await h.storage.list(`imports/${run?.id}/media/`)).map((o) => o.path)).toEqual([
      `imports/${run?.id}/media/P001/foto.jpg`,
    ]);
  });

  it("muestra el avance y deja cancelar: la carga no empieza", async () => {
    const h = harness({
      // Una subida que no termina hasta que se cancela.
      transport:
        () =>
        async ({ signal, onProgress }) => {
          onProgress(1);
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () =>
              reject(new DOMException("Subida cancelada", "AbortError")),
            ),
          );
        },
    });
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["xy"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect(await screen.findByText("Subiendo 0 de 1 archivos (50 %)…")).toBeTruthy();
    expect(screen.getByLabelText("Avance de la subida")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar la subida" }));

    expect(await screen.findByText("Subida cancelada: no se cargó nada.")).toBeTruthy();
    expect((await latestRun(h))?.status).toBe("awaiting_upload");
    expect(h.requests.some((r) => r.endsWith("/start"))).toBe(false);
  });

  it("un archivo que falla al subir se reintenta y la carga sigue", async () => {
    let attempts = 0;
    const h = harness({
      transport: (memory) => async (request) => {
        attempts += 1;
        if (attempts === 1) throw new UploadFailure("R2 respondió 503", 503);
        return memory(request);
      },
    });
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    // El reintento espera 1 s.
    expect(
      await screen.findByRole("heading", { name: "propiedades.xlsx" }, { timeout: 4_000 }),
    ).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("si un archivo no llegó a R2, el error de la API lo nombra y la carga no empieza", async () => {
    const h = harness({
      // El zip "se sube" sin llegar (por ejemplo, otra pestaña lo cortó).
      transport: (memory) => async (request) =>
        request.url.includes("media.zip") ? undefined : memory(request),
    });
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.change(fileInput(/Fotos y videos \(\.zip\)/), {
      target: { files: [new File(["zip"], "medios.zip")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    const incomplete = (await screen.findByRole("alert")).textContent ?? "";
    expect(incomplete).toContain("Faltan 1 archivo(s) por subir: medios.zip");
    expect(incomplete).toContain("código: IMPORT_UPLOAD_INCOMPLETE");
    expect((await latestRun(h))?.status).toBe("awaiting_upload");
  });

  it.each([
    [[], [], "Elige el Excel con las propiedades."],
    [[new File(["x"], "notas.txt")], [], "El archivo debe ser un Excel (.xlsx)."],
    [[new File([], "vacio.xlsx")], [], "El Excel está vacío."],
    [[new File(["x"], "p.xlsx")], [new File(["x"], "fotos.rar")], "deben venir en un .zip"],
  ])("revisa los archivos antes de subir (%#)", async (files, media, message) => {
    const h = harness();
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files },
    });
    fireEvent.change(fileInput(/Fotos y videos \(\.zip\)/), { target: { files: media } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(h.transfers).toEqual([]);
    expect(h.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });

  it("un error de la API al pedir la subida se muestra con su código", async () => {
    const h = harness({
      intercept: (method, path) =>
        method === "POST" && path === "/imports/uploads"
          ? Response.json(
              { error: { code: "IMPORT_UPLOAD_TOO_LARGE", message: "El zip pasa de 512 MB" } },
              { status: 413 },
            )
          : undefined,
    });
    h.renderApp("/importar");

    fireEvent.change(await screen.findByLabelText(/Excel de propiedades/), {
      target: { files: [new File(["x"], "propiedades.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    const tooLarge = (await screen.findByRole("alert")).textContent ?? "";
    expect(tooLarge).toContain("El zip pasa de 512 MB");
    expect(tooLarge).toContain("código: IMPORT_UPLOAD_TOO_LARGE");
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

    const invalid = (await screen.findByRole("alert")).textContent ?? "";
    expect(invalid).toContain("La hoja Corredor tiene errores");
    expect(invalid).toContain("código: BROKER_INVALID");
    expect(screen.getByText("falló")).toBeTruthy();
  });

  it("si la carga termina mientras se mira, Propiedades muestra lo nuevo sin esperar la caché", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    const run = await h.importRuns.create(newRun());
    h.renderApp("/propiedades");
    await screen.findByText(/Todavía no hay propiedades/);

    // A la carga, en curso (la lista de propiedades queda en caché, vacía).
    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    fireEvent.click(within(menu).getByRole("link", { name: "Importar" }));
    fireEvent.click(
      await within(await screen.findByRole("region", { name: "Cargas anteriores" })).findByRole(
        "link",
      ),
    );
    await screen.findByText("En cola…");
    await finishRun(h, run.id);
    await advance(IMPORT_POLL_MS);
    await screen.findByText("terminada");

    fireEvent.click(screen.getByRole("link", { name: "Ver las propiedades →" }));
    expect(await screen.findByRole("link", { name: /P-001/ })).toBeTruthy();
  });

  it("abrir una carga que ya estaba terminada no vuelve a pedir las propiedades", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun());
    await finishRun(h, run.id);
    h.renderApp("/propiedades");
    await screen.findByRole("link", { name: /P-001/ });
    const listingRequests = () => h.requests.filter((r) => r.startsWith("GET /listings")).length;
    const before = listingRequests();

    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    fireEvent.click(within(menu).getByRole("link", { name: "Importar" }));
    fireEvent.click(
      await within(await screen.findByRole("region", { name: "Cargas anteriores" })).findByRole(
        "link",
      ),
    );
    // "terminada" también sale en el historial: se espera el enlace de la página de la carga.
    fireEvent.click(await screen.findByRole("link", { name: "Ver las propiedades →" }));
    await screen.findByRole("link", { name: /P-001/ });

    expect(listingRequests()).toBe(before);
  });

  it("tras fallas seguidas deja de consultar, lo dice y deja consultar de nuevo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    const h = harness({
      intercept: (_method, path) => {
        if (down && path.startsWith("/imports/")) throw new TypeError("fetch failed");
        return undefined;
      },
    });
    const run = await h.importRuns.create(newRun());
    h.renderApp(`/importar/${run.id}`);
    await screen.findByText("En cola…");
    const polls = () => h.requests.filter((r) => r === `GET /imports/${run.id}`).length;

    down = true;
    await advance(IMPORT_POLL_MS * 10);
    expect(
      await screen.findByText("Dejé de consultar: la API no respondió varias veces seguidas."),
    ).toBeTruthy();
    const stoppedAt = polls();
    await advance(IMPORT_POLL_MS * 10);
    expect(polls()).toBe(stoppedAt);

    down = false;
    await h.importRuns.markRunning(run.id);
    fireEvent.click(screen.getByRole("button", { name: "Consultar de nuevo" }));
    expect(await screen.findByText("Procesando el Excel y los medios…")).toBeTruthy();
    expect(screen.queryByText(/Dejé de consultar/)).toBeNull();
  });

  it("a las 2 h de creada deja de consultar una carga que no termina", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    const run = await h.importRuns.create(newRun());
    vi.setSystemTime(Date.now() + RUN_WAIT.maxWaitMs);
    h.renderApp(`/importar/${run.id}`);

    expect(
      await screen.findByText("Dejé de consultar: la carga lleva más de 2 horas sin terminar."),
    ).toBeTruthy();
    const polls = h.requests.filter((r) => r === `GET /imports/${run.id}`).length;
    await advance(IMPORT_POLL_MS * 5);
    expect(h.requests.filter((r) => r === `GET /imports/${run.id}`)).toHaveLength(polls);
  });

  it.each([
    ["no existe", () => randomUUID()],
    ["no es un uuid", () => "abc"],
  ])("un id que %s dice que la carga no existe", async (_label, id) => {
    harness().renderApp(`/importar/${id()}`);

    expect(await screen.findByText("Esta carga no existe.")).toBeTruthy();
  });
});
