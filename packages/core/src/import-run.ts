import { z } from "zod";
import { IMPORT_RUN_STATUSES, LISTING_SOURCES } from "./enums.js";
import { fieldIssueSchema } from "./listing-validator/index.js";

/** Resultado de una fila de la hoja Propiedades. `ignored`: fila `EJEMPLO` o `Borrador`. */
export const IMPORT_ROW_OUTCOMES = ["created", "updated", "skipped", "failed", "ignored"] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

/**
 * Resultado del corredor. `existing`: se usó uno ya creado (`--broker` sin hoja Corredor);
 * `invalid`: la hoja tiene errores y el run falla con `BROKER_INVALID`.
 */
export const IMPORT_BROKER_OUTCOMES = [
  "created",
  "updated",
  "unchanged",
  "existing",
  "invalid",
] as const;
export type ImportBrokerOutcome = (typeof IMPORT_BROKER_OUTCOMES)[number];

/**
 * Reporte de una carga (`import_runs.report`, ADR-0011): viaja por HTTP y lo muestran la CLI y el
 * panel. Con `dry_run`, los resultados son los que **habría** tenido la carga. Los campos nuevos
 * se agregan como opcionales (como `media`, de F1-T07), para que los reportes ya guardados en
 * jsonb sigan validando.
 */
export const importReportSchema = z.object({
  /** `null` si la carga falló antes de revisar la hoja (por ejemplo, `BROKER_INVALID`). */
  headers: z
    .object({
      unknown: z.array(z.string()),
      missing: z.array(z.string()),
      duplicated: z.array(z.string()),
    })
    .nullable(),
  broker: z
    .object({
      slug: z.string().nullable(),
      outcome: z.enum(IMPORT_BROKER_OUTCOMES),
      issues: z.array(fieldIssueSchema),
      warnings: z.array(z.string()),
    })
    .nullable(),
  rows: z.array(
    z.object({
      rowNumber: z.number().int(),
      externalRef: z.string().nullable(),
      outcome: z.enum(IMPORT_ROW_OUTCOMES),
      /** Para enlazar al detalle; `null` si la fila no se guardó (o en `dry_run`, si es nueva). */
      listingId: z.string().nullable(),
      errors: z.array(fieldIssueSchema),
      warnings: z.array(z.string()),
    }),
  ),
  /**
   * Resumen de la ingesta de medios (F1-T07), sin el logo; falta si la carga no llegó a esa etapa.
   * Las advertencias de cada archivo van en `rows[].warnings` (las del logo, en `broker.warnings`).
   */
  media: z
    .object({
      /** Subidos (en `dry_run`: los que se subirían). */
      filesUploaded: z.number().int(),
      /** Ya estaban en el aviso (mismo sha256): no se vuelven a subir. */
      filesExisting: z.number().int(),
      /** No aceptados (tipo, firma, vacío, tamaño…) o repetidos dentro de la carpeta. */
      filesSkipped: z.number().int(),
      /** Aceptados que no se pudieron subir (se leyeron mal o cambiaron mientras se subían). */
      filesFailed: z.number().int(),
    })
    .optional(),
});
export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportMediaCounts = NonNullable<ImportReport["media"]>;

/** Contadores de `import_runs`. `rowsTotal` no cuenta las filas `ignored`. */
export type ImportCounts = {
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
};

/**
 * Entrada de una carga de antes de F8 (`import_runs.input`): rutas locales del staging compartido
 * o de la CLI. Se sigue leyendo (el historial la muestra), pero nunca se reintenta: el worker la
 * cierra con `IMPORT_INPUT_LEGACY` (spec F8 §4.4, ADR-0025).
 */
