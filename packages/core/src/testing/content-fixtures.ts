import type { Broker } from "../broker.js";
import type { FieldType } from "../enums.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";

// Datos inventados para los tests de contenido (spec F2 §4.6): un aviso, las definiciones de la
// plantilla que usa el contenido y un corredor. Sin datos de clientes.

type DefinitionSeed = [key: string, label: string, type: FieldType, isCore?: boolean];

/** Las columnas de la plantilla (las de `packages/db` `REAL_ESTATE_FIELD_DEFINITIONS`) que importan aquí. */
const DEFINITION_SEEDS: readonly DefinitionSeed[] = [
  ["id_propiedad", "ID de propiedad", "text", true],
  ["operacion", "Operación", "enum", true],
  ["tipo", "Tipo de propiedad", "enum", true],
  ["comuna", "Comuna", "text", true],
  ["direccion", "Dirección", "text", true],
  ["sector_referencia", "Sector de referencia", "text"],
  ["precio", "Precio", "number", true],
  ["gastos_comunes_clp", "Gastos comunes (CLP)", "number"],
  ["sup_util_m2", "Superficie útil (m²)", "number"],
  ["sup_total_m2", "Superficie total (m²)", "number"],
  ["dormitorios", "Dormitorios", "number"],
  ["banos", "Baños", "number"],
  ["estacionamientos", "Estacionamientos", "number"],
  ["bodegas", "Bodegas", "number"],
  ["orientacion", "Orientación", "enum"],
  ["amoblado", "Amoblado", "boolean"],
  ["disponibilidad", "Disponibilidad", "text"],
  ["amenities", "Amenities", "list"],
  ["destacados", "Destacados", "text", true],
  ["requisitos_arriendo", "Requisitos de arriendo", "text"],
  ["link_video", "Link de video", "url"],
  ["link_tour_360", "Link de tour 360", "url"],
  ["publicar_en", "Publicar en", "list"],
  ["notas_internas", "Notas internas", "text", true],
];

/** Definiciones globales de `real_estate` para el contenido, en el orden de la plantilla. */
export function contentDefinitionsFixture(): FieldDefinition[] {
  return DEFINITION_SEEDS.map(([key, label, type, isCore = false], index) => ({
    id: `def-${key}`,
    brokerId: null,
    category: "real_estate",
    key,
    label,
    type,
    required: false,
    options: null,
    sourceColumn: key,
    isCore,
    minValue: null,
    maxValue: null,
    sortOrder: (index + 1) * 10,
    active: true,
  }));
}

/**
 * Un departamento en venta en UF, con todo lo que el brief no debe mostrar (dirección oculta,
 * notas internas, `_extra`, links y un campo sin definición) para probar que no sale.
 */
export function contentListingFixture(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    brokerId: "00000000-0000-4000-8000-0000000000b1",
    externalRef: "T001",
    category: "real_estate",
    status: "ready",
    closeReason: null,
    operation: "sale",
    propertyType: "Departamento",
    region: "Región Inventada",
    comuna: "Ñuñoa",
    address: "Calle Inventada 1234",
    unitNumber: "Depto 506",
    showExactAddress: false,
    priceAmount: 5800,
    priceCurrency: "UF",
    highlights: "Terraza con vista despejada y cocina remodelada",
    internalNotes: "Dueño acepta ofertas bajo el precio publicado si pagan al contado",
    attributes: {
      sector_referencia: "Cerca de Plaza Inventada",
      gastos_comunes_clp: 120000,
      sup_util_m2: 72.5,
      sup_total_m2: 80,
      dormitorios: 3,
      banos: 2,
      estacionamientos: 1,
      bodegas: 1,
      orientacion: "Norte",
      amoblado: false,
      disponibilidad: "Inmediata",
      amenities: ["Quincho", "Gimnasio"],
      link_video: "https://video.example.com/t001",
      link_tour_360: "https://tour.example.com/t001",
      publicar_en: ["Instagram", "Portal Inmobiliario", "Marketplace"],
      sin_definicion: "clave suelta 4321",
      _extra: { comision: "2% más IVA" },
    },
    source: "xlsx",
    createdAt: new Date("2026-10-01T12:00:00Z"),
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    ...overrides,
  };
}

/** Un corredor con contacto completo: el contacto nunca va al brief. */
export function contentBrokerFixture(overrides: Partial<Broker> = {}): Broker {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    slug: "corredor-inventado",
    name: "Corredora Inventada",
    brandName: "Inventada Propiedades",
    logoMediaId: null,
    primaryColor: "#1F4E79",
    secondaryColor: "#F2A900",
    whatsapp: "+56 9 1111 2222",
    email: "contacto@inventada.example",
    instagramHandle: "inventada.propiedades",
    website: "https://inventada.example",
    tone: "Cercano y profesional",
    fixedHashtags: ["#InventadaPropiedades", "#propiedades"],
    autoPublish: false,
    ...overrides,
  };
}
