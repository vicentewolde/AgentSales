import { z } from "zod";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import {
  CORE_FIELD_TARGETS,
  type CoreFieldTarget,
  coreTarget,
  EXAMPLE_EXTERNAL_REF,
  isCoreFieldKey,
  type ListingControlFields,
  type ListingCoreFields,
  MODEL_REQUIRED_KEYS,
} from "./core-field-targets.js";
import {
  FIELD_ISSUE_CODES,
  type FieldIssueCode,
  type FieldValue,
  foldText,
  isBlank,
  isRawCell,
  type Normalized,
  normalizeField,
  normalizeText,
  type RawCell,
} from "./normalizers.js";
import { resolveEffectiveDefinitions } from "./resolve-definitions.js";

/**
 * Una fila del Excel: encabezado → celda, tal como la entrega el lector (F1-T03). El validador
 * igual revisa cada valor en tiempo de ejecución: lo que no sea `RawCell` es `FIELD_VALUE_INVALID`.
 */
export type RawListingRow = Readonly<Record<string, RawCell>>;

/**
 * Error de validación de una celda: columna, `key`, código y motivo. La fila la agrega quien llama.
 * Es un esquema zod porque viaja en `import_runs.report` y por HTTP (ADR-0011).
 */
export const fieldIssueSchema = z.object({
  column: z.string(),
  key: z.string(),
  code: z.enum(FIELD_ISSUE_CODES),
  message: z.string(),
});
export type FieldIssue = z.infer<typeof fieldIssueSchema>;

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

/** Revisión de los encabezados de la hoja, una vez por carga (no por fila). Ignora los vacíos. */
export type HeaderCheck = {
  /** Columnas sin definición: se reportan como advertencia y van a `attributes._extra`. */
  unknown: string[];
  /** Columnas de campos obligatorios que no están en la hoja. */
  missing: string[];
  /** Encabezados que se repiten sin contar mayúsculas, tildes ni espacios: vale el primero. */
  duplicated: string[];
};

export type ListingValidator = {
  /** Definiciones efectivas (precedencia del corredor aplicada, solo activas), en orden. */
  definitions: FieldDefinition[];
  /**
   * Esquema zod por `key` (no por encabezado) que normaliza y valida cada campo. Es el motor de
   * `validate`: **no lo reemplaza**, porque no empareja columnas ni arma `_extra`.
   */
  schema: z.ZodType<Record<string, FieldValue | undefined>>;
  checkHeaders(headers: readonly string[]): HeaderCheck;
  /** `true` para la fila de ejemplo (`id_propiedad = EJEMPLO`) y las de `estado_carga = Borrador`. */
  isIgnored(row: RawListingRow): boolean;
  validate(row: RawListingRow): RowValidation;
};

const EXTRA_KEY = "_extra";
/** `key` en snake_case: descarta `_extra` (reservada) y claves como `__proto__`. */
const KEY_FORMAT = /^[a-z][a-z0-9_]*$/;

function invalidConfig(message: string, details: Record<string, unknown>): AppError {
  return new AppError("FIELD_CONFIG_INVALID", message, { details });
}

/** Errores de configuración que harían imposible armar un `listing`: se ven al inicio del run. */
function assertUsable(defs: readonly FieldDefinition[]): void {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  for (const key of MODEL_REQUIRED_KEYS) {
    if (byKey.get(key) === undefined) {
      throw invalidConfig(`Falta la definición activa de ${key}, obligatoria del modelo`, { key });
    }
  }
  const columns = new Map<string, string>();
  for (const def of defs) {
    if (!KEY_FORMAT.test(def.key)) {
      throw invalidConfig(`La clave ${def.key} no es válida (minúsculas, números y _)`, {
        key: def.key,
      });
    }
    // Un destino fijo como atributo duplicaría el dato (y `notas_internas` llegaría a la IA).
    if (isCoreFieldKey(def.key) !== def.isCore) {
      throw invalidConfig(
        def.isCore
          ? `El campo ${def.key} es is_core pero no tiene destino fijo`
          : `El campo ${def.key} tiene destino fijo y debe ser is_core`,
        { key: def.key },
      );
    }
    if (def.type === "enum" && (def.options === null || def.options.length === 0)) {
      throw invalidConfig(`El campo ${def.key} es enum pero no tiene opciones`, { key: def.key });
    }
    if (isCoreFieldKey(def.key)) {
      const target = coreTarget(def.key);
      if (target.type !== def.type) {
        throw invalidConfig(`El campo ${def.key} debe ser de tipo ${target.type}`, {
          key: def.key,
          type: def.type,
        });
      }
      const unmapped = (def.options ?? []).filter(
        (option) => target.map !== undefined && mapLookup(target.map, option) === undefined,
      );
      if (unmapped.length > 0) {
        throw invalidConfig(
          `Las opciones ${unmapped.join(", ")} de ${def.key} no tienen equivalente en el sistema`,
          { key: def.key, options: unmapped },
        );
      }
    }
    const column = foldText(def.sourceColumn);
    const other = columns.get(column);
    if (other !== undefined) {
      throw invalidConfig(`Los campos ${other} y ${def.key} leen la misma columna`, {
        key: def.key,
        column: def.sourceColumn,
      });
    }
    columns.set(column, def.key);
  }
}

