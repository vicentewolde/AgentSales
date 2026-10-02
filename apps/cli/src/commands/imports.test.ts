import { randomUUID } from "node:crypto";
import type { NewImportRun } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { harness, simulateWorker } from "../../test/harness.js";
import { runImports } from "./imports.js";

const newRun = (fileName: string, dryRun = false): NewImportRun => ({
  source: "xlsx",
  fileName,
  dryRun,
  input: { xlsxPath: `/datos/privados/${fileName}`, mediaDir: null, broker: null },
});

describe("runImports", () => {
  it("sin cargas sugiere cómo empezar", async () => {
    const h = harness();

    expect(await runImports({ ...h.io, client: h.client })).toBe(0);
    expect(h.text()).toContain("Todavía no hay cargas");
  });

  it("lista las cargas con su estado y contadores, sin rutas completas", async () => {
    const h = harness();
    const first = await h.importRuns.create(newRun("enero.xlsx"));
    await simulateWorker(h).start();
    await simulateWorker(h).finish();
    const second = await h.importRuns.create(newRun("febrero.xlsx", true));

    expect(await runImports({ ...h.io, client: h.client })).toBe(0);

    const [header, ...rows] = h.out[0]?.split("\n") ?? [];
    expect(header).toMatch(/^Carga\s+Creada\s+Archivo\s+Estado\s+Creadas/);
    expect(rows[0]).toContain(second.id);
    expect(rows[0]).toContain("en cola (simulación)");
    expect(rows[1]).toContain(first.id);
    expect(rows[1]).toMatch(/enero\.xlsx\s+terminada\s+2\s+0\s+0\s+1$/);
    expect(h.text()).not.toContain("/datos/privados");
  });

  it("con un id muestra el reporte de esa carga", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun("enero.xlsx"));
    const worker = simulateWorker(h);
    await worker.start();
    await worker.finish();

    expect(await runImports({ ...h.io, client: h.client }, run.id)).toBe(1);
    expect(h.text()).toContain(`Carga ${run.id}  terminada`);
    expect(h.text()).toMatch(/5\s+P-003\s+precio\s+Falta el precio/);
  });

  it("una carga en curso sale con 0 y sin reporte", async () => {
    const h = harness();
    const run = await h.importRuns.create(newRun("enero.xlsx"));

    expect(await runImports({ ...h.io, client: h.client }, run.id)).toBe(0);
    expect(h.text()).toContain("en cola");
    expect(h.text()).not.toContain("Propiedades:");
  });

  it.each([
    [randomUUID(), "✗ IMPORT_RUN_NOT_FOUND"],
    ["abc", "✗ REQUEST_INVALID"],
  ])("el id %s da un error claro", async (id, message) => {
    const h = harness();

    expect(await runImports({ ...h.io, client: h.client }, id)).toBe(1);
    expect(h.errors()).toContain(message);
  });
});
