import type { ImportRunView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { sampleReport } from "../../test/harness.js";
import { createColors } from "../colors.js";
import { exitCodeOf, renderImportRun } from "./import-run-view.js";

const plain = createColors(false);

const view = (overrides: Partial<ImportRunView> = {}): ImportRunView => ({
  id: "4f1c2b8e-0000-4000-8000-000000000001",
  brokerId: null,
  status: "succeeded",
  dryRun: false,
  source: "xlsx",
  fileName: "propiedades.xlsx",
  input: { xlsxFile: "propiedades.xlsx", mediaFile: null, broker: null },
  rowsTotal: 3,
  rowsCreated: 2,
  rowsUpdated: 0,
  rowsSkipped: 0,
  rowsFailed: 1,
  report: sampleReport(),
  error: null,
  startedAt: new Date(2026, 9, 2, 10, 0),
  finishedAt: new Date(2026, 9, 2, 10, 1),
  createdAt: new Date(2026, 9, 2, 9, 59),
  ...overrides,
});

describe("renderImportRun", () => {
  it("resumen, columnas desconocidas, errores y advertencias", () => {
    const text = renderImportRun(view(), plain);

    expect(text.split("\n").slice(0, 6)).toEqual([
      "Carga 4f1c2b8e-0000-4000-8000-000000000001  terminada",
      "  Archivo: propiedades.xlsx",
      "  Creada: 2026-10-02 09:59",
      "  Corredor: marca (creado)",
      "  Propiedades: creadas 2 · actualizadas 0 · sin cambios 0 · con error 1",
      "  Medios: subidos 3 · ya estaban 0 · omitidos 1 · con error 0",
    ]);
    expect(text).toContain("Columnas desconocidas (se guardan aparte): vista_al_mar");
    expect(text).toContain(
      "Errores (1)\nFila  Propiedad  Columna  Motivo\n5     P-003      precio   Falta el precio",
    );
    expect(text).toContain("Advertencias (1)\n  Fila 4 (P-002): Sin fotos: queda en borrador");
  });

  it("sin la etapa de medios muestra 'Medios: —', sin asumir ceros", () => {
    const report = sampleReport();
    delete report.media;

    expect(renderImportRun(view({ report }), plain)).toContain("  Medios: —");
  });

  it("los errores de la hoja Corredor van en la tabla, y la simulación se avisa", () => {
    const report = sampleReport();
    report.broker = {
      slug: null,
      outcome: "invalid",
      issues: [
        {
          column: "color_primario",
          key: "color_primario",
          code: "FIELD_VALUE_INVALID",
          message: "No es un color HEX",
        },
      ],
      warnings: ["Campo repetido: email"],
    };
    report.rows = [];
    report.headers = { unknown: [], missing: ["precio"], duplicated: ["comuna"] };

    const text = renderImportRun(
      view({
        status: "failed",
        dryRun: true,
        report,
        error: { code: "BROKER_INVALID", message: "La hoja Corredor tiene errores" },
      }),
      plain,
    );

    expect(text).toContain("falló (simulación)");
    expect(text).toContain("Simulación (--dry-run): muestra lo que pasaría, sin guardar nada");
    expect(text).toContain("Error: BROKER_INVALID: La hoja Corredor tiene errores");
    expect(text).toContain("Corredor: — (con errores)");
    expect(text).toContain("Faltan columnas: precio");
    expect(text).toContain("Columnas repetidas: comuna");
    expect(text).toMatch(/Corredor\s+—\s+color_primario\s+No es un color HEX/);
    expect(text).toContain("  Corredor: Campo repetido: email");
  });

  it("una carga sin reporte (en cola, o que falló antes) muestra solo su estado", () => {
    const text = renderImportRun(view({ status: "queued", report: null }), plain);

    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("en cola");
  });
});

describe("exitCodeOf", () => {
  it("1 si falló o si alguna fila tiene errores; si no, 0", () => {
    expect(exitCodeOf(view())).toBe(1);
    expect(exitCodeOf(view({ rowsFailed: 0 }))).toBe(0);
    expect(exitCodeOf(view({ rowsFailed: 0, status: "failed" }))).toBe(1);
  });
});
