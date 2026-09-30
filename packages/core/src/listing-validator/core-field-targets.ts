import type { Currency, FieldType, Operation } from "../enums.js";

/** Estado inicial que pide la columna `estado_carga`. */
export type LoadStatus = "draft" | "ready";

/** Columnas fijas de `listings` que llena el Excel (spec F1 §4.2). */
export type ListingCoreFields = {
  externalRef: string;
  operation: Operation | null;
  propertyType: string | null;
  region: string | null;
  comuna: string | null;
  address: string | null;
  unitNumber: string | null;
  showExactAddress: boolean;
  priceAmount: number;
  priceCurrency: Currency;
  highlights: string | null;
  /** Nunca va a la IA ni a las plataformas. */
  internalNotes: string | null;
};

/** Columnas que controlan la carga y no se guardan en `attributes`. */
export type ListingControlFields = {
  /** `estado_carga`: `Listo` → `ready`, `Borrador` → `draft`. */
  loadStatus: LoadStatus;
  /** `carpeta_medios`; si viene vacía, la ingesta usa `id_propiedad` (§4.3). */
  mediaFolder: string | null;
  /** `foto_portada`. */
  coverFile: string | null;
};

type CoreTarget = {
  section: "core";
  field: keyof ListingCoreFields;
  /** Tipo que debe tener la definición para que el valor calce con la columna. */
  type: FieldType;
  /** `NOT NULL` en `listings`: obligatorio aunque la definición diga lo contrario. */
  modelRequired?: true;
  /** Opción del Excel → valor guardado. Toda opción de la definición debe tener equivalente. */
  map?: Readonly<Record<string, string>>;
  /** Debe ser mayor que 0. */
  positive?: true;
  /** Máximo que cabe en la columna. */
  max?: number;
};
type ControlTarget = {
  section: "control";
  field: keyof ListingControlFields;
  type: FieldType;
  map?: Readonly<Record<string, string>>;
};
export type CoreFieldTarget = CoreTarget | ControlTarget;

// Los valores de cada mapa están tipados: un error de tipeo (`"sal"`) no compila.
const OPERATION_MAP = { Venta: "sale", Arriendo: "rent" } as const satisfies Record<
  string,
  Operation
>;
const CURRENCY_MAP = { UF: "UF", CLP: "CLP" } as const satisfies Record<string, Currency>;
const LOAD_STATUS_MAP = { Borrador: "draft", Listo: "ready" } as const satisfies Record<
  string,
  LoadStatus
>;

/** `price_amount` es `numeric(14,2)`: 12 dígitos enteros como máximo. */
const MAX_PRICE = 999_999_999_999.99;

/**
 * `key` de una definición con `is_core = true` → su destino. Estas `key` deben ser siempre
 * `is_core`, y un `is_core` que no esté aquí es un error de configuración (`FIELD_CONFIG_INVALID`).
 */
export const CORE_FIELD_TARGETS = {
  id_propiedad: { section: "core", field: "externalRef", type: "text", modelRequired: true },
  operacion: { section: "core", field: "operation", type: "enum", map: OPERATION_MAP },
  tipo: { section: "core", field: "propertyType", type: "enum" },
  region: { section: "core", field: "region", type: "text" },
  comuna: { section: "core", field: "comuna", type: "text" },
  direccion: { section: "core", field: "address", type: "text" },
  numero_unidad: { section: "core", field: "unitNumber", type: "text" },
  mostrar_direccion_exacta: { section: "core", field: "showExactAddress", type: "boolean" },
  precio: {
    section: "core",
    field: "priceAmount",
    type: "number",
    modelRequired: true,
    positive: true,
    max: MAX_PRICE,
  },
  moneda: {
    section: "core",
    field: "priceCurrency",
    type: "enum",
    modelRequired: true,
    map: CURRENCY_MAP,
  },
  destacados: { section: "core", field: "highlights", type: "text" },
  notas_internas: { section: "core", field: "internalNotes", type: "text" },
  estado_carga: { section: "control", field: "loadStatus", type: "enum", map: LOAD_STATUS_MAP },
  carpeta_medios: { section: "control", field: "mediaFolder", type: "text" },
  foto_portada: { section: "control", field: "coverFile", type: "text" },
} as const satisfies Record<string, CoreFieldTarget>;

export type CoreFieldKey = keyof typeof CORE_FIELD_TARGETS;

export function isCoreFieldKey(key: string): key is CoreFieldKey {
  return Object.hasOwn(CORE_FIELD_TARGETS, key);
}

export function coreTarget(key: CoreFieldKey): CoreFieldTarget {
  return CORE_FIELD_TARGETS[key];
}

/** Obligatorios del modelo: la carga no puede armar un `listing` sin ellos. */
export const MODEL_REQUIRED_KEYS = (Object.keys(CORE_FIELD_TARGETS) as CoreFieldKey[]).filter(
  (key) => {
    const target = coreTarget(key);
    return target.section === "core" && target.modelRequired === true;
  },
);

/** `id_propiedad` de la fila de ejemplo de la plantilla, que nunca se importa. */
export const EXAMPLE_EXTERNAL_REF = "EJEMPLO";
