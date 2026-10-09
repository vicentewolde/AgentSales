import type {
  PortalAttribute,
  PortalCategory,
  PortalLocationMatch,
  PublishInput,
  PublishListing,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";
import {
  buildPortalItem,
  type PortalItemCatalog,
  type PortalItemResult,
  resolvePortalItemCatalog,
} from "./item.js";

const NOW = new Date("2026-10-08T12:00:00Z");
const YES_NO = [
  { id: "242084", name: "No" },
  { id: "242085", name: "Sí" },
];

/** Un atributo como lo guarda el catálogo (forma de core). */
const attr = (
  id: string,
  options: Partial<PortalAttribute> & { tags?: string[] } = {},
): PortalAttribute => ({
  id,
  name: options.name ?? id,
  valueType: options.valueType ?? "number",
  required: options.required ?? false,
  conditionalRequired: options.conditionalRequired ?? false,
  tags: options.tags ?? (options.required ? ["required"] : []),
  values: options.values ?? [],
  allowedUnits: options.allowedUnits ?? [],
  defaultUnit: options.defaultUnit ?? null,
  valueMaxLength: null,
});
const area = (id: string, required = true) =>
  attr(id, {
    required,
    valueType: "number_unit",
    allowedUnits: [{ id: "m²", name: "m²" }],
    defaultUnit: "m²",
  });

/** Los atributos de Departamentos > Arriendo > Propiedades usadas (`MLC183186`, nota §12.1), recortados. */
const RENT_ATTRIBUTES: PortalAttribute[] = [
  attr("PROPERTY_TYPE", { valueType: "list", tags: ["fixed", "hidden"] }),
  attr("OPERATION", { valueType: "list", tags: ["fixed", "hidden"] }),
  area("TOTAL_AREA"),
  area("COVERED_AREA"),
  attr("ROOMS", { tags: ["hidden"] }),
  attr("BEDROOMS", { required: true }),
  attr("FULL_BATHROOMS", { required: true }),
  attr("PARKING_LOTS", { required: true }),
  attr("WAREHOUSES", { required: true }),
  attr("UNIT_FLOOR"),
  attr("FACING", {
    valueType: "list",
    values: [
      { id: "2730831", name: "NO" },
      { id: "242327", name: "N" },
      { id: "242330", name: "P" },
    ],
  }),
  attr("PROPERTY_AGE", {
    valueType: "number_unit",
    allowedUnits: [{ id: "años", name: "años" }],
    defaultUnit: "años",
  }),
  attr("MAINTENANCE_FEE", {
    required: true,
    valueType: "number_unit",
    allowedUnits: [
      { id: "CLP", name: "CLP" },
      { id: "UF", name: "UF" },
    ],
    defaultUnit: "CLP",
  }),
  attr("IS_SUITABLE_FOR_PETS", { required: true, valueType: "boolean", values: YES_NO }),
  attr("FURNISHED", { required: true, valueType: "boolean", values: YES_NO }),
  attr("HAS_SWIMMING_POOL", { valueType: "boolean", values: YES_NO }),
  attr("CMG_SITE", { valueType: "string", tags: ["hidden"] }),
];

/** En venta de usados, los de arriendo son opcionales (nota §12.1). */
const SALE_ATTRIBUTES = RENT_ATTRIBUTES.map((attribute) =>
  ["WAREHOUSES", "MAINTENANCE_FEE", "IS_SUITABLE_FOR_PETS", "FURNISHED"].includes(attribute.id)
    ? { ...attribute, required: false, tags: [] }
    : attribute,
);

const leaf = (settings: Partial<PortalCategory["settings"]> = {}): PortalCategory => ({
  id: "MLC183186",
  name: "Propiedades usadas",
  childrenCategories: [],
  settings: {
    listingAllowed: true,
    maxTitleLength: 60,
    maxPicturesPerItem: 30,
    maxDescriptionLength: 50000,
    currencies: ["CLP", "USD", "CLF"],
    minimumPrice: 150000,
    maximumPrice: 9999999999,
    ...settings,
  },
});

const LOCATION: PortalLocationMatch = {
  state: { id: "TUxDUE1FVEExM2JlYg", name: "RM (Metropolitana)" },
  city: { id: "TUxDQ05VTmE", name: "Ñuñoa" },
  neighborhood: null,
};

const catalog = (overrides: Partial<PortalItemCatalog> = {}): PortalItemCatalog => ({
  leaf: leaf(),
  attributes: RENT_ATTRIBUTES,
  location: LOCATION,
  ...overrides,
});

const listing = (overrides: Partial<PublishListing> = {}): PublishListing => ({
  id: "listing-1",
  externalRef: "P001",
  operation: "rent",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Av. Irarrázaval 1234",
  unitNumber: "504",
  showExactAddress: false,
  priceAmount: 650000,
  priceCurrency: "CLP",
  attributes: {
    dormitorios: 2,
    banos: 1,
    estacionamientos: 1,
    bodegas: 0,
    sup_util_m2: 72.5,
    sup_total_m2: 80,
    gastos_comunes_clp: 120000,
    amoblado: false,
    acepta_mascotas: "Sí",
    piso: 5,
    orientacion: "Nororiente",
    ano_construccion: 2015,
    // Campos sin mapeo: nunca van al cuerpo.
    contribuciones_trimestrales_clp: 98765,
    amenities: ["Piscina", "Quincho"],
    requisitos_arriendo: "Aval y 3 liquidaciones",
    disponibilidad: "Inmediata",
  },
  ...overrides,
});

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  publicationId: "0b7c6c1e-2f1a-4f7e-9a0b-3c2d1e0f9a8b",
  platform: "portal_inmobiliario",
  format: "post",
  title: "Departamento en arriendo 2 dormitorios 1 baño en Ñuñoa",
  caption: "Departamento luminoso, a pasos del metro.",
  media: [],
  listing: listing(),
  brokerContact: { name: "Corredora", email: "c@corredor.test", whatsapp: "+56 9 1234 5678" },
  ...overrides,
});