/** Busca en el mapa sin mayúsculas ni tildes: las opciones del corredor pueden escribirse distinto. */
function mapLookup(map: Readonly<Record<string, string>>, value: string): string | undefined {
  const folded = foldText(value);
  const entry = Object.entries(map).find(([option]) => foldText(option) === folded);
  return entry?.[1];
}

/** Obligatorio por la definición o por el modelo (`listings` lo exige `NOT NULL`). */
function isRequired(def: FieldDefinition): boolean {
  return def.required || (MODEL_REQUIRED_KEYS as readonly string[]).includes(def.key);
}

/** Aplica la transformación y las reglas del destino fijo, si el campo lo tiene. */
function applyTarget(def: FieldDefinition, value: FieldValue): Normalized {
  if (!isCoreFieldKey(def.key)) return { ok: true, value };
  const target: CoreFieldTarget = coreTarget(def.key);
  if (target.section === "core" && typeof value === "number") {
    if (target.positive && value <= 0) {
      return { ok: false, code: "FIELD_NUMBER_INVALID", message: "debe ser mayor que 0" };
    }
    if (target.max !== undefined && value > target.max) {
      return { ok: false, code: "FIELD_NUMBER_INVALID", message: "es demasiado grande" };
    }
  }
  if (target.map !== undefined && typeof value === "string") {
    const mapped = mapLookup(target.map, value);
    // `assertUsable` ya exigió que toda opción tenga equivalente; esto es solo una red.
    if (mapped === undefined) {
      return {
        ok: false,
        code: "FIELD_VALUE_INVALID",
        message: `«${value}» no tiene equivalente en el sistema`,
      };
    }
    return { ok: true, value: mapped };
  }
  return { ok: true, value };
}

function isFieldIssueCode(value: unknown): value is FieldIssueCode {
  return (FIELD_ISSUE_CODES as readonly unknown[]).includes(value);
}

/** El código de un issue que armó `fieldSchema` (va en `params.code`). */
function issueCode(issue: z.core.$ZodIssue): FieldIssueCode {
  const code: unknown = "params" in issue ? issue.params?.code : undefined;
  return isFieldIssueCode(code) ? code : "FIELD_VALUE_INVALID";
}

