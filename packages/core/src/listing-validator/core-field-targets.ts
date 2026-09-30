import type { Currency, FieldType, Operation } from "../enums.js";

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
  loadStatus: "draft" | "ready";
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
  /** Opción del Excel → valor guardado. */
  map?: Readonly<Record<string, string>>;
  positive?: true;
};
type ControlTarget = {
  section: "control";
  field: keyof ListingControlFields;
  type: FieldType;
  map?: Readonly<Record<string, string>>;
};
export type CoreFieldTarget = CoreTarget | ControlTarget;

/**
 * `key` de una definición con `is_core = true` → su destino. Una definición `is_core` cuyo `key`
 * no está aquí es un error de configuración (`FIELD_DEFINITIONS_INVALID`).
 */
export const CORE_FIELD_TARGETS = {
  id_propiedad: { section: "core", field: "externalRef", type: "text", modelRequired: true },
  operacion: {
    section: "core",
    field: "operation",
    type: "enum",
    map: { Venta: "sale", Arriendo: "rent" },
  },
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
  },
  moneda: {
    section: "core",
    field: "priceCurrency",
    type: "enum",
    modelRequired: true,
    map: { UF: "UF", CLP: "CLP" },
  },
  destacados: { section: "core", field: "highlights", type: "text" },
  notas_internas: { section: "core", field: "internalNotes", type: "text" },
  estado_carga: {
    section: "control",
    field: "loadStatus",
    type: "enum",
    map: { Borrador: "draft", Listo: "ready" },
  },
  carpeta_medios: { section: "control", field: "mediaFolder", type: "text" },
  foto_portada: { section: "control", field: "coverFile", type: "text" },
} as const satisfies Record<string, CoreFieldTarget>;

export type CoreFieldKey = keyof typeof CORE_FIELD_TARGETS;

export function isCoreFieldKey(key: string): key is CoreFieldKey {
  return Object.hasOwn(CORE_FIELD_TARGETS, key);
}

/** Obligatorios del modelo: la carga no puede armar un `listing` sin ellos. */
export const MODEL_REQUIRED_KEYS = (Object.keys(CORE_FIELD_TARGETS) as CoreFieldKey[]).filter(
  (key) => {
    const target: CoreFieldTarget = CORE_FIELD_TARGETS[key];
    return target.section === "core" && target.modelRequired === true;
  },
);