const PICTURES = [{ id: "123-MLC456_102026" }, { id: "124-MLC456_102026" }];
const build = (
  value: PublishInput = input(),
  options: { catalog?: PortalItemCatalog; pictures?: typeof PICTURES | { source: string }[] } = {},
) =>
  buildPortalItem(value, options.catalog ?? catalog(), {
    pictures: options.pictures ?? PICTURES,
    now: () => NOW,
  });

function itemOf(result: PortalItemResult) {
  if (!result.ok) throw new Error(`no se armó: ${JSON.stringify(result.issues)}`);
  return result.item;
}
const codes = (result: PortalItemResult) =>
  result.ok ? [] : result.issues.map((item) => item.code);
const attributesOf = (result: PortalItemResult) =>
  (itemOf(result).body.attributes as Record<string, unknown>[]).map((attribute) => attribute.id);

describe("buildPortalItem", () => {
  it("arriendo de departamento: el cuerpo completo, con los fijos, la ubicación por id y el contacto", () => {
    const item = itemOf(build());

    expect(item.body).toEqual({
      title: "Departamento en arriendo 2 dormitorios 1 baño en Ñuñoa",
      category_id: "MLC183186",
      price: 650000,
      currency_id: "CLP",
      available_quantity: 1,
      buying_mode: "classified",
      listing_type_id: "silver",
      condition: "not_specified",
      channels: ["marketplace"],
      seller_custom_field: "0b7c6c1e-2f1a-4f7e-9a0b-3c2d1e0f9a8b",
      pictures: PICTURES,
      location: {
        country: { id: "CL" },
        state: { id: "TUxDUE1FVEExM2JlYg" },
        city: { id: "TUxDQ05VTmE" },
      },
      seller_contact: {
        contact: "Corredora",
        email: "c@corredor.test",
        country_code2: "56",
        phone2: "912345678",
      },
      attributes: [
        { id: "BEDROOMS", value_name: "2" },
        { id: "FULL_BATHROOMS", value_name: "1" },
        { id: "PARKING_LOTS", value_name: "1" },
        { id: "WAREHOUSES", value_name: "0" },
        { id: "COVERED_AREA", value_name: "72.5 m²", value_struct: { number: 72.5, unit: "m²" } },
        { id: "TOTAL_AREA", value_name: "80 m²", value_struct: { number: 80, unit: "m²" } },
        {
          id: "MAINTENANCE_FEE",
          value_name: "120000 CLP",
          value_struct: { number: 120000, unit: "CLP" },
        },
        { id: "FURNISHED", value_id: "242084" },
        { id: "IS_SUITABLE_FOR_PETS", value_id: "242085" },
        { id: "UNIT_FLOOR", value_name: "5" },
        { id: "FACING", value_id: "2730831" },
        { id: "PROPERTY_AGE", value_name: "11 años", value_struct: { number: 11, unit: "años" } },
        {
          id: "CMG_SITE",
          name: "Site de origen",
          value_id: null,
          value_name: "POI",
          value_struct: null,
          attribute_group_id: "OTHERS",
          attribute_group_name: "Otros",
        },
      ],
    });
    // La descripción va aparte (POST /items/{id}/description), y el contacto se guarda en el progreso.
    expect(item.body).not.toHaveProperty("description");
    expect(item.description).toBe("Departamento luminoso, a pasos del metro.");
    expect(item.sellerContact).toEqual({
      contact: "Corredora",
      email: "c@corredor.test",
      countryCode2: "56",
      phone2: "912345678",
    });
    expect(item.notes).toEqual([]);
  });

  it("nunca lleva campos sin mapeo ni lo que completa la categoría (salvo CMG_SITE)", () => {
    const text = JSON.stringify(itemOf(build()).body);

    for (const value of ["98765", "Quincho", "liquidaciones", "Inmediata", "P001", "listing-1"]) {
      expect(text).not.toContain(value);
    }
    const ids = attributesOf(build());
    expect(ids).not.toContain("PROPERTY_TYPE");
    expect(ids).not.toContain("OPERATION");
    expect(ids).not.toContain("ROOMS");
    expect(ids).not.toContain("HAS_SWIMMING_POOL");
    expect(ids).toContain("CMG_SITE");
  });

  it("UF va como CLF con 2 decimales; pesos, enteros", () => {
    const uf = itemOf(
      build(
        input({
          listing: listing({ operation: "sale", priceAmount: 5800.456, priceCurrency: "UF" }),
        }),
        {
          catalog: catalog({ attributes: SALE_ATTRIBUTES }),
        },
      ),
    );
    expect(uf.body).toMatchObject({ price: 5800.46, currency_id: "CLF" });

    expect(codes(build(input({ listing: listing({ priceAmount: 650000.5 }) })))).toEqual([
      "PORTAL_PRICE_INVALID",
    ]);
    expect(codes(build(input({ listing: listing({ priceAmount: 0 }) })))).toEqual([
      "PORTAL_PRICE_INVALID",
    ]);
  });

  it("la moneda tiene que estar en la hoja; sin dato (null) no bloquea, una lista vacía sí", () => {
    const sale = input({ listing: listing({ priceCurrency: "UF", priceAmount: 20 }) });
    expect(
      codes(build(sale, { catalog: catalog({ leaf: leaf({ currencies: ["CLP", "USD"] }) }) })),
    ).toEqual(["PORTAL_CURRENCY_NOT_ALLOWED"]);
    expect(build(sale, { catalog: catalog({ leaf: leaf({ currencies: null }) }) }).ok).toBe(true);
    expect(codes(build(input(), { catalog: catalog({ leaf: leaf({ currencies: [] }) }) }))).toEqual(
      ["PORTAL_CURRENCY_NOT_ALLOWED"],
    );
  });

  it("el precio bajo el mínimo de la hoja (que no trae moneda) es una advertencia, no un bloqueo", () => {
    const result = build(input({ listing: listing({ priceAmount: 100000 }) }));
    expect(itemOf(result).notes).toEqual([
      "El precio está bajo el mínimo que informa Mercado Libre para la categoría",
    ]);
    // En UF no se compara.
    const uf = build(input({ listing: listing({ priceAmount: 10, priceCurrency: "UF" }) }));
    expect(itemOf(uf).notes).toEqual([]);
  });

  it.each([
    ["sup_total_m2", "Superficie total (m²)"],
    ["sup_util_m2", "Superficie útil (m²)"],
    ["dormitorios", "Dormitorios"],
    ["banos", "Baños"],
    ["estacionamientos", "Estacionamientos"],
    ["bodegas", "Bodegas"],
    ["gastos_comunes_clp", "Gastos comunes (CLP)"],
    ["amoblado", "Amoblado"],
    ["acepta_mascotas", "Acepta mascotas"],
  ])("un obligatorio de la hoja que falta (%s) se pide, nunca se inventa", (field, label) => {
    const attributes = { ...listing().attributes };
    delete attributes[field];

    const result = build(input({ listing: listing({ attributes }) }));

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "PORTAL_FIELD_MISSING",
          message: `Falta ${label}: Mercado Libre la pide en esta categoría`,
        },
      ],
    });
  });

  it("en venta, lo de arriendo que falta no bloquea y no se envía", () => {
    const attributes = { ...listing().attributes };
    for (const field of ["bodegas", "gastos_comunes_clp", "amoblado", "acepta_mascotas"]) {
      delete attributes[field];
    }
    const result = build(
      input({ listing: listing({ operation: "sale", priceAmount: 150000000, attributes }) }),
      { catalog: catalog({ attributes: SALE_ATTRIBUTES }) },
    );

    expect(attributesOf(result)).not.toContain("FURNISHED");
    expect(attributesOf(result)).not.toContain("MAINTENANCE_FEE");
  });

  it("«A consultar» en mascotas: en arriendo se pide elegir; en venta no se envía", () => {
    const attributes = { ...listing().attributes, acepta_mascotas: "A consultar" };
    expect(codes(build(input({ listing: listing({ attributes }) })))).toEqual([
      "PORTAL_PETS_UNDECIDED",
    ]);

    const sale = build(
      input({ listing: listing({ operation: "sale", priceAmount: 150000000, attributes }) }),
      {
        catalog: catalog({ attributes: SALE_ATTRIBUTES }),
      },
    );
    expect(attributesOf(sale)).not.toContain("IS_SUITABLE_FOR_PETS");
  });

  it("una hoja sin el atributo (casas en venta no tienen mascotas): no se envía aunque el Excel lo tenga", () => {
    const attributes = SALE_ATTRIBUTES.filter(
      (attribute) => attribute.id !== "IS_SUITABLE_FOR_PETS" && attribute.id !== "UNIT_FLOOR",
    );
    const ids = attributesOf(
      build(
        input({
          listing: listing({ operation: "sale", propertyType: "Casa", priceAmount: 150000000 }),
        }),
        {
          catalog: catalog({ attributes }),
        },
      ),
    );
    expect(ids).not.toContain("IS_SUITABLE_FOR_PETS");
    expect(ids).not.toContain("UNIT_FLOOR");
  });

  it("un terreno: lo que la hoja trae oculto (gastos comunes, antigüedad) no se envía", () => {
    const terrain = [
      area("TOTAL_AREA"),
      attr("MAINTENANCE_FEE", { valueType: "number_unit", tags: ["hidden"] }),
      attr("PROPERTY_AGE", { valueType: "number_unit", tags: ["hidden"] }),
      attr("CMG_SITE", { valueType: "string", tags: ["hidden"] }),
    ];
    const ids = attributesOf(
      build(
        input({
          listing: listing({ propertyType: "Terreno", operation: "sale", priceAmount: 90000000 }),
        }),
        {
          catalog: catalog({ attributes: terrain }),
        },
      ),
    );
    expect(ids).toEqual(["TOTAL_AREA", "CMG_SITE"]);
  });

  it("una hoja con un obligatorio que no está en la tabla: lo dice (no se inventa); un condicional, advierte", () => {
    const attributes = [
      ...RENT_ATTRIBUTES,
      attr("GUESTS", { name: "Huéspedes", required: true }),
      attr("LOT_TYPE", {
        name: "Tipo de lote",
        conditionalRequired: true,
        tags: ["conditional_required"],
      }),
    ];
    expect(build(input(), { catalog: catalog({ attributes }) })).toEqual({
      ok: false,
      issues: [
        {
          code: "PORTAL_ATTRIBUTE_UNSUPPORTED",
          message:
            "Mercado Libre pide «Huéspedes» (GUESTS) en esta categoría y AgentSales no lo tiene",
        },
      ],
    });
    const conditional = attributes.filter((attribute) => attribute.id !== "GUESTS");
    expect(itemOf(build(input(), { catalog: catalog({ attributes: conditional }) })).notes).toEqual(
      ["Mercado Libre podría pedir «Tipo de lote» (LOT_TYPE) según el aviso"],
    );
  });

  it("sin WhatsApp, o con uno que no se lee, no se arma", () => {
    const contact = { name: "Corredora", email: null };
    expect(codes(build(input({ brokerContact: { ...contact, whatsapp: null } })))).toEqual([
      "PORTAL_WHATSAPP_MISSING",
    ]);
    expect(
      codes(build(input({ brokerContact: { ...contact, whatsapp: "+54 11 1234 5678" } }))),
    ).toEqual(["PORTAL_WHATSAPP_INVALID"]);
  });

  it("show_exact_address: con true, la dirección y la unidad; con false, solo los ids (y el barrio si lo hay)", () => {
    const shown = itemOf(build(input({ listing: listing({ showExactAddress: true }) })));
    expect(shown.body.location).toEqual({
      address_line: "Av. Irarrázaval 1234, 504",
      country: { id: "CL" },
      state: { id: "TUxDUE1FVEExM2JlYg" },
      city: { id: "TUxDQ05VTmE" },
    });

    const hidden = itemOf(
      build(input(), {
        catalog: catalog({
          location: { ...LOCATION, neighborhood: { id: "TUxCQlBMQVphNWM", name: "Plaza Ñuñoa" } },
        }),
      }),
    );
    expect(hidden.body.location).toEqual({
      country: { id: "CL" },
      state: { id: "TUxDUE1FVEExM2JlYg" },
      city: { id: "TUxDQ05VTmE" },
      neighborhood: { id: "TUxCQlBMQVphNWM" },
    });
    expect(JSON.stringify(hidden.body)).not.toContain("Irarrázaval");

    expect(
      codes(build(input({ listing: listing({ showExactAddress: true, address: null }) }))),
    ).toEqual(["PORTAL_FIELD_MISSING"]);
  });

  it("título y fotos según la hoja: el máximo real, al menos una, y por URL en preflight", () => {
    expect(codes(build(input({ title: "x".repeat(61) })))).toEqual(["PORTAL_TITLE_TOO_LONG"]);
    expect(
      build(input({ title: "x".repeat(61) }), {
        catalog: catalog({ leaf: leaf({ maxTitleLength: 140 }) }),
      }).ok,
    ).toBe(true);
    expect(codes(build(input({ title: " " })))).toEqual(["PORTAL_TITLE_MISSING"]);
    expect(codes(build(input(), { pictures: [] }))).toEqual(["PORTAL_PICTURES_MISSING"]);
    expect(
      codes(build(input(), { catalog: catalog({ leaf: leaf({ maxPicturesPerItem: 1 }) }) })),
    ).toEqual(["PORTAL_TOO_MANY_PICTURES"]);
    const sources = [{ source: "https://r2.example/p001/1.jpg?X-Amz-Signature=firma" }];
    expect(itemOf(build(input(), { pictures: sources })).body.pictures).toEqual(sources);
  });

  it("orientación o año que no calzan: no se envían, con una advertencia", () => {
    const attributes = { ...listing().attributes, orientacion: "Sur", ano_construccion: 2030 };
    const item = itemOf(build(input({ listing: listing({ attributes }) })));
    expect(item.body.attributes).not.toContainEqual(expect.objectContaining({ id: "FACING" }));
    expect(item.body.attributes).not.toContainEqual(
      expect.objectContaining({ id: "PROPERTY_AGE" }),
    );
    expect(item.notes).toEqual([
      "La orientación no calza con las de Mercado Libre: no se envía",
      "El año de construcción es futuro: la antigüedad no se envía",
    ]);
  });

  it.each([
    ["dormitorios", "2"],
    ["sup_total_m2", true],
    ["amoblado", "Sí"],
    ["acepta_mascotas", "Tal vez"],
  ])(
    "un obligatorio con el tipo equivocado (%s = %j) no se envía ni se adivina",
    (field, value) => {
      const attributes = { ...listing().attributes, [field]: value };
      expect(codes(build(input({ listing: listing({ attributes }) })))).toEqual([
        "PORTAL_FIELD_MISSING",
      ]);
    },
  );

  it("un precio en UF que redondea a 0 no se envía", () => {
    expect(
      codes(build(input({ listing: listing({ priceAmount: 0.004, priceCurrency: "UF" }) }))),
    ).toEqual(["PORTAL_PRICE_INVALID"]);
  });

  it("una unidad que la hoja no acepta: bloquea si es obligatorio, se omite con aviso si no (nunca se convierte)", () => {
    const hectares = (attribute: PortalAttribute) =>
      attribute.id === "TOTAL_AREA" || attribute.id === "MAINTENANCE_FEE"
        ? { ...attribute, allowedUnits: [{ id: "ha", name: "ha" }] }
        : attribute;
    expect(
      codes(build(input(), { catalog: catalog({ attributes: RENT_ATTRIBUTES.map(hectares) }) })),
    ).toEqual(["PORTAL_UNIT_NOT_ALLOWED", "PORTAL_UNIT_NOT_ALLOWED"]);
    const sale = build(input({ listing: listing({ operation: "sale", priceAmount: 150000000 }) }), {
      catalog: catalog({ attributes: SALE_ATTRIBUTES.map(hectares) }),
    });
    expect(codes(sale)).toEqual(["PORTAL_UNIT_NOT_ALLOWED"]);
    expect(
      itemOf(
        build(input({ listing: listing({ operation: "sale", priceAmount: 150000000 }) }), {
          catalog: catalog({
            attributes: SALE_ATTRIBUTES.map((attribute) =>
              attribute.id === "MAINTENANCE_FEE"
                ? { ...attribute, allowedUnits: [{ id: "USD", name: "USD" }] }
                : attribute,
            ),
          }),
        }),
      ).notes,
    ).toEqual([
      "La categoría no acepta Gastos comunes (CLP) en esa unidad (nunca se convierte): no se envía",
    ]);
  });

  it("CMG_SITE marcado obligatorio en la hoja no se pide: va siempre, fijo", () => {
    const attributes = RENT_ATTRIBUTES.map((attribute) =>
      attribute.id === "CMG_SITE"
        ? { ...attribute, tags: ["required"], required: true }
        : attribute,
    );
    const ids = attributesOf(build(input(), { catalog: catalog({ attributes }) }));
    expect(ids.filter((id) => id === "CMG_SITE")).toHaveLength(1);
  });

  it.each([
    ["Oficina", "rent", ["FULL_BATHROOMS", "PARKING_LOTS", "COVERED_AREA", "TOTAL_AREA"]],
    ["Local comercial", "sale", ["FULL_BATHROOMS", "PARKING_LOTS", "COVERED_AREA", "TOTAL_AREA"]],
    ["Bodega", "rent", ["FULL_BATHROOMS", "PARKING_LOTS", "COVERED_AREA", "TOTAL_AREA"]],
    [
      "Parcela",
      "sale",
      ["BEDROOMS", "FULL_BATHROOMS", "PARKING_LOTS", "COVERED_AREA", "TOTAL_AREA"],
    ],
    ["Estacionamiento", "rent", ["TOTAL_AREA"]],
  ] as const)(
    "%s en %s: envía lo que la hoja tiene y no pide de más",
    (propertyType, operation, ids) => {
      // Una hoja con solo esos atributos, obligatorios (como las reales de esos tipos, nota §12.1).
      const attributes = [
        ...ids.map((id) => (id.endsWith("AREA") ? area(id) : attr(id, { required: true }))),
        attr("CMG_SITE", { valueType: "string", tags: ["hidden"] }),
      ];
      const result = build(
        input({ listing: listing({ propertyType, operation, priceAmount: 150000000 }) }),
        { catalog: catalog({ attributes }) },
      );
      expect(attributesOf(result)).toEqual([...ids, "CMG_SITE"]);
    },
  );

  it("una descripción más larga que el máximo de la hoja no se arma (iría después de crear el ítem)", () => {
    expect(
      codes(
        build(input({ caption: "x".repeat(101) }), {
          catalog: catalog({ leaf: leaf({ maxDescriptionLength: 100 }) }),
        }),
      ),
    ).toEqual(["PORTAL_DESCRIPTION_TOO_LONG"]);
    expect(
      build(input({ caption: "x".repeat(100) }), {
        catalog: catalog({ leaf: leaf({ maxDescriptionLength: 100 }) }),
      }).ok,
    ).toBe(true);
  });

  it("sin el aviso o sin el contacto en el input, no lo supone", () => {
    expect(codes(build(input({ listing: undefined })))).toEqual(["PORTAL_INPUT_INCOMPLETE"]);
    expect(codes(build(input({ brokerContact: undefined })))).toEqual(["PORTAL_INPUT_INCOMPLETE"]);
  });
});

