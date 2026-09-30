import { z } from "zod";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import {
  CORE_FIELD_TARGETS,
  type CoreFieldTarget,
  isCoreFieldKey,
  type ListingControlFields,
  type ListingCoreFields,
  MODEL_REQUIRED_KEYS,
} from "./core-field-targets.js";
import {
  type FieldIssueCode,
  type FieldValue,
  foldText,
  isBlank,
  type Normalized,
  normalizeField,
  normalizeText,
  type RawCell,
} from "./normalizers.js";
import { resolveEffectiveDefinitions } from "./resolve-definitions.js";

/** Una fila del Excel: encabezado → celda, tal como la entrega el lector (F1-T03). */
export type RawListingRow = Readonly<Record<string, RawCell>>;

/** Error de validación de una celda: fila (la pone quien llama), columna y motivo. */
export type FieldIssue = { column: string; key: string; code: FieldIssueCode; message: string };

/** Atributos dinámicos (`listings.attributes`). `_extra` guarda las columnas desconocidas. */
export type ListingAttributes = Record<string, FieldValue | Record<string, string>>;

export type ValidatedListingRow = {
  core: ListingCoreFields;
  control: ListingControlFields;
  attributes: ListingAttributes;
};

export type RowValidation =
  | { ok: true; data: ValidatedListingRow }
  | { ok: false; errors: FieldIssue[] };

/** Revisión de los encabezados de la hoja, una vez por carga (no por fila). */
export type HeaderCheck = {
  /** Columnas sin definición: se reportan como advertencia y van a `attributes._extra`. */
  unknown: string[];
  /** Columnas de campos obligatorios que no están en la hoja. */
  missing: string[];
};

export type ListingValidator = {
  /** Definiciones efectivas (precedencia del corredor aplicada, solo activas), en orden. */
  definitions: FieldDefinition[];
  /** Esquema zod de la fila por `key` (no por encabezado): normaliza y valida cada campo. */
  schema: z.ZodType<Record<string, FieldValue | undefined>>;
  checkHeaders(headers: readonly string[]): HeaderCheck;
  validate(row: RawListingRow): RowValidation;
};

const EXTRA_KEY = "_extra";

function invalidDefinitions(message: string, details: Record<string, unknown>): AppError {
  return new AppError("FIELD_DEFINITIONS_INVALID", message, { details });
}

/** Errores de configuración que harían imposible armar un `listing`: se ven al inicio del run. */
function assertUsable(defs: readonly FieldDefinition[]): void {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  for (const key of MODEL_REQUIRED_KEYS) {
    const def = byKey.get(key);
    if (def === undefined || !def.isCore) {
      throw invalidDefinitions(`Falta la definición activa de ${key}, obligatoria del modelo`, {
        key,
      });
    }
  }
  const columns = new Map<string, string>();
  for (const def of defs) {
    if (def.isCore) {
      if (!isCoreFieldKey(def.key)) {
        throw invalidDefinitions(`El campo ${def.key} es is_core pero no tiene destino fijo`, {
          key: def.key,
        });
      }
      const target: CoreFieldTarget = CORE_FIELD_TARGETS[def.key];
      if (target.type !== def.type) {
        throw invalidDefinitions(`El campo ${def.key} debe ser de tipo ${target.type}`, {
          key: def.key,
          type: def.type,
        });
      }
    }
    if (def.type === "enum" && (def.options === null || def.options.length === 0)) {
      throw invalidDefinitions(`El campo ${def.key} es enum pero no tiene opciones`, {
        key: def.key,
      });
    }
    const column = foldText(def.sourceColumn);
    const other = columns.get(column);
    if (other !== undefined) {
      throw invalidDefinitions(`Los campos ${other} y ${def.key} leen la misma columna`, {
        column: def.sourceColumn,
      });
    }
    columns.set(column, def.key);
  }
}

/** Obligatorio por la definición o por el modelo (`listings` lo exige `NOT NULL`). */
function isRequired(def: FieldDefinition): boolean {
  return def.required || (MODEL_REQUIRED_KEYS as readonly string[]).includes(def.key);
}

/** Aplica la transformación y las reglas del destino fijo, si el campo lo tiene. */
function applyTarget(def: FieldDefinition, value: FieldValue): Normalized {
  if (!def.isCore || !isCoreFieldKey(def.key)) return { ok: true, value };
  const target: CoreFieldTarget = CORE_FIELD_TARGETS[def.key];
  if ("positive" in target && target.positive && typeof value === "number" && value <= 0) {
    return { ok: false, code: "FIELD_NUMBER_INVALID", message: "debe ser mayor que 0" };
  }
  if (target.map !== undefined && typeof value === "string") {
    const mapped = target.map[value];
    if (mapped === undefined) {
      return {
        ok: false,
        code: "FIELD_VALUE_INVALID",
        message: `«${value}» no tiene equivalente en el sistema (${Object.keys(target.map).join(", ")})`,
      };
    }
    return { ok: true, value: mapped };
  }
  return { ok: true, value };
}

