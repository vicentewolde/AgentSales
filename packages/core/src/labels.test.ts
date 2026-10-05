import { describe, expect, it } from "vitest";
import {
  IMPORT_RUN_STATUSES,
  LISTING_STATUSES,
  OPERATIONS,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
} from "./enums.js";
import { IMPORT_BROKER_OUTCOMES, IMPORT_ROW_OUTCOMES } from "./import-run.js";
import {
  IMPORT_BROKER_OUTCOME_TEXT,
  IMPORT_ROW_OUTCOME_TEXT,
  IMPORT_RUN_STATUS_TEXT,
  LISTING_STATUS_TEXT,
  OPERATION_TEXT,
  PUBLICATION_FORMAT_TEXT,
  PUBLICATION_STATUS_TEXT,
} from "./labels.js";

describe("textos para el operador", () => {
  it("cubren todos los valores de cada enum, sin repetirse", () => {
    for (const [values, text] of [
      [LISTING_STATUSES, LISTING_STATUS_TEXT],
      [OPERATIONS, OPERATION_TEXT],
      [IMPORT_RUN_STATUSES, IMPORT_RUN_STATUS_TEXT],
      [IMPORT_BROKER_OUTCOMES, IMPORT_BROKER_OUTCOME_TEXT],
      [IMPORT_ROW_OUTCOMES, IMPORT_ROW_OUTCOME_TEXT],
      [PUBLICATION_STATUSES, PUBLICATION_STATUS_TEXT],
      [PUBLICATION_FORMATS, PUBLICATION_FORMAT_TEXT],
    ] as const) {
      const labels = values.map((value) => (text as Record<string, string>)[value]);
      expect(labels.every((label) => typeof label === "string" && label.length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(values.length);
    }
  });
});
