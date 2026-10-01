import type { FieldType, ListingCategory } from "@agentsales/core";
import type { brokers, fieldDefinitions } from "./schema.js";

/** Corredor de demostración (F0). */
export const DEMO_BROKER = {
  slug: "demo",
  name: "Corredor Demo",
  brandName: "Demo Propiedades",
  primaryColor: "#1F4E79",
  secondaryColor: "#F2A900",
  email: "demo@example.com",
  instagramHandle: "demo.propiedades",
  tone: "Cercano y profesional; frases cortas y datos concretos.",
  fixedHashtags: ["#propiedades", "#demo"],
  autoPublish: false,
} satisfies typeof brokers.$inferInsert;

/**
 * Encabezados de la hoja **Propiedades** de `data/plantillas/plantilla_propiedades.xlsx`, en
 * orden. El lector de Excel (F1-T03) verifica que la plantilla real coincida.
 */
export const TEMPLATE_COLUMNS = [
  "id_propiedad",
  "operacion",
  "tipo",
  "region",
  "comuna",
  "direccion",
  "numero_unidad",
  "mostrar_direccion_exacta",
  "sector_referencia",
  "precio",
  "moneda",
  "gastos_comunes_clp",
  "contribuciones_trimestrales_clp",
  "sup_util_m2",
  "sup_total_m2",
  "sup_terreno_m2",
  "dormitorios",
  "banos",
  "estacionamientos",
  "bodegas",
  "piso",
  "orientacion",
  "ano_construccion",
  "amoblado",
  "acepta_mascotas",
  "disponibilidad",
  "amenities",
  "destacados",
  "requisitos_arriendo",
  "carpeta_medios",
  "foto_portada",
  "link_video",
  "link_tour_360",
  "publicar_en",
  "estado_carga",
  "notas_internas",
] as const;
export type TemplateColumn = (typeof TEMPLATE_COLUMNS)[number];

/** Categoría de las definiciones globales que siembra F1. */
export const REAL_ESTATE_CATEGORY: ListingCategory = "real_estate";

type FieldSeed = {
  key: TemplateColumn;
  label: string;
  type: FieldType;
  required?: boolean;
  /**
   * Opciones de un `enum` (las de la hoja **Listas** de la plantilla) o de cada elemento de un
   * `list`.
   */
  options?: readonly string[];
  /** Columna fija de `listings` o de control de la carga (spec F1 §4.2). */
  isCore?: boolean;
};

const PROPERTY_TYPES = [
  "Departamento",
  "Casa",
  "Oficina",
  "Local comercial",
  "Terreno",
  "Parcela",
  "Bodega",
  "Estacionamiento",
];
const ORIENTATIONS = [
  "Norte",
  "Sur",
  "Oriente",
  "Poniente",
  "Nororiente",
  "Norponiente",
  "Suroriente",
  "Surponiente",
];

// Tipo y obligatoriedad según el diccionario de la hoja Instrucciones. Excepción: `carpeta_medios`
// es opcional porque, si viene vacía, se usa `id_propiedad` (spec F1 §4.3).
const FIELD_SEEDS: readonly FieldSeed[] = [
  { key: "id_propiedad", label: "ID de propiedad", type: "text", required: true, isCore: true },
  {
    key: "operacion",
    label: "Operación",
    type: "enum",
    required: true,
    options: ["Venta", "Arriendo"],
    isCore: true,
  },
  {
    key: "tipo",
    label: "Tipo de propiedad",
    type: "enum",
    required: true,
    options: PROPERTY_TYPES,
    isCore: true,
  },
  { key: "region", label: "Región", type: "text", required: true, isCore: true },
  { key: "comuna", label: "Comuna", type: "text", required: true, isCore: true },
  { key: "direccion", label: "Dirección", type: "text", required: true, isCore: true },
  { key: "numero_unidad", label: "Número de unidad", type: "text", isCore: true },
  {
    key: "mostrar_direccion_exacta",
    label: "Mostrar dirección exacta",
    type: "boolean",
    required: true,
    isCore: true,
  },
  { key: "sector_referencia", label: "Sector de referencia", type: "text" },
  { key: "precio", label: "Precio", type: "number", required: true, isCore: true },
  {
    key: "moneda",
    label: "Moneda",
    type: "enum",
    required: true,
    options: ["UF", "CLP"],
    isCore: true,
  },
  { key: "gastos_comunes_clp", label: "Gastos comunes (CLP)", type: "number" },
  {
    key: "contribuciones_trimestrales_clp",
    label: "Contribuciones trimestrales (CLP)",
    type: "number",
  },
  { key: "sup_util_m2", label: "Superficie útil (m²)", type: "number", required: true },
  { key: "sup_total_m2", label: "Superficie total (m²)", type: "number" },
  { key: "sup_terreno_m2", label: "Superficie de terreno (m²)", type: "number" },
  { key: "dormitorios", label: "Dormitorios", type: "number", required: true },
  { key: "banos", label: "Baños", type: "number", required: true },
  { key: "estacionamientos", label: "Estacionamientos", type: "number", required: true },
  { key: "bodegas", label: "Bodegas", type: "number", required: true },
  { key: "piso", label: "Piso", type: "number" },
  { key: "orientacion", label: "Orientación", type: "enum", options: ORIENTATIONS },
  { key: "ano_construccion", label: "Año de construcción", type: "number" },
  { key: "amoblado", label: "Amoblado", type: "boolean", required: true },
  {
    key: "acepta_mascotas",
    label: "Acepta mascotas",
    type: "enum",
    options: ["Sí", "No", "A consultar"],
  },
  // "Inmediata" o una fecha (dd-mm-aaaa): texto, no `date`.
  { key: "disponibilidad", label: "Disponibilidad", type: "text", required: true },
  { key: "amenities", label: "Amenities", type: "list" },
  { key: "destacados", label: "Destacados", type: "text", isCore: true },
  { key: "requisitos_arriendo", label: "Requisitos de arriendo", type: "text" },
  { key: "carpeta_medios", label: "Carpeta de medios", type: "text", isCore: true },
  { key: "foto_portada", label: "Foto de portada", type: "text", isCore: true },
  { key: "link_video", label: "Link de video", type: "url" },
  { key: "link_tour_360", label: "Link de tour 360", type: "url" },
  {
    key: "publicar_en",
    label: "Publicar en",
    type: "list",
    required: true,
    // Cada elemento se valida contra estas opciones: un error de tipeo sale en el reporte de F1.
    options: ["Instagram", "Portal Inmobiliario", "Marketplace"],
  },
  {
    key: "estado_carga",
    label: "Estado de carga",
    type: "enum",
    required: true,
    options: ["Borrador", "Listo"],
    isCore: true,
  },
  { key: "notas_internas", label: "Notas internas", type: "text", isCore: true },
];

/**
 * Definiciones globales de `real_estate` (spec F1 §4.5): una por columna de la plantilla, con
 * `source_column` igual al encabezado y el orden de la plantilla.
 */
export const REAL_ESTATE_FIELD_DEFINITIONS = FIELD_SEEDS.map(
  (field, index) =>
    ({
      brokerId: null,
      category: REAL_ESTATE_CATEGORY,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      options: field.options ? [...field.options] : null,
      sourceColumn: field.key,
      isCore: field.isCore ?? false,
      sortOrder: (index + 1) * 10,
      active: true,
    }) satisfies typeof fieldDefinitions.$inferInsert,
);
