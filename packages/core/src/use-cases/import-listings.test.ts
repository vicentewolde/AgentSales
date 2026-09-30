import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import { importReportSchema } from "../import-run.js";
import type { ListingSheetInput, ListingSheetRow } from "../listing-sheet.js";
import { createInMemoryFieldDefinitionRepository } from "../testing/field-definition-repository.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
} from "../testing/import-repositories.js";
import { type ImportListingsParams, importListings } from "./import-listings.js";

let nextDef = 0;
const def = (
  key: string,
  type: FieldDefinition["type"],
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id: `def-${++nextDef}`,
  brokerId: null,
  category: "real_estate",
  key,
  label: key,
  type,
  required: false,
  options: null,
  sourceColumn: key,
  isCore: false,
  sortOrder: nextDef * 10,
  active: true,
  ...overrides,
});

/** Definiciones mínimas: las obligatorias del modelo, control y dos atributos. */
const DEFS: FieldDefinition[] = [
  def("id_propiedad", "text", { required: true, isCore: true }),
  def("operacion", "enum", { isCore: true, options: ["Venta", "Arriendo"] }),
  def("precio", "number", { required: true, isCore: true }),
  def("moneda", "enum", { required: true, isCore: true, options: ["UF", "CLP"] }),
  def("estado_carga", "enum", { required: true, isCore: true, options: ["Borrador", "Listo"] }),
  def("carpeta_medios", "text", { isCore: true }),
  def("dormitorios", "number"),
  def("amenities", "list"),
];
const HEADERS = DEFS.map((d) => d.sourceColumn);

/** Hoja Corredor sintética (datos inventados). */
const BROKER_SHEET = {
  nombre_corredor: "Persona Inventada",
  nombre_marca: "Marca Inventada",
  color_primario: "#112233",
  tono: "Cercano",
};

const row = (rowNumber: number, overrides: Record<string, unknown> = {}): ListingSheetRow => ({
  rowNumber,
  raw: {
    id_propiedad: `P00${rowNumber - 1}`,
    operacion: "Venta",
    precio: 5800,
    moneda: "UF",
    estado_carga: "Listo",
    carpeta_medios: null,
    dormitorios: 3,
    amenities: "Piscina, quincho",
    ...overrides,
  },
});

const sheet = (
  rows: ListingSheetRow[],
  overrides: Partial<ListingSheetInput> = {},
): ListingSheetInput => ({ headers: HEADERS, rows, broker: BROKER_SHEET, ...overrides });

const THREE_ROWS = [row(2), row(3), row(4)];

/** Dependencias en memoria; `sha256` falso pero determinista (core no usa node:crypto). */
function setup(defs: FieldDefinition[] = DEFS) {
  const deps = {
    brokers: createInMemoryBrokerRepository(),
    listings: createInMemoryListingRepository(),
    importRuns: createInMemoryImportRunRepository(),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(defs),
    sha256: async (text: string) => `hash:${text}`,
  };
  const run = async (
    input: ListingSheetInput,
    params: Partial<Omit<ImportListingsParams, "runId" | "input">> = {},
  ) => {
    const importRun = await deps.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: params.dryRun ?? false,
      input: {},
    });
    const result = await importListings(deps, {
      runId: importRun.id,
      input,
      dryRun: false,
      ...params,
    });
    return { result, runId: importRun.id };
  };
  return { deps, run };
}

const outcomes = (rows: { outcome: string }[]) => rows.map((r) => r.outcome);

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
  return error;
}

