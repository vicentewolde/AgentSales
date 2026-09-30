import { TEMPLATE_COLUMNS } from "@agentsales/db";
import ExcelJS from "exceljs";

/** Fila sintética completa de la plantilla (datos inventados; nunca datos reales). */
export function syntheticRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_propiedad: "P001",
    operacion: "Venta",
    tipo: "Departamento",
    region: "Metropolitana",
    comuna: "Ñuñoa",
    direccion: "Calle Inventada 123",
    numero_unidad: "45",
    mostrar_direccion_exacta: "No",
    sector_referencia: "Cerca del parque",
    precio: 5800,
    moneda: "UF",
    gastos_comunes_clp: 120000,
    contribuciones_trimestrales_clp: 85000,
    sup_util_m2: 72,
    sup_total_m2: 80,
    sup_terreno_m2: null,
    dormitorios: 3,
    banos: 2,
    estacionamientos: 1,
    bodegas: 1,
    piso: 12,
    orientacion: "Nororiente",
    ano_construccion: 2018,
    amoblado: "No",
    acepta_mascotas: "Sí",
    disponibilidad: "Inmediata",
    amenities: "Piscina, gimnasio",
    destacados: "Luminoso",
    requisitos_arriendo: null,
    carpeta_medios: "P001",
    foto_portada: "01_living.jpg",
    link_video: null,
    link_tour_360: null,
    publicar_en: "Instagram, Portal Inmobiliario",
    estado_carga: "Listo",
    notas_internas: "Nota de prueba",
    ...overrides,
  };
}

export type SheetSpec = {
  headers?: readonly string[];
  /** Valores por encabezado; `undefined` o una clave ausente deja la celda vacía. */
  rows?: readonly (Record<string, unknown> | null)[];
};

export type WorkbookSpec = {
  listings?: SheetSpec | "missing";
  /** Filas `[Campo, Tu valor]` de la hoja Corredor, o `"missing"` para no crearla. */
  broker?: readonly (readonly [string, unknown])[] | "missing";
  /** Encabezados de la hoja Corredor (por defecto, los de la plantilla). */
  brokerHeaders?: readonly string[];
  /** Nombres de las hojas (por defecto, los de la plantilla) y su orden. */
  sheetNames?: { listings: string; broker: string; brokerFirst?: boolean };
};

/** Arma un .xlsx en memoria con exceljs: fixtures sin binarios en git. */
export async function buildWorkbook(spec: WorkbookSpec = {}): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const names = spec.sheetNames ?? { listings: "Propiedades", broker: "Corredor" };

  const addBroker = () => {
    if (spec.broker === "missing") return;
    const sheet = workbook.addWorksheet(names.broker);
    sheet.addRow([
      ...(spec.brokerHeaders ?? ["Campo", "Obligatorio", "Descripción", "Ejemplo", "Tu valor"]),
    ]);
    for (const [label, value] of spec.broker ?? []) sheet.addRow([label, "", "", "", value]);
  };
  const addListings = () => {
    if (spec.listings === "missing") return;
    const sheet = workbook.addWorksheet(names.listings);
    const headers = spec.listings?.headers ?? TEMPLATE_COLUMNS;
    sheet.addRow([...headers]);
    for (const row of spec.listings?.rows ?? []) {
      sheet.addRow(row === null ? [] : headers.map((header) => row[header] ?? null));
    }
  };

  if (names.brokerFirst) {
    addBroker();
    addListings();
  } else {
    addListings();
    addBroker();
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