function fieldSchema(def: FieldDefinition) {
  return z.unknown().transform((raw, ctx): FieldValue | undefined => {
    const cell = raw as RawCell;
    if (isBlank(cell)) {
      if (isRequired(def)) {
        ctx.addIssue({
          code: "custom",
          message: "falta el valor (es obligatorio)",
          params: { code: "FIELD_REQUIRED" },
        });
        return z.NEVER;
      }
      return undefined;
    }
    const normalized = normalizeField(def.type, cell, def.options);
    const result = normalized.ok ? applyTarget(def, normalized.value) : normalized;
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message, params: { code: result.code } });
      return z.NEVER;
    }
    return result.value;
  });
}

function buildCore(values: Record<string, FieldValue | undefined>): ListingCoreFields {
  const text = (key: string) => (values[key] as string | undefined) ?? null;
  return {
    externalRef: values.id_propiedad as string,
    operation: (values.operacion as ListingCoreFields["operation"] | undefined) ?? null,
    propertyType: text("tipo"),
    region: text("region"),
    comuna: text("comuna"),
    address: text("direccion"),
    unitNumber: text("numero_unidad"),
    showExactAddress: (values.mostrar_direccion_exacta as boolean | undefined) ?? false,
    priceAmount: values.precio as number,
    priceCurrency: values.moneda as ListingCoreFields["priceCurrency"],
    highlights: text("destacados"),
    internalNotes: text("notas_internas"),
  };
}

function buildControl(values: Record<string, FieldValue | undefined>): ListingControlFields {
  return {
    // Sin `estado_carga` (por ejemplo, desactivado por el corredor): lo seguro es `draft`.
    loadStatus: (values.estado_carga as ListingControlFields["loadStatus"] | undefined) ?? "draft",
    mediaFolder: (values.carpeta_medios as string | undefined) ?? null,
    coverFile: (values.foto_portada as string | undefined) ?? null,
  };
}

/**
 * Validador de filas construido desde `field_definitions` (ADR-0006, spec F1 §4.2): agregar un
 * campo es insertar una definición, sin cambiar código. Recibe lo que devuelve
 * `FieldDefinitionRepository.list` y aplica la precedencia del corredor.
 *
 * Lanza `FIELD_DEFINITIONS_INVALID` si las definiciones no permiten armar un `listing`.
 */
export function buildListingValidator(defs: readonly FieldDefinition[]): ListingValidator {
  const definitions = resolveEffectiveDefinitions(defs);
  assertUsable(definitions);

  const schema = z.object(
    Object.fromEntries(definitions.map((def) => [def.key, fieldSchema(def)])),
  );
  const byColumn = new Map(definitions.map((def) => [foldText(def.sourceColumn), def]));
  // Columnas de definiciones inactivas o sobrescritas: conocidas, se ignoran sin advertencia.
  const ignoredColumns = new Set(defs.map((def) => foldText(def.sourceColumn)));

  return {
    definitions,
    schema,

    checkHeaders(headers) {
      const present = new Set(headers.map(foldText));
      return {
        unknown: headers.filter((header) => !ignoredColumns.has(foldText(header))),
        missing: definitions
          .filter((def) => isRequired(def) && !present.has(foldText(def.sourceColumn)))
          .map((def) => def.sourceColumn),
      };
    },

    validate(row) {
      const input: Record<string, RawCell> = {};
      const extra: Record<string, string> = {};
      for (const [header, cell] of Object.entries(row)) {
        const def = byColumn.get(foldText(header));
        if (def !== undefined) {
          input[def.key] = cell;
        } else if (!ignoredColumns.has(foldText(header)) && !isBlank(cell)) {
          const text = normalizeText(cell);
          if (text.ok) extra[header.trim()] = text.value;
        }
      }

      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue): FieldIssue => {
          const key = String(issue.path[0] ?? "");
          const def = definitions.find((candidate) => candidate.key === key);
          const params = (issue as { params?: { code?: FieldIssueCode } }).params;
          return {
            column: def?.sourceColumn ?? key,
            key,
            code: params?.code ?? "FIELD_VALUE_INVALID",
            message: issue.message,
          };
        });
        return { ok: false, errors };
      }

      const values = parsed.data;
      const attributes: ListingAttributes = {};
      for (const def of definitions) {
        const value = values[def.key];
        if (!def.isCore && value !== undefined) attributes[def.key] = value;
      }
      if (Object.keys(extra).length > 0) attributes[EXTRA_KEY] = extra;
      return {
        ok: true,
        data: { core: buildCore(values), control: buildControl(values), attributes },
      };
    },
  };
}

export {
  CORE_FIELD_TARGETS,
  type CoreFieldKey,
  type CoreFieldTarget,
  isCoreFieldKey,
  type ListingControlFields,
  type ListingCoreFields,
  MODEL_REQUIRED_KEYS,
} from "./core-field-targets.js";
export {
  FIELD_ISSUE_CODES,
  type FieldIssueCode,
  type FieldValue,
  foldText,
  isBlank,
  type Normalized,
  normalizeField,
  type RawCell,
} from "./normalizers.js";
export { resolveEffectiveDefinitions } from "./resolve-definitions.js";