describe("importListings · idempotencia y actualización", () => {
  it("la primera carga crea; la segunda, con el mismo Excel, dice skipped y no duplica", async () => {
    const { deps, run } = setup();
    const first = await run(sheet(THREE_ROWS));
    expect(outcomes(first.result.rows)).toEqual(["created", "created", "created"]);
    const second = await run(sheet(THREE_ROWS));
    expect(outcomes(second.result.rows)).toEqual(["skipped", "skipped", "skipped"]);
    expect(deps.listings.all()).toHaveLength(3);
    expect(second.result.counts).toEqual({
      rowsTotal: 3,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 3,
      rowsFailed: 0,
    });
  });

  it("cambiar el precio → updated, y guarda el precio nuevo", async () => {
    const { deps, run } = setup();
    await run(sheet(THREE_ROWS));
    const changed = await run(sheet([row(2), row(3, { precio: "6.100" }), row(4)]));
    expect(outcomes(changed.result.rows)).toEqual(["skipped", "updated", "skipped"]);
    expect(deps.listings.all().find((l) => l.externalRef === "P002")?.priceAmount).toBe(6100);
  });

  it("guarda las columnas fijas, los atributos, la categoría y el origen; nace en draft", async () => {
    const { deps, run } = setup();
    await run(sheet([row(2)]));
    const [listing] = deps.listings.all();
    expect(listing).toMatchObject({
      externalRef: "P001",
      operation: "sale",
      priceAmount: 5800,
      priceCurrency: "UF",
      category: "real_estate",
      source: "xlsx",
      status: "draft",
      attributes: { dormitorios: 3, amenities: ["Piscina", "quincho"] },
    });
  });

  it("reimportar no pisa un status puesto a mano, aunque la fila cambie", async () => {
    const { deps, run } = setup();
    const first = await run(sheet([row(2)]));
    const listingId = first.result.rows[0]?.listingId ?? "";
    deps.listings.setStatus(listingId, "paused");
    const again = await run(sheet([row(2, { precio: 9000 })]));
    expect(outcomes(again.result.rows)).toEqual(["updated"]);
    expect(deps.listings.all()[0]).toMatchObject({ status: "paused", priceAmount: 9000 });
  });

  it("un id_propiedad numérico en el Excel no se duplica al reimportar", async () => {
    const { deps, run } = setup();
    await run(sheet([row(2, { id_propiedad: 101 })]));
    const again = await run(sheet([row(2, { id_propiedad: 101 })]));
    expect(outcomes(again.result.rows)).toEqual(["skipped"]);
    expect(deps.listings.all()).toHaveLength(1);
  });
});

describe("importListings · filas con errores e ignoradas", () => {
  it("una fila con errores no se escribe ni detiene las demás; el reporte trae fila, columna y motivo", async () => {
    const { deps, run } = setup();
    const { result, runId } = await run(
      sheet([row(2), row(3, { precio: "caro", moneda: "USD" }), row(4)]),
    );
    expect(outcomes(result.rows)).toEqual(["created", "failed", "created"]);
    expect(deps.listings.all().map((l) => l.externalRef)).toEqual(["P001", "P003"]);
    const failed = result.report.rows[1];
    expect(failed).toMatchObject({ rowNumber: 3, externalRef: "P002", outcome: "failed" });
    expect(failed?.errors.map((e) => [e.column, e.code]).sort()).toEqual([
      ["moneda", "FIELD_ENUM_INVALID"],
      ["precio", "FIELD_NUMBER_INVALID"],
    ]);
    expect((await deps.importRuns.get(runId))?.rowsFailed).toBe(1);
  });

  it("un id_propiedad repetido en la hoja falla en su segunda aparición", async () => {
    const { deps, run } = setup();
    const { result } = await run(sheet([row(2), row(3, { id_propiedad: "P001" })]));
    expect(outcomes(result.rows)).toEqual(["created", "failed"]);
    expect(result.report.rows[1]?.errors[0]?.message).toBe("«P001» ya aparece en la fila 2");
    expect(deps.listings.all()).toHaveLength(1);
  });

  it("EJEMPLO y Borrador quedan ignored y no cuentan en rowsTotal", async () => {
    const { run } = setup();
    const { result } = await run(
      sheet([row(2, { id_propiedad: "EJEMPLO" }), row(3, { estado_carga: "Borrador" }), row(4)]),
    );
    expect(outcomes(result.rows)).toEqual(["ignored", "ignored", "created"]);
    expect(result.counts.rowsTotal).toBe(1);
  });

  it("informa en el reporte los encabezados desconocidos, faltantes y repetidos", async () => {
    const { run } = setup();
    const headers = [...HEADERS.filter((h) => h !== "dormitorios"), "Vista al mar", "precio"];
    const { result } = await run(sheet([row(2)], { headers }));
    expect(result.report.headers).toEqual({
      unknown: ["Vista al mar"],
      missing: [],
      duplicated: ["precio"],
    });
  });

  it("el reporte calza con importReportSchema y queda guardado en el run", async () => {
    const { deps, run } = setup();
    const { result, runId } = await run(sheet([row(2), row(3, { precio: "x" })]));
    expect(importReportSchema.parse(result.report)).toEqual(result.report);
    const stored = await deps.importRuns.get(runId);
    expect(stored).toMatchObject({ report: result.report, rowsCreated: 1, rowsFailed: 1 });
    expect(stored?.brokerId).toBe(result.brokerId);
  });
});

