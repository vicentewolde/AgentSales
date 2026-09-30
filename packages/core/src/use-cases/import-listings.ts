import { type Broker, brokerDiffers, parseBrokerSheet } from "../broker.js";
import { canonicalJson } from "../canonical-json.js";
import type { ListingCategory } from "../enums.js";
import { AppError } from "../errors.js";
import type { ImportCounts, ImportReport, ImportRowOutcome } from "../import-run.js";
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
  /** El `import_run` ya creado (lo crea `requestImport`, F1-T09). */
  runId: string;
  input: ListingSheetInput;
  /** `--broker`: gana sobre el slug de la hoja, y los datos de la hoja actualizan ese corredor. */
  brokerSlug?: string;
  /** Valida y reporta lo que pasaría, sin escribir nada salvo el `import_run`. */
  dryRun: boolean;
};

export type ImportedRow = {
  rowNumber: number;
  externalRef: string | null;
  outcome: ImportRowOutcome;
  /** `null` en `dry_run` para un aviso nuevo, y en las filas `failed` o `ignored`. */
  listingId: string | null;
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

async function resolveBroker(
  deps: ImportListingsDeps,
  params: ImportListingsParams,
  headers: ImportReport["headers"],
): Promise<BrokerResolution> {
  const { input, brokerSlug, dryRun } = params;
  if (input.broker === null) {
    if (brokerSlug === undefined) {
      throw new AppError(
        "BROKER_INVALID",
        "Falta la hoja Corredor: complétala o indica un corredor existente (--broker)",
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

  const parsed = parseBrokerSheet(
    input.broker,
    brokerSlug === undefined ? {} : { slug: brokerSlug },
  );
  if (!parsed.ok) {
    // El detalle queda en el reporte del run antes de fallar (spec F1 §4.2).
    await deps.importRuns.recordListingsResult(params.runId, {
      brokerId: null,
      counts: countOutcomes([]),
      report: {
        headers,
        broker: {
          slug: brokerSlug ?? null,
          outcome: "invalid",
          issues: parsed.issues,
          warnings: parsed.warnings,
        },
        rows: [],
      },
    });
    throw new AppError("BROKER_INVALID", "La hoja Corredor tiene errores", {
      details: { issues: parsed.issues },
    });
  }

  const existing = await deps.brokers.findBySlug(parsed.data.slug);
  const outcome =
    existing === null ? "created" : brokerDiffers(existing, parsed.data) ? "updated" : "unchanged";
  let broker = existing;
  if (!dryRun && outcome === "created") broker = await deps.brokers.create(parsed.data);
  if (!dryRun && outcome === "updated" && existing !== null) {
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

/** Lo que entra en `source_hash`: todo lo que la carga guarda o usa de la fila. */
const sourceHashOf = (deps: ImportListingsDeps, data: ValidatedListingRow) =>
  deps.sha256(
    canonicalJson({ core: data.core, attributes: data.attributes, control: data.control }),
  );

/**
 * Importa la hoja Propiedades (spec F1 §4.2) para un `import_run` ya creado:
 * 1. resuelve el corredor (hoja Corredor o `brokerSlug`); con errores, `BROKER_INVALID`;
 * 2. arma el validador con las definiciones del corredor (`FIELD_CONFIG_INVALID` si no sirven);
 * 3. por fila: `ignored` (EJEMPLO/Borrador), `failed` (errores o `id_propiedad` repetido, sin
 *    escribir), o upsert por `external_ref` con `source_hash`: `created`, `updated` o `skipped`;
 * 4. registra contadores y reporte en el run, también en `dry_run`.
 *
 * Un aviso nuevo nace en `draft` y nunca se toca `status` (lo decide la ingesta de medios, T07).
 * Un error de conexión (`DB_UNAVAILABLE`) se propaga para que el job reintente; reintentar es
 * seguro porque todo se escribe por `external_ref` (lo ya creado sale `skipped`).
 */
export async function importListings(
  deps: ImportListingsDeps,
  params: ImportListingsParams,
): Promise<ImportListingsResult> {
  const run = await deps.importRuns.get(params.runId);
  if (run === null) {
    throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${params.runId}`, {
      details: { runId: params.runId },
    });
  }

  const emptyHeaders = { unknown: [], missing: [], duplicated: [] };
  const brokerResolution = await resolveBroker(deps, params, emptyHeaders);
  const brokerId = brokerResolution.broker?.id ?? null;

  const definitions = await deps.fieldDefinitions.list({ category: CATEGORY, brokerId });
  const validator = buildListingValidator(definitions);
  const headers = validator.checkHeaders(params.input.headers);

  const rows: ImportedRow[] = [];
  const reportRows: ImportReport["rows"] = [];
  const push = (row: ImportedRow, errors: FieldIssue[] = []) => {
    rows.push(row);
    reportRows.push({
      rowNumber: row.rowNumber,
      externalRef: row.externalRef,
      outcome: row.outcome,
      errors,
    });
  };

  // 1ª pasada: filtrar y validar. Los `external_ref` salen del validador (una celda numérica como
  // `101` ya viene normalizada a texto), así la búsqueda de existentes no los pierde.
  type Valid = { rowNumber: number; data: ValidatedListingRow };
  const valid: (Valid | ImportedRow)[] = [];
  const pending: { row: ImportedRow; errors: FieldIssue[] }[] = [];
  const seenRefs = new Map<string, number>();
  for (const { rowNumber, raw } of params.input.rows) {
    const rawRef = typeof raw.id_propiedad === "string" ? raw.id_propiedad.trim() : null;
    if (validator.isIgnored(raw)) {
      valid.push({
        rowNumber,
        externalRef: rawRef,
        outcome: "ignored",
        listingId: null,
        control: null,
      });
      continue;
    }
    const validation = validator.validate(raw);
    if (!validation.ok) {
      const row: ImportedRow = {
        rowNumber,
        externalRef: rawRef,
        outcome: "failed",
        listingId: null,
        control: null,
      };
      valid.push(row);
      pending.push({ row, errors: validation.errors });
      continue;
    }
    const externalRef = validation.data.core.externalRef;
    const firstRow = seenRefs.get(externalRef);
    if (firstRow !== undefined) {
      const row: ImportedRow = {
        rowNumber,
        externalRef,
        outcome: "failed",
        listingId: null,
        control: null,
      };
      valid.push(row);
      pending.push({
        row,
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
    seenRefs.set(externalRef, rowNumber);
    valid.push({ rowNumber, data: validation.data });
  }
  const errorsOf = new Map(pending.map(({ row, errors }) => [row, errors]));

  // Avisos ya guardados de este corredor (en `dry_run` también, para simular el resultado).
  const existing = new Map<string, ListingImportRecord>(
    brokerId === null
      ? []
      : (await deps.listings.findByExternalRefs(brokerId, [...seenRefs.keys()])).map((listing) => [
          listing.externalRef,
          listing,
        ]),
  );

  // 2ª pasada, en el orden de la hoja: upsert por `external_ref` con `source_hash`.
  for (const entry of valid) {
    if (!("data" in entry)) {
      push(entry, errorsOf.get(entry) ?? []);
      continue;
    }
    const { rowNumber, data } = entry;
    const externalRef = data.core.externalRef;
    const sourceHash = await sourceHashOf(deps, data);
    const current = existing.get(externalRef);
    const listingData = { ...data.core, attributes: data.attributes, sourceHash };
    let outcome: ImportRowOutcome;
    let listingId: string | null = current?.id ?? null;
    if (current === undefined) {
      outcome = "created";
      if (!params.dryRun && brokerId !== null) {
        const created = await deps.listings.create({
          ...listingData,
          brokerId,
          category: CATEGORY,
          source: "xlsx",
        });
        listingId = created.id;
      }
    } else if (current.sourceHash === sourceHash) {
      outcome = "skipped";
    } else {
      outcome = "updated";
      if (!params.dryRun) await deps.listings.update(current.id, listingData);
    }
    push({ rowNumber, externalRef, outcome, listingId, control: data.control });
  }

  const counts = countOutcomes(rows);
  const report: ImportReport = { headers, broker: brokerResolution.report, rows: reportRows };
  await deps.importRuns.recordListingsResult(params.runId, { brokerId, counts, report });
  return { brokerId, logoFile: brokerResolution.logoFile, rows, counts, report };
}
