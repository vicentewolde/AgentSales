import { buildListingValidator, CORE_FIELD_TARGETS, type FieldDefinition } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "./seed-data.js";

describe("REAL_ESTATE_FIELD_DEFINITIONS", () => {
  it("tiene una definición por columna de la plantilla, en el mismo orden", () => {
    expect(TEMPLATE_COLUMNS).toHaveLength(36);
    expect(REAL_ESTATE_FIELD_DEFINITIONS.map((def) => def.sourceColumn)).toEqual([
      ...TEMPLATE_COLUMNS,
    ]);
  });

  it("no repite keys y el orden es creciente", () => {
    const keys = REAL_ESTATE_FIELD_DEFINITIONS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    const orders = REAL_ESTATE_FIELD_DEFINITIONS.map((def) => def.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("todo enum trae opciones; fuera de enum, solo publicar_en (list) las tiene", () => {
    for (const def of REAL_ESTATE_FIELD_DEFINITIONS) {
      if (def.type === "enum") {
        expect(def.options?.length, def.key).toBeGreaterThan(0);
      } else if (def.key === "publicar_en") {
        expect(def.options).toEqual(["Instagram", "Portal Inmobiliario", "Marketplace"]);
      } else {
        expect(def.options, def.key).toBeNull();
      }
    }
  });

  it("son globales de real_estate y activas", () => {
    for (const def of REAL_ESTATE_FIELD_DEFINITIONS) {
      expect(def).toMatchObject({ brokerId: null, category: "real_estate", active: true });
    }
  });

  it("respeta el diccionario de la plantilla en los casos con reglas propias", () => {
    const byKey = new Map(REAL_ESTATE_FIELD_DEFINITIONS.map((def) => [def.key, def]));
    expect(byKey.get("operacion")?.options).toEqual(["Venta", "Arriendo"]);
    expect(byKey.get("acepta_mascotas")).toMatchObject({
      type: "enum",
      options: ["Sí", "No", "A consultar"],
    });
    expect(byKey.get("mostrar_direccion_exacta")).toMatchObject({
      type: "boolean",
      required: true,
    });
    expect(byKey.get("disponibilidad")?.type).toBe("text");
    // Opcional: si viene vacía se usa id_propiedad (spec F1 §4.3).
    expect(byKey.get("carpeta_medios")?.required).toBe(false);
  });
});

/** El seed como lo devuelve el repositorio (con `id`). */
const SEEDED: FieldDefinition[] = REAL_ESTATE_FIELD_DEFINITIONS.map((def, index) => ({
  ...def,
  id: `seed-${index}`,
}));

describe("CORE_FIELD_TARGETS de core contra el seed", () => {
  it("cada destino fijo es una columna de la plantilla con is_core y el tipo esperado", () => {
    const byKey = new Map<string, (typeof REAL_ESTATE_FIELD_DEFINITIONS)[number]>(
      REAL_ESTATE_FIELD_DEFINITIONS.map((def) => [def.key, def]),
    );
    for (const [key, target] of Object.entries(CORE_FIELD_TARGETS)) {
      expect(TEMPLATE_COLUMNS as readonly string[], key).toContain(key);
      expect(byKey.get(key), key).toMatchObject({ isCore: true, type: target.type });
    }
    const coreKeys = REAL_ESTATE_FIELD_DEFINITIONS.filter((def) => def.isCore).map((d) => d.key);
    expect(coreKeys.sort()).toEqual(Object.keys(CORE_FIELD_TARGETS).sort());
  });

  it("las opciones mapeadas (operacion, moneda, estado_carga) coinciden con las del seed", () => {
    for (const [key, target] of Object.entries(CORE_FIELD_TARGETS)) {
      if (!("map" in target)) continue;
      const def = REAL_ESTATE_FIELD_DEFINITIONS.find((candidate) => candidate.key === key);
      expect(Object.keys(target.map).sort(), key).toEqual([...(def?.options ?? [])].sort());
    }
  });
});

describe("buildListingValidator con las 36 definiciones del seed", () => {
  const validator = buildListingValidator(SEEDED);

  it("arma el validador y reconoce todos los encabezados de la plantilla", () => {
    expect(validator.definitions).toHaveLength(36);
    expect(validator.checkHeaders([...TEMPLATE_COLUMNS])).toEqual({
      unknown: [],
      missing: [],
      duplicated: [],
    });
  });

  it("valida la fila de ejemplo de la plantilla (sintética, ya en git) y la marca como ignorada", () => {
    const example = {
      id_propiedad: "EJEMPLO",
      operacion: "Venta",
      tipo: "Departamento",
      region: "Metropolitana",
      comuna: "Ñuñoa",
      direccion: "Av. Irarrázaval 3400",
      numero_unidad: "1204",
      mostrar_direccion_exacta: "No",
      sector_referencia: "A 3 cuadras de metro Chile España",
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
      amenities: "Piscina, gimnasio, quincho, conserjería 24h",
      destacados: "Remodelado 2024, vista despejada a la cordillera, cocina americana",
      requisitos_arriendo: "Renta líquida 3 veces el arriendo, aval",
      carpeta_medios: "EJEMPLO",
      foto_portada: "01_living.jpg",
      link_video: null,
      link_tour_360: null,
      publicar_en: "Instagram, Portal Inmobiliario, Marketplace",
      estado_carga: "Listo",
      notas_internas: "Dueño prefiere visitas en la tarde",
    };
    expect(validator.isIgnored(example)).toBe(true);
    const result = validator.validate(example);
    expect(result).toMatchObject({
      ok: true,
      data: {
        core: { externalRef: "EJEMPLO", operation: "sale", priceAmount: 5800, priceCurrency: "UF" },
        control: { loadStatus: "ready", mediaFolder: "EJEMPLO", coverFile: "01_living.jpg" },
        attributes: {
          acepta_mascotas: "Sí",
          amoblado: false,
          publicar_en: ["Instagram", "Portal Inmobiliario", "Marketplace"],
        },
      },
    });
  });

  it("rechaza los números fuera de rango del seed (deuda de F1: dormitorios = -2 pasaba)", () => {
    const issues = (row: Record<string, unknown>) => {
      const result = validator.validate(row);
      return result.ok ? [] : result.errors.map((error) => [error.column, error.code]);
    };
    const base = {
      id_propiedad: "P900",
      operacion: "Venta",
      tipo: "Casa",
      region: "Metropolitana",
      comuna: "Maipú",
      direccion: "Calle Inventada 1",
      mostrar_direccion_exacta: "No",
      precio: 3000,
      moneda: "UF",
      sup_util_m2: 90,
      dormitorios: 3,
      banos: 2,
      estacionamientos: 1,
      bodegas: 0,
      amoblado: "No",
      disponibilidad: "Inmediata",
      publicar_en: "Instagram",
      estado_carga: "Listo",
    };
    expect(issues(base)).toEqual([]);
    expect(issues({ ...base, dormitorios: -2, banos: -1, sup_util_m2: 0, piso: 300 })).toEqual([
      ["sup_util_m2", "FIELD_NUMBER_INVALID"],
      ["dormitorios", "FIELD_NUMBER_INVALID"],
      ["banos", "FIELD_NUMBER_INVALID"],
      ["piso", "FIELD_NUMBER_INVALID"],
    ]);
  });
});

describe("rangos del seed (spec F2 §4.3)", () => {
  it("son exactamente los de la tabla del spec, y solo en campos number", () => {
    const ranges = Object.fromEntries(
      REAL_ESTATE_FIELD_DEFINITIONS.filter(
        (def) => def.minValue !== null || def.maxValue !== null,
      ).map((def) => [def.key, [def.minValue, def.maxValue]]),
    );
    expect(ranges).toEqual({
      gastos_comunes_clp: [0, null],
      contribuciones_trimestrales_clp: [0, null],
      sup_util_m2: [1, 1_000_000],
      sup_total_m2: [1, 1_000_000],
      sup_terreno_m2: [1, 1_000_000],
      dormitorios: [0, 50],
      banos: [0, 50],
      estacionamientos: [0, 100],
      bodegas: [0, 100],
      piso: [-10, 200],
      ano_construccion: [1800, 2100],
    });
    for (const key of Object.keys(ranges)) {
      expect(REAL_ESTATE_FIELD_DEFINITIONS.find((def) => def.key === key)?.type).toBe("number");
    }
  });
});