describe("importListings · dry-run", () => {
  it("no escribe nada salvo el import_run, y reporta lo que pasaría", async () => {
    const { deps, run } = setup();
    const { result, runId } = await run(sheet(THREE_ROWS), { dryRun: true });
    expect(outcomes(result.rows)).toEqual(["created", "created", "created"]);
    expect(result.brokerId).toBeNull();
    expect(deps.brokers.all()).toEqual([]);
    expect(deps.listings.all()).toEqual([]);
    expect((await deps.importRuns.get(runId))?.report?.broker?.outcome).toBe("created");
  });

  it("sobre datos existentes simula updated y skipped sin cambiar nada", async () => {
    const { deps, run } = setup();
    await run(sheet(THREE_ROWS));
    const before = deps.listings.all();
    const { result } = await run(sheet([row(2), row(3, { precio: 1 }), row(4)]), {
      dryRun: true,
    });
    expect(outcomes(result.rows)).toEqual(["skipped", "updated", "skipped"]);
    expect(deps.listings.all()).toEqual(before);
  });
});

describe("importListings · hoja Corredor", () => {
  it("crea el broker; con los mismos datos queda unchanged; con otros, updated", async () => {
    const { deps, run } = setup();
    const first = await run(sheet([row(2)]));
    expect(first.result.report.broker).toMatchObject({
      slug: "marca-inventada",
      outcome: "created",
    });
    const same = await run(sheet([row(2)]));
    expect(same.result.report.broker?.outcome).toBe("unchanged");
    const changed = await run(sheet([row(2)], { broker: { ...BROKER_SHEET, tono: "Formal" } }));
    expect(changed.result.report.broker?.outcome).toBe("updated");
    expect(deps.brokers.all()).toMatchObject([{ slug: "marca-inventada", tone: "Formal" }]);
  });

  it("con --broker, gana ese slug y los datos de la hoja lo actualizan", async () => {
    const { deps, run } = setup();
    await run(sheet([row(2)]), { brokerSlug: "mi-corredor" });
    expect(deps.brokers.all().map((b) => b.slug)).toEqual(["mi-corredor"]);
  });

  it("sin hoja Corredor usa el corredor existente de --broker (outcome existing)", async () => {
    const { run } = setup();
    await run(sheet([row(2)]), { brokerSlug: "mi-corredor" });
    const { result } = await run(sheet([row(3)], { broker: null }), { brokerSlug: "mi-corredor" });
    expect(result.report.broker?.outcome).toBe("existing");
    expect(outcomes(result.rows)).toEqual(["created"]);
  });

  it("sin hoja Corredor y con un --broker que no existe → BROKER_NOT_FOUND", async () => {
    const { run } = setup();
    await expectAppError(
      run(sheet([row(2)], { broker: null }), { brokerSlug: "nadie" }),
      "BROKER_NOT_FOUND",
    );
  });

  it("sin hoja Corredor y sin --broker → BROKER_INVALID", async () => {
    const { run } = setup();
    await expectAppError(run(sheet([row(2)], { broker: null })), "BROKER_INVALID");
  });

  it("una hoja Corredor con errores → BROKER_INVALID, sin escribir, y el detalle en el reporte", async () => {
    const { deps } = setup();
    const importRun = await deps.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: {},
    });
    const invalid = sheet([row(2)], { broker: { nombre_marca: "Marca", color_primario: "azul" } });
    await expectAppError(
      importListings(deps, { runId: importRun.id, input: invalid, dryRun: false }),
      "BROKER_INVALID",
    );
    expect(deps.brokers.all()).toEqual([]);
    expect(deps.listings.all()).toEqual([]);
    const report = (await deps.importRuns.get(importRun.id))?.report;
    expect(report?.broker).toMatchObject({ outcome: "invalid" });
    expect(report?.broker?.issues.map((i) => i.column)).toEqual([
      "nombre_corredor",
      "color_primario",
    ]);
  });
});

describe("importListings · errores del run", () => {
  it("definiciones que no permiten armar un listing → FIELD_CONFIG_INVALID", async () => {
    const { run } = setup(DEFS.filter((d) => d.key !== "precio"));
    await expectAppError(run(sheet([row(2)])), "FIELD_CONFIG_INVALID");
  });

  it("un run inexistente → IMPORT_RUN_NOT_FOUND", async () => {
    const { deps } = setup();
    await expectAppError(
      importListings(deps, { runId: "run-x", input: sheet([row(2)]), dryRun: false }),
      "IMPORT_RUN_NOT_FOUND",
    );
  });

  it("devuelve listingId y control de cada fila para la ingesta de medios", async () => {
    const { run } = setup();
    const { result } = await run(sheet([row(2, { carpeta_medios: "P001-fotos" })]));
    expect(result.rows[0]).toMatchObject({
      listingId: expect.any(String),
      control: { loadStatus: "ready", mediaFolder: "P001-fotos", coverFile: null },
    });
  });
});