export const legacyImportRunInputSchema = z.object({
  /** Ruta absoluta del xlsx (en `tmp/imports/{id}/input/` o la que pasó la CLI). */
  xlsxPath: z.string().min(1),
  /** Carpeta o zip de medios; `null` si no se pasó. */
  mediaDir: z.string().min(1).nullable(),
  /** `--broker`: slug de un corredor; `null` si sale de la hoja Corredor. */
  broker: z.string().min(1).nullable(),
});
export type LegacyImportRunInput = z.infer<typeof legacyImportRunInputSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Un archivo de una carpeta de medios subido a R2: su ruta relativa (con `/`) y su tamaño. */
export const uploadedMediaFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Los de hasta 100 MB lo traen (spec F8 §4.4). */
  sha256: sha256Schema.optional(),
});
export type UploadedMediaFile = z.infer<typeof uploadedMediaFileSchema>;

/**
 * Entrada de una carga subida directo a R2 (spec F8 §4.4 y §4.12, ADR-0025): las claves de R2 de la
 * planilla y de los medios (un zip, o los archivos de una carpeta bajo `prefix`). Sin rutas del
 * disco: la API y el worker no comparten uno.
 */
export const uploadImportRunInputSchema = z.object({
  /** Slug del corredor pedido (o el del usuario corredor); `null` si sale de la hoja Corredor. */
  broker: z.string().min(1).nullable(),
  dryRun: z.boolean(),
  xlsx: z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().positive(),
    sha256: sha256Schema,
  }),
  media: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("zip"),
        key: z.string().min(1),
        name: z.string().min(1),
        size: z.number().int().positive(),
      }),
      z.object({
        kind: z.literal("folder"),
        /** `imports/<id>/media/`: cada archivo está en `<prefix><path>`. */
        prefix: z.string().min(1),
        /** El nombre de la carpeta elegida (solo para mostrarlo). */
        name: z.string().min(1),
        files: z.array(uploadedMediaFileSchema).min(1),
      }),
    ])
    .nullable(),
});
export type UploadImportRunInput = z.infer<typeof uploadImportRunInputSchema>;
export type UploadedMedia = NonNullable<UploadImportRunInput["media"]>;

/**
 * Entrada de una carga (`import_runs.input`): el job `import.run` recibe solo el id y la relee de
 * aquí (spec F1 §4.5). Una unión (spec F8 §4.12): la forma de F8, con claves de R2, o la de antes.
 */
export const importRunInputSchema = z.union([
  uploadImportRunInputSchema,
  legacyImportRunInputSchema,
]);
export type ImportRunInput = z.infer<typeof importRunInputSchema>;

export const isUploadImportInput = (input: ImportRunInput): input is UploadImportRunInput =>
  "xlsx" in input;

/** Lo que muestran la API, la CLI y el panel de la entrada: nombres, nunca rutas ni claves. */
export function importInputSummary(input: ImportRunInput): {
  xlsxFile: string;
  mediaFile: string | null;
  broker: string | null;
} {
  if (isUploadImportInput(input)) {
    return {
      xlsxFile: input.xlsx.name,
      mediaFile: input.media?.name ?? null,
      broker: input.broker,
    };
  }
  const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return {
    xlsxFile: nameOf(input.xlsxPath),
    mediaFile: input.mediaDir === null ? null : nameOf(input.mediaDir),
    broker: input.broker,
  };
}

/** Carga (`import_runs`): la entidad que devuelve el repositorio. */
export const importRunSchema = z.object({
  id: z.string(),
  brokerId: z.string().nullable(),
  status: z.enum(IMPORT_RUN_STATUSES),
  dryRun: z.boolean(),
  source: z.enum(LISTING_SOURCES),
  fileName: z.string(),
  input: importRunInputSchema,
  rowsTotal: z.number().int(),
  rowsCreated: z.number().int(),
  rowsUpdated: z.number().int(),
  rowsSkipped: z.number().int(),
  rowsFailed: z.number().int(),
  /** `null` hasta que `importListings` registra su resultado. */
  report: importReportSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ImportRun = z.infer<typeof importRunSchema>;
