import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import { buildListingValidator, fieldIssueSchema, type RawListingRow } from "./index.js";

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
    // Sin depender del orden: el reporte lo arma quien llama.
    expect(errors.map((error) => [error.column, error.code]).sort()).toEqual([
      ["amoblado", "FIELD_BOOLEAN_INVALID"],
      ["link_video", "FIELD_URL_INVALID"],
      ["precio", "FIELD_NUMBER_INVALID"],
      ["publicar_en", "FIELD_LIST_INVALID"],
    ]);
    // Los errores calzan con el contrato que viaja en el reporte y por HTTP.
    for (const error of errors) expect(fieldIssueSchema.parse(error)).toEqual(error);
  });

  it("un precio que no cabe en numeric(14,2) es un error de la fila, no del INSERT", () => {
    expect(errorsOf({ ...VALID_ROW, precio: 1e13 })).toEqual([
      expect.objectContaining({ column: "precio", code: "FIELD_NUMBER_INVALID" }),
    ]);
  });

  it("una lista obligatoria con solo separadores cuenta como vacía", () => {
    expect(errorsOf({ ...VALID_ROW, publicar_en: " , ," })).toEqual([
      expect.objectContaining({ column: "publicar_en", code: "FIELD_REQUIRED" }),
    ]);
  });

  it("mostrar_direccion_exacta: en blanco es false; un valor inválido es error, no false", () => {
    const lenient = buildListingValidator(
      DEFS.map((d) => (d.key === "mostrar_direccion_exacta" ? { ...d, required: false } : d)),
    );
    const blank = lenient.validate({ ...VALID_ROW, mostrar_direccion_exacta: "" });
    expect(blank).toMatchObject({ ok: true, data: { core: { showExactAddress: false } } });
    expect(lenient.validate({ ...VALID_ROW, mostrar_direccion_exacta: "tal vez" })).toMatchObject({
      ok: false,
      errors: [{ column: "mostrar_direccion_exacta", code: "FIELD_BOOLEAN_INVALID" }],
    });
  });

  it("una celda que no es RawCell (hipervínculo de exceljs) es FIELD_VALUE_INVALID", () => {
    const hyperlink = { text: "Calle Falsa 123", hyperlink: "https://example.cl" };
    const row = { ...VALID_ROW, direccion: hyperlink } as unknown as RawListingRow;
    expect(errorsOf(row)).toEqual([
      expect.objectContaining({ column: "direccion", code: "FIELD_VALUE_INVALID" }),
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

describe("buildListingValidator · columnas ausentes", () => {
  it("un campo opcional sin su columna en la hoja no hace fallar la fila", () => {
    const { notas_internas: _notas, link_video: _video, ...row } = VALID_ROW;
    expect(validRow(row).core.internalNotes).toBeNull();
  });

  it("un obligatorio sin su columna en la hoja es FIELD_REQUIRED", () => {
    const { dormitorios: _dormitorios, ...row } = VALID_ROW;
    expect(errorsOf(row)).toEqual([
      expect.objectContaining({ column: "dormitorios", code: "FIELD_REQUIRED" }),
    ]);
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
      duplicated: [],
    });
  });

  it("ignora los encabezados vacíos (celdas sobrantes de Excel) en checkHeaders y validate", () => {
    expect(validator.checkHeaders([...Object.keys(VALID_ROW), "", "  "])).toEqual({
      unknown: [],
      missing: [],
      duplicated: [],
    });
    expect(validRow({ ...VALID_ROW, "": "basura", " ": 3 }).attributes._extra).toBeUndefined();
  });

  it("con encabezados repetidos vale el primero, y checkHeaders los informa", () => {
    expect(validator.checkHeaders(["precio", " Precio "]).duplicated).toEqual([" Precio "]);
    expect(validRow({ ...VALID_ROW, " PRECIO ": "1" }).core.priceAmount).toBe(5800);
  });

  it("guarda en _extra un encabezado como __proto__ y descarta celdas que no son RawCell", () => {
    const row = { ...VALID_ROW, ["__proto__"]: "valor", Rara: { richText: [] } };
    const extra = validRow(row as unknown as RawListingRow).attributes._extra;
    expect(Object.entries(extra ?? {})).toEqual([["__proto__", "valor"]]);
  });
});

describe("buildListingValidator · isIgnored", () => {
  it("ignora la fila EJEMPLO (sin importar mayúsculas) y las de estado Borrador", () => {
    expect(validator.isIgnored({ ...VALID_ROW, id_propiedad: "EJEMPLO" })).toBe(true);
    expect(validator.isIgnored({ ...VALID_ROW, id_propiedad: " ejemplo " })).toBe(true);
    expect(validator.isIgnored({ ...VALID_ROW, estado_carga: "borrador" })).toBe(true);
    expect(validator.isIgnored(VALID_ROW)).toBe(false);
  });

  it("usa las columnas resueltas: sirve aunque el corredor cambie el encabezado", () => {
    const renamed = buildListingValidator([
      ...DEFS,
      def("id_propiedad", "text", {
        brokerId: "b1",
        required: true,
        isCore: true,
        sourceColumn: "Código",
      }),
    ]);
    const { id_propiedad: _ref, ...rest } = VALID_ROW;
    expect(renamed.isIgnored({ ...rest, codigo: "EJEMPLO" })).toBe(true);
    expect(renamed.isIgnored({ ...rest, codigo: "P001" })).toBe(false);
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

  it("un campo de tipo date se normaliza a ISO", () => {
    const withDate = buildListingValidator([...DEFS, def("fecha_entrega", "date")]);
    const result = withDate.validate({ ...VALID_ROW, fecha_entrega: "15-11-2026" });
    expect(result).toMatchObject({
      ok: true,
      data: { attributes: { fecha_entrega: "2026-11-15" } },
    });
  });

  it("notas_internas va a core y nunca a attributes (no llega a la IA)", () => {
    const data = validRow(VALID_ROW);
    expect(data.core.internalNotes).toBe("Visitas en la tarde");
    expect(Object.keys(data.attributes)).not.toContain("notas_internas");
  });

  it("las opciones mapeadas del corredor se comparan sin mayúsculas ni tildes", () => {
    const lower = buildListingValidator([
      ...DEFS,
      def("moneda", "enum", {
        brokerId: "b1",
        required: true,
        isCore: true,
        options: ["uf", "clp"],
      }),
    ]);
    expect(lower.validate({ ...VALID_ROW, moneda: "UF" })).toMatchObject({
      ok: true,
      data: { core: { priceCurrency: "UF" } },
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
      expect(isAppError(error) && error.code).toBe("FIELD_CONFIG_INVALID");
      expect(isAppError(error) && error.details).toMatchObject({ key });
      return;
    }
    throw new Error("se esperaba FIELD_CONFIG_INVALID");
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

  it("un destino fijo redefinido por el corredor como atributo (is_core = false)", () => {
    expectInvalid(
      [...DEFS, def("notas_internas", "text", { brokerId: "b1", isCore: false })],
      "notas_internas",
    );
  });

  it("una opción de un campo mapeado sin equivalente (operacion con Permuta)", () => {
    expectInvalid(
      [
        ...DEFS,
        def("operacion", "enum", {
          brokerId: "b1",
          required: true,
          isCore: true,
          options: ["Venta", "Arriendo", "Permuta"],
        }),
      ],
      "operacion",
    );
  });

  it.each(["_extra", "__proto__", "Con Espacios"])("una clave con formato inválido: %s", (key) => {
    expectInvalid([...DEFS, def(key, "text")], key);
  });

  it("un enum sin opciones", () => {
    expectInvalid([...DEFS, def("orientacion", "enum")], "orientacion");
  });

  it("dos campos que leen la misma columna", () => {
    try {
      buildListingValidator([...DEFS, def("piezas", "number", { sourceColumn: "Dormitorios" })]);
      throw new Error("se esperaba un error");
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("FIELD_CONFIG_INVALID");
    }
  });
});