function fieldSchema(def: FieldDefinition) {
  return z.unknown().transform((raw, ctx): FieldValue | undefined => {
    const fail = (code: FieldIssueCode, message: string) => {
      ctx.addIssue({ code: "custom", message, params: { code } });
      return z.NEVER;
    };
    if (!isRawCell(raw)) {
      return fail("FIELD_VALUE_INVALID", "la celda tiene un formato que no se puede leer");
    }
    const normalized = isBlank(raw) ? undefined : normalizeField(def.type, raw, def.options);
    if (normalized !== undefined && !normalized.ok) {
      return fail(normalized.code, normalized.message);
    }
    // Una lista con solo separadores (`","`) cuenta como vacía.
    const value =
      normalized !== undefined && !(Array.isArray(normalized.value) && !normalized.value.length)
        ? normalized.value
        : undefined;
    if (value === undefined) {
      return isRequired(def)
        ? fail("FIELD_REQUIRED", "falta el valor (es obligatorio)")
        : undefined;
    }
    const result = applyTarget(def, value);
    return result.ok ? result.value : fail(result.code, result.message);
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
    // Sin valor, no se muestra la dirección exacta (regla editorial `show_exact_address`).
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
 * Lanza `FIELD_CONFIG_INVALID` si las definiciones no permiten armar un `listing`.
 */
export function buildListingValidator(defs: readonly FieldDefinition[]): ListingValidator {
  const definitions = resolveEffectiveDefinitions(defs);
  assertUsable(definitions);

  const schema = z.object(
    Object.fromEntries(definitions.map((def) => [def.key, fieldSchema(def)])),
  );
  const byColumn = new Map(definitions.map((def) => [foldText(def.sourceColumn), def]));
  const byKey = new Map(definitions.map((def) => [def.key, def]));
  // Columnas de definiciones inactivas o sobrescritas: conocidas, se ignoran sin advertencia.
  const knownColumns = new Set(defs.map((def) => foldText(def.sourceColumn)));

  /** Celda de la fila para una definición, emparejando el encabezado sin mayúsculas ni tildes. */
  const cellFor = (row: RawListingRow, key: string): unknown => {
    const def = byKey.get(key);
    if (def === undefined) return undefined;
    const column = foldText(def.sourceColumn);
    const header = Object.keys(row).find((candidate) => foldText(candidate) === column);
    return header === undefined ? undefined : row[header];
  };

  return {
    definitions,
    schema,

    checkHeaders(headers) {
      const nonBlank = headers.filter((header) => !isBlank(header));
      const seen = new Set<string>();
      const duplicated: string[] = [];
      for (const header of nonBlank) {
        const folded = foldText(header);
        if (seen.has(folded)) duplicated.push(header);
        seen.add(folded);
      }
      return {
        unknown: nonBlank.filter((header) => !knownColumns.has(foldText(header))),
        missing: definitions
          .filter((def) => isRequired(def) && !seen.has(foldText(def.sourceColumn)))
          .map((def) => def.sourceColumn),
        duplicated,
      };
    },

    isIgnored(row) {
      const ref = cellFor(row, "id_propiedad");
      if (typeof ref === "string" && foldText(ref) === foldText(EXAMPLE_EXTERNAL_REF)) return true;
      const status = cellFor(row, "estado_carga");
      const estadoCarga = CORE_FIELD_TARGETS.estado_carga.map;
      return (
        typeof status === "string" &&
        byKey.has("estado_carga") &&
        mapLookup(estadoCarga, status) === "draft"
      );
    },

    validate(row) {
      // Toda definición efectiva tiene clave, aunque su columna no esté en la hoja: zod 4 rechaza
      // las claves ausentes, y un campo opcional sin columna no debe hacer fallar la fila.
      const input: Record<string, unknown> = Object.fromEntries(
        definitions.map((def) => [def.key, undefined]),
      );
      const assigned = new Set<string>();
      // `Object.create(null)`: un encabezado del usuario como `__proto__` no se pierde.
      const extra: Record<string, string> = Object.create(null);
      for (const [header, cell] of Object.entries(row)) {
        if (isBlank(header)) continue;
        const def = byColumn.get(foldText(header));
        if (def !== undefined) {
          // Encabezado repetido (`Precio` y `precio`): vale el primero (`checkHeaders.duplicated`).
          if (!assigned.has(def.key)) input[def.key] = cell;
          assigned.add(def.key);
        } else if (!knownColumns.has(foldText(header)) && isRawCell(cell) && !isBlank(cell)) {
          const text = normalizeText(cell);
          if (text.ok) extra[header.trim()] = text.value;
        }
      }

      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue): FieldIssue => {
          const key = String(issue.path[0] ?? "");
          return {
            column: byKey.get(key)?.sourceColumn ?? key,
            key,
            code: issueCode(issue),
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
  type ListingControlFields,
  type ListingCoreFields,
  type LoadStatus,
} from "./core-field-targets.js";
export {
  FIELD_ISSUE_CODES,
  type FieldIssueCode,
  type FieldValue,
  type RawCell,
} from "./normalizers.js";
