import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import { buildListingValidator, type RawListingRow } from "./index.js";

let nextId = 0;
const def = (
  key: string,
  type: FieldDefinition["type"],
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id: `def-${++nextId}`,
  brokerId: null,
  category: "real_estate",
  key,
  label: key,
  type,
  required: false,
  options: null,
  sourceColumn: key,
  isCore: false,
  sortOrder: nextId * 10,
  active: true,
  ...overrides,
});

/** Subconjunto de las 36 definiciones del seed: todas las de destino fijo y algunas dinámicas. */
const DEFS: FieldDefinition[] = [
  def("id_propiedad", "text", { required: true, isCore: true }),
  def("operacion", "enum", { required: true, isCore: true, options: ["Venta", "Arriendo"] }),
  def("tipo", "enum", { required: true, isCore: true, options: ["Departamento", "Casa"] }),
  def("region", "text", { required: true, isCore: true }),
  def("comuna", "text", { required: true, isCore: true }),
  def("direccion", "text", { required: true, isCore: true }),
  def("numero_unidad", "text", { isCore: true }),
  def("mostrar_direccion_exacta", "boolean", { required: true, isCore: true }),
  def("precio", "number", { required: true, isCore: true }),
  def("moneda", "enum", { required: true, isCore: true, options: ["UF", "CLP"] }),
  def("dormitorios", "number", { required: true }),
  def("amoblado", "boolean", { required: true }),
  def("amenities", "list"),
  def("destacados", "text", { isCore: true }),
  def("carpeta_medios", "text", { isCore: true }),
  def("foto_portada", "text", { isCore: true }),
  def("link_video", "url"),
  def("publicar_en", "list", {
    required: true,
    options: ["Instagram", "Portal Inmobiliario", "Marketplace"],
  }),
  def("estado_carga", "enum", { required: true, isCore: true, options: ["Borrador", "Listo"] }),
  def("notas_internas", "text", { isCore: true }),
];

/** Fila sintética (sin datos reales), como la entrega el lector de Excel. */
const VALID_ROW: RawListingRow = {
  id_propiedad: "P001",
  operacion: "Venta",
  tipo: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  direccion: "Calle Falsa 123",
  numero_unidad: 1204,
  mostrar_direccion_exacta: "No",
  precio: "5.800",
  moneda: "UF",
  dormitorios: 3,
  amoblado: "Sí",
  amenities: "Piscina, gimnasio",
  destacados: "Vista despejada",
  carpeta_medios: "",
  foto_portada: "01_living.jpg",
  link_video: null,
  publicar_en: "Instagram, Portal Inmobiliario",
  estado_carga: "Listo",
  notas_internas: "Visitas en la tarde",
};

const validator = buildListingValidator(DEFS);

function validRow(row: RawListingRow) {
  const result = validator.validate(row);
  if (!result.ok) throw new Error(`se esperaba una fila válida: ${JSON.stringify(result.errors)}`);
  return result.data;
}

function errorsOf(row: RawListingRow) {
  const result = validator.validate(row);
  if (result.ok) throw new Error("se esperaba una fila con errores");
  return result.errors;
}

describe("buildListingValidator · fila válida", () => {
  it("normaliza y reparte los valores entre core, control y attributes", () => {
    expect(validRow(VALID_ROW)).toEqual({
      core: {
        externalRef: "P001",
        operation: "sale",
        propertyType: "Departamento",
        region: "Metropolitana",
        comuna: "Ñuñoa",
        address: "Calle Falsa 123",
        unitNumber: "1204",
        showExactAddress: false,
        priceAmount: 5800,
        priceCurrency: "UF",
        highlights: "Vista despejada",
        internalNotes: "Visitas en la tarde",
      },
      control: { loadStatus: "ready", mediaFolder: null, coverFile: "01_living.jpg" },
      attributes: {
        dormitorios: 3,
        amoblado: true,
        amenities: ["Piscina", "gimnasio"],
        publicar_en: ["Instagram", "Portal Inmobiliario"],
      },
    });
  });

  it("Arriendo → rent y Borrador → draft", () => {
    const data = validRow({ ...VALID_ROW, operacion: "arriendo", estado_carga: "Borrador" });
    expect(data.core.operation).toBe("rent");
    expect(data.control.loadStatus).toBe("draft");
  });

  it("empareja los encabezados sin importar mayúsculas, tildes ni espacios", () => {
    const { precio, ...rest } = VALID_ROW;
    expect(validRow({ ...rest, "  PRECIO ": precio }).core.priceAmount).toBe(5800);
  });
});

