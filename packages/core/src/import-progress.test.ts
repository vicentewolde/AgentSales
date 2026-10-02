import { describe, expect, it } from "vitest";
import { importReportIssues } from "./import-progress.js";
import type { ImportReport } from "./import-run.js";

describe("importReportIssues", () => {
  it("la hoja Corredor primero, después cada fila en orden, con su referencia", () => {
    const report: ImportReport = {
      headers: null,
      broker: {
        slug: null,
        outcome: "invalid",
        issues: [
          {
            column: "color_primario",
            key: "color_primario",
            code: "FIELD_VALUE_INVALID",
            message: "No es HEX",
          },
        ],
        warnings: ["Campo repetido: email"],
      },
      rows: [
        {
          rowNumber: 3,
          externalRef: "P-001",
          outcome: "failed",
          listingId: null,
          errors: [
            { column: "precio", key: "precio", code: "FIELD_REQUIRED", message: "Falta el precio" },
            { column: "moneda", key: "moneda", code: "FIELD_ENUM_INVALID", message: "UF o CLP" },
          ],
          warnings: [],
        },
        {
          rowNumber: 4,
          externalRef: null,
          outcome: "created",
          listingId: "x",
          errors: [],
          warnings: ["Sin fotos"],
        },
      ],
    };

    expect(importReportIssues(report)).toEqual({
      errors: [
        { rowNumber: null, externalRef: null, column: "color_primario", message: "No es HEX" },
        { rowNumber: 3, externalRef: "P-001", column: "precio", message: "Falta el precio" },
        { rowNumber: 3, externalRef: "P-001", column: "moneda", message: "UF o CLP" },
      ],
      warnings: ["Corredor: Campo repetido: email", "Fila 4: Sin fotos"],
    });
  });
});