describe("resolvePortalItemCatalog", () => {
  const fake = () => {
    const calls: unknown[] = [];
    return {
      calls,
      catalog: {
        leafCategory: async (path: readonly string[]) => {
          calls.push(["leaf", path]);
          return leaf();
        },
        attributes: async (id: string) => {
          calls.push(["attributes", id]);
          return RENT_ATTRIBUTES;
        },
        location: async (place: { region: string; commune: string }) => {
          calls.push(["location", place]);
          return LOCATION;
        },
      },
    };
  };
  const ctx = { accessToken: async () => "APP_USR-token" };

  it("la hoja por los nombres de la tabla, sus atributos y la ubicación del aviso", async () => {
    const { catalog: portal, calls } = fake();

    const resolved = await resolvePortalItemCatalog(listing(), portal, ctx);

    expect(resolved).toEqual({ leaf: leaf(), attributes: RENT_ATTRIBUTES, location: LOCATION });
    expect(calls).toEqual([
      ["leaf", ["Departamentos", "Arriendo", "Propiedades usadas"]],
      ["attributes", "MLC183186"],
      ["location", { region: "Metropolitana", commune: "Ñuñoa" }],
    ]);
  });

  it("un tipo que no se publica o sin comuna: un error propio, sin llamar al catálogo", async () => {
    const { catalog: portal, calls } = fake();
    await expect(
      resolvePortalItemCatalog(listing({ propertyType: "Galpón" }), portal, ctx),
    ).rejects.toMatchObject({ code: "PORTAL_TYPE_UNSUPPORTED" });
    await expect(
      resolvePortalItemCatalog(listing({ comuna: null }), portal, ctx),
    ).rejects.toMatchObject({ code: "PORTAL_LOCATION_NOT_FOUND", details: { level: "commune" } });
    expect(calls).toEqual([]);
  });
});
