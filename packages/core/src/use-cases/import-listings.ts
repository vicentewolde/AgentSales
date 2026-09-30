import { type Broker, brokerDiffers, parseBrokerSheet } from "../broker.js";
import { canonicalJson } from "../canonical-json.js";
import type { ListingCategory, ListingStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { ImportCounts, ImportReport, ImportRowOutcome, ImportRun } from "../import-run.js";
import type { ListingSheetInput } from "../listing-sheet.js";
import {
  buildListingValidator,
  type FieldIssue,
  type ListingControlFields,
  type ValidatedListingRow,
} from "../listing-validator/index.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ImportRunRepository } from "../ports/import-run-repository.js";
import type { ListingImportRecord, ListingRepository } from "../ports/listing-repository.js";

/** La categoría del piloto. `product` llega después del MVP (ADR-0006). */
const CATEGORY: ListingCategory = "real_estate";

export type ImportListingsDeps = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  importRuns: ImportRunRepository;
  fieldDefinitions: FieldDefinitionRepository;
  /** sha256 en hex de un texto UTF-8; core no depende de `node:crypto` (lo compone el worker). */
  sha256: (text: string) => Promise<string>;
};

export type ImportListingsParams = {
  /**
   * El `import_run` ya creado (lo crea `requestImport`, F1-T09). De él salen `dry_run`, el origen
   * y el `--broker` (`input.broker`): una sola fuente de verdad, así un run de simulación nunca
   * escribe.
   */
  runId: string;
  /** La hoja ya leída (`packages/importers`). */
  input: ListingSheetInput;
};

export type ImportedRow = {
  rowNumber: number;
  externalRef: string | null;
  outcome: ImportRowOutcome;
  /** `null` si la fila no se guardó (o en `dry_run`, si el aviso es nuevo). */
  listingId: string | null;
  /** Estado del aviso tras la carga (nuevo: `draft`); `null` si la fila no se guardó. */
  status: ListingStatus | null;
  /** Para la ingesta de medios (F1-T07): carpeta, portada y estado pedido. */
  control: ListingControlFields | null;
};

export type ImportListingsResult = {
  /** `null` en `dry_run` si el corredor todavía no existe. */
  brokerId: string | null;
  logoFile: string | null;
  rows: ImportedRow[];
  counts: ImportCounts;
  report: ImportReport;
};

type BrokerResolution = {
  broker: Broker | null;
  logoFile: string | null;
  report: NonNullable<ImportReport["broker"]>;
};

/** Registra un reporte sin filas y lanza el error: el motivo queda en el run (spec F1 §4.2). */
async function failWithReport(
  deps: ImportListingsDeps,
  runId: string,
  broker: NonNullable<ImportReport["broker"]>,
  error: AppError,
): Promise<never> {
  await deps.importRuns.recordListingsResult(runId, {
    brokerId: null,
    counts: countOutcomes([]),
    report: { headers: null, broker, rows: [] },
  });
  throw error;
}