describe("buildListingValidator · errores por celda", () => {
  it("un obligatorio faltante indica columna y motivo", () => {
    expect(errorsOf({ ...VALID_ROW, dormitorios: "  " })).toEqual([
      {
        column: "dormitorios",
        key: "dormitorios",
        code: "FIELD_REQUIRED",
        message: "falta el valor (es obligatorio)",
      },
    ]);
  });

  it("un enum inválido lista las opciones", () => {
    expect(errorsOf({ ...VALID_ROW, tipo: "Castillo" })).toEqual([
      expect.objectContaining({
        column: "tipo",
        code: "FIELD_ENUM_INVALID",
        message: "«Castillo» no es una opción válida (Departamento, Casa)",
      }),
    ]);
  });

  it("acumula todos los errores de la fila, no solo el primero", () => {
    const errors = errorsOf({
      ...VALID_ROW,
      precio: "cinco mil",
      amoblado: "tal vez",
      publicar_en: "Instagarm",
      link_video: "youtu.be/abc",
    });
    expect(errors.map((error) => [error.column, error.code])).toEqual([
      ["precio", "FIELD_NUMBER_INVALID"],
      ["amoblado", "FIELD_BOOLEAN_INVALID"],
      ["link_video", "FIELD_URL_INVALID"],
      ["publicar_en", "FIELD_LIST_INVALID"],
    ]);
  });

  it("el precio debe ser mayor que 0", () => {
    expect(errorsOf({ ...VALID_ROW, precio: 0 })).toEqual([
      expect.objectContaining({ column: "precio", code: "FIELD_NUMBER_INVALID" }),
    ]);
  });

  it("id_propiedad, precio y moneda son obligatorios del modelo aunque la definición diga que no", () => {
    const lenient = buildListingValidator(
      DEFS.map((d) => (d.key === "precio" ? { ...d, required: false } : d)),
    );
    const result = lenient.validate({ ...VALID_ROW, precio: null });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ column: "precio", code: "FIELD_REQUIRED" }],
    });
  });
});

describe("buildListingValidator · columnas desconocidas", () => {
  it("guarda sus valores no vacíos en attributes._extra, como texto", () => {
    const data = validRow({ ...VALID_ROW, " Vista al mar ": "Sí", Comentario: "", Codigo: 42 });
    expect(data.attributes._extra).toEqual({ "Vista al mar": "Sí", Codigo: "42" });
  });

  it("checkHeaders las reporta una vez por hoja, junto con las obligatorias que faltan", () => {
    const headers = [...Object.keys(VALID_ROW), "Vista al mar"].filter((h) => h !== "dormitorios");
    expect(validator.checkHeaders(headers)).toEqual({
      unknown: ["Vista al mar"],
      missing: ["dormitorios"],
    });
  });
});

describe("buildListingValidator · definiciones desde la base de datos", () => {
  it("un campo agregado solo como definición se valida sin cambiar código", () => {
    const withNewField = buildListingValidator([
      ...DEFS,
      def("vista_al_mar", "boolean", { required: true, sourceColumn: "Vista al mar" }),
    ]);
    const ok = withNewField.validate({ ...VALID_ROW, "Vista al mar": "sí" });
    expect(ok).toMatchObject({ ok: true, data: { attributes: { vista_al_mar: true } } });
    expect(ok.ok && ok.data.attributes._extra).toBeFalsy();
    expect(withNewField.validate(VALID_ROW)).toMatchObject({
      ok: false,
      errors: [{ column: "Vista al mar", code: "FIELD_REQUIRED" }],
    });
  });

  it("la definición del corredor sobrescribe la global, y la inactiva desactiva el campo", () => {
    const brokerDefs = buildListingValidator([
      ...DEFS,
      def("dormitorios", "number", { brokerId: "b1", required: false }),
      def("amenities", "list", { brokerId: "b1", active: false }),
    ]);
    const data = (() => {
      const result = brokerDefs.validate({ ...VALID_ROW, dormitorios: null });
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.data;
    })();
    expect(data.attributes).not.toHaveProperty("dormitorios");
    // La columna del campo desactivado se ignora sin ir a _extra.
    expect(data.attributes).not.toHaveProperty("amenities");
    expect(data.attributes._extra).toBeUndefined();
  });
});

describe("buildListingValidator · definiciones inválidas", () => {
  const expectInvalid = (defs: FieldDefinition[], key: string) => {
    try {
      buildListingValidator(defs);
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("FIELD_DEFINITIONS_INVALID");
      expect(isAppError(error) && error.details).toMatchObject({ key });
      return;
    }
    throw new Error("se esperaba FIELD_DEFINITIONS_INVALID");
  };

  it("falta un obligatorio del modelo (por ejemplo, el corredor desactivó precio)", () => {
    expectInvalid([...DEFS, def("precio", "number", { brokerId: "b1", active: false })], "precio");
  });

  it("un is_core sin destino fijo", () => {
    expectInvalid([...DEFS, def("orientacion", "text", { isCore: true })], "orientacion");
  });

  it("un destino fijo con otro tipo (precio como texto)", () => {
    expectInvalid(
      DEFS.map((d) => (d.key === "precio" ? { ...d, type: "text" as const } : d)),
      "precio",
    );
  });

  it("un enum sin opciones", () => {
    expectInvalid([...DEFS, def("orientacion", "enum")], "orientacion");
  });

  it("dos campos que leen la misma columna", () => {
    try {
      buildListingValidator([...DEFS, def("piezas", "number", { sourceColumn: "Dormitorios" })]);
      throw new Error("se esperaba un error");
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("FIELD_DEFINITIONS_INVALID");
    }
  });
});
