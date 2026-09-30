import { describe, expect, it } from "vitest";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "./seed-data.js";

/** Columnas con destino fijo o de control de la carga (spec F1 §4.2). */
const CORE_COLUMNS = [
  "id_propiedad",
  "operacion",
  "tipo",
  "region",
  "comuna",
  "direccion",
  "numero_unidad",
  "mostrar_direccion_exacta",
  "precio",
  "moneda",
  "destacados",
  "carpeta_medios",
  "foto_portada",
  "estado_carga",
  "notas_internas",
];

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

  it("todo enum trae opciones, y solo los enum", () => {
    for (const def of REAL_ESTATE_FIELD_DEFINITIONS) {
      if (def.type === "enum") {
        expect(def.options?.length, def.key).toBeGreaterThan(0);
      } else {
        expect(def.options, def.key).toBeNull();
      }
    }
  });

  it("marca is_core exactamente en las columnas con destino fijo o de control", () => {
    const core = REAL_ESTATE_FIELD_DEFINITIONS.filter((def) => def.isCore).map((def) => def.key);
    expect(core.sort()).toEqual([...CORE_COLUMNS].sort());
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