async function resolveBroker(
  deps: ImportListingsDeps,
  run: ImportRun,
  input: ListingSheetInput,
): Promise<BrokerResolution> {
  const brokerSlug = run.input.broker;
  if (input.broker === null) {
    if (brokerSlug === null) {
      const message =
        "Falta la hoja Corredor: complétala o indica un corredor existente (--broker)";
      return failWithReport(
        deps,
        run.id,
        {
          slug: null,
          outcome: "invalid",
          issues: [{ column: "Corredor", key: "Corredor", code: "FIELD_REQUIRED", message }],
          warnings: [],
        },
        new AppError("BROKER_INVALID", message),
      );
    }
    const broker = await deps.brokers.findBySlug(brokerSlug);
    if (broker === null) {
      throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerSlug}`, {
        details: { slug: brokerSlug },
      });
    }
    return {
      broker,
      logoFile: null,
      report: { slug: broker.slug, outcome: "existing", issues: [], warnings: [] },
    };
  }

  const parsed = parseBrokerSheet(input.broker, brokerSlug === null ? {} : { slug: brokerSlug });
  if (!parsed.ok) {
    return failWithReport(
      deps,
      run.id,
      { slug: parsed.slug, outcome: "invalid", issues: parsed.issues, warnings: parsed.warnings },
      new AppError("BROKER_INVALID", "La hoja Corredor tiene errores", {
        details: { issues: parsed.issues },
      }),
    );
  }

  const existing = await deps.brokers.findBySlug(parsed.data.slug);
  const outcome =
    existing === null ? "created" : brokerDiffers(existing, parsed.data) ? "updated" : "unchanged";
  let broker = existing;
  if (!run.dryRun && outcome === "created") broker = await deps.brokers.create(parsed.data);
  if (!run.dryRun && outcome === "updated" && existing !== null) {
    broker = await deps.brokers.update(existing.id, parsed.data);
  }
  return {
    broker,
    logoFile: parsed.logoFile,
    report: { slug: parsed.data.slug, outcome, issues: [], warnings: parsed.warnings },
  };
}

function countOutcomes(rows: readonly { outcome: ImportRowOutcome }[]): ImportCounts {
  const count = (outcome: ImportRowOutcome) => rows.filter((row) => row.outcome === outcome).length;
  return {
    rowsTotal: rows.filter((row) => row.outcome !== "ignored").length,
    rowsCreated: count("created"),
    rowsUpdated: count("updated"),
    rowsSkipped: count("skipped"),
    rowsFailed: count("failed"),
  };
}

/**
 * Lo que entra en `source_hash`: todo lo que la carga guarda o usa de la fila. Si cambia esta
 * composición (o un valor por defecto del validador), cada aviso sale `updated` una vez.
 */
const sourceHashOf = (deps: ImportListingsDeps, data: ValidatedListingRow) =>
  deps.sha256(
    canonicalJson({ core: data.core, attributes: data.attributes, control: data.control }),
  );

/** Una fila en curso: su resultado, sus errores y, si es válida, sus datos para escribir. */
type PlannedRow = { row: ImportedRow; errors: FieldIssue[]; data?: ValidatedListingRow };

const unsaved = (
  rowNumber: number,
  externalRef: string | null,
  outcome: "failed" | "ignored",
): ImportedRow => ({
  rowNumber,
  externalRef,
  outcome,
  listingId: null,
  status: null,
  control: null,
});

/**
 * Error de base que reintentar no arregla, en una sola fila (por ejemplo, un carácter que Postgres
 * rechaza): la fila queda `failed` y la carga sigue (§4.2). El motivo es genérico: el mensaje del
 * driver puede traer datos de la fila.
 */
function writeFailure(error: unknown): FieldIssue[] | null {
  if (!isAppError(error) || error.retriable) return null;
  return [
    {
      column: "",
      key: "",
      code: "FIELD_VALUE_INVALID",
      message: `No se pudo guardar la fila (${error.code})`,
    },
  ];
}

/**
 * Importa la hoja Propiedades (spec F1 §4.2) para un `import_run` ya creado:
 * 1. resuelve el corredor (hoja Corredor o `--broker` del run); con errores, `BROKER_INVALID`;
 * 2. arma el validador con las definiciones del corredor (`FIELD_CONFIG_INVALID` si no sirven);
 * 3. por fila: `ignored` (EJEMPLO/Borrador), `failed` (errores o `id_propiedad` repetido, sin
 *    escribir), o upsert por `external_ref` con `source_hash`: `created`, `updated` o `skipped`;
 * 4. registra contadores y reporte en el run, también en `dry_run`.
 *
 * Un aviso nuevo nace en `draft` y nunca se toca `status` (lo decide la ingesta de medios, T07).
 * Un error reintentable (`DB_UNAVAILABLE`, `LISTING_CONFLICT`) se propaga para que el job reintente;
 * reintentar es seguro porque todo se escribe por `external_ref` (lo ya creado sale `skipped`).
 */
export async function importListings(
  deps: ImportListingsDeps,
  { runId, input }: ImportListingsParams,
): Promise<ImportListingsResult> {
  const run = await deps.importRuns.get(runId);
  if (run === null) {
    throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${runId}`, {
      details: { runId },
    });
  }

  const brokerResolution = await resolveBroker(deps, run, input);
  const brokerId = brokerResolution.broker?.id ?? null;

  const definitions = await deps.fieldDefinitions.list({ category: CATEGORY, brokerId });
  const validator = buildListingValidator(definitions);
  const headers = validator.checkHeaders(input.headers);

  // 1ª pasada: filtrar y validar. Los `external_ref` salen del validador (una celda numérica como
  // `101` ya viene normalizada a texto), así la búsqueda de existentes no los pierde.
  const planned: PlannedRow[] = [];
  const firstRowOf = new Map<string, number>();
  for (const { rowNumber, raw } of input.rows) {
    const ref = validator.refOf(raw);
    if (validator.isIgnored(raw)) {
      planned.push({ row: unsaved(rowNumber, ref, "ignored"), errors: [] });
      continue;
    }
    const validation = validator.validate(raw);
    if (!validation.ok) {
      planned.push({ row: unsaved(rowNumber, ref, "failed"), errors: validation.errors });
      continue;
    }
    const externalRef = validation.data.core.externalRef;
    const firstRow = firstRowOf.get(externalRef);
    if (firstRow !== undefined) {
      planned.push({
        row: unsaved(rowNumber, externalRef, "failed"),
        errors: [
          {
            column: "id_propiedad",
            key: "id_propiedad",
            code: "FIELD_VALUE_INVALID",
            message: `«${externalRef}» ya aparece en la fila ${firstRow}`,
          },
        ],
      });
      continue;
    }
    firstRowOf.set(externalRef, rowNumber);
    planned.push({
      row: { ...unsaved(rowNumber, externalRef, "failed"), control: validation.data.control },
      errors: [],
      data: validation.data,
    });
  }

  // Avisos ya guardados de este corredor (en `dry_run` también, para simular el resultado).
  const existing = new Map<string, ListingImportRecord>(
    brokerId === null
      ? []
      : (await deps.listings.findByExternalRefs(brokerId, [...firstRowOf.keys()])).map(
          (listing) => [listing.externalRef, listing],
        ),
  );

  // 2ª pasada, en el orden de la hoja: upsert por `external_ref` con `source_hash`.
  for (const item of planned) {
    const { data, row } = item;
    if (data === undefined) continue;
    const sourceHash = await sourceHashOf(deps, data);
    const current = existing.get(data.core.externalRef);
    const listingData = { ...data.core, attributes: data.attributes, sourceHash };
    row.listingId = current?.id ?? null;
    row.status = current?.status ?? null;
    try {
      if (current === undefined) {
        row.outcome = "created";
        if (!run.dryRun && brokerId !== null) {
          const created = await deps.listings.create({
            ...listingData,
            brokerId,
            category: CATEGORY,
            source: run.source,
          });
          row.listingId = created.id;
          row.status = created.status;
        }
      } else if (current.sourceHash === sourceHash) {
        row.outcome = "skipped";
      } else {
        row.outcome = "updated";
        if (!run.dryRun) await deps.listings.update(current.id, listingData);
      }
    } catch (error) {
      const issues = writeFailure(error);
      if (issues === null) throw error;
      Object.assign(row, { outcome: "failed", listingId: null, status: null, control: null });
      item.errors = issues;
    }
  }

  const rows = planned.map(({ row }) => row);
  const counts = countOutcomes(rows);
  const report: ImportReport = {
    headers,
    broker: brokerResolution.report,
    rows: planned.map(({ row, errors }) => ({
      rowNumber: row.rowNumber,
      externalRef: row.externalRef,
      outcome: row.outcome,
      listingId: row.listingId,
      errors,
      warnings: [],
    })),
  };
  await deps.importRuns.recordListingsResult(runId, { brokerId, counts, report });
  return { brokerId, logoFile: brokerResolution.logoFile, rows, counts, report };
}
