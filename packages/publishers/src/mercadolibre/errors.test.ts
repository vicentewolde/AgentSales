import { describe, expect, it } from "vitest";
import {
  describeCause,
  type MercadoLibreErrorInfo,
  mercadoLibreError,
  mercadoLibreErrorOf,
} from "./errors.js";

const info = (overrides: Partial<MercadoLibreErrorInfo>): MercadoLibreErrorInfo => ({
  httpStatus: 400,
  error: null,
  causes: [],
  ...overrides,
});
const cause = (code: string | null, causeId: number | null = null, type = "error") => ({
  code,
  causeId,
  type,
});

describe("mercadoLibreError", () => {
  it.each([
    [{ error: "invalid_grant" }, "ML_AUTH_INVALID", false],
    [{ error: "invalid_client", httpStatus: 401 }, "ML_APP_CREDENTIALS_INVALID", false],
    [{ error: "unauthorized_client" }, "ML_APP_CREDENTIALS_INVALID", false],
    [{ error: "unauthorized_application", httpStatus: 403 }, "ML_PERMISSION_DENIED", false],
    [{ error: "local_rate_limited" }, "ML_RATE_LIMITED", true],
    [{ httpStatus: 429 }, "ML_RATE_LIMITED", true],
    [{ httpStatus: 401 }, "ML_AUTH_INVALID", false],
    [{ httpStatus: 403, error: "forbidden" }, "ML_PERMISSION_DENIED", false],
    [{ httpStatus: 409 }, "ML_CONFLICT", true],
    [{ httpStatus: 500 }, "ML_UNAVAILABLE", true],
    [{ httpStatus: 503, error: "service_unavailable" }, "ML_UNAVAILABLE", true],
    [{ error: "invalid_request" }, "ML_REQUEST_REJECTED", false],
    [{ httpStatus: 404, error: "not_found" }, "ML_REQUEST_REJECTED", false],
  ] as const)("%o → %s (reintentable: %s)", (overrides, code, retriable) => {
    expect(mercadoLibreError(info(overrides))).toMatchObject({ code, retriable });
  });

  it("los errores del OAuth mandan sobre el status: invalid_client con 401 no es un token vencido", () => {
    const error = mercadoLibreError(info({ httpStatus: 401, error: "invalid_client" }));

    expect(error.code).toBe("ML_APP_CREDENTIALS_INVALID");
    expect(error.message).toContain("la cuenta no cambia");
  });

  it("un 4xx con causas que bloquean es ML_ITEM_REJECTED, con las causas en español y sin repetir", () => {
    const error = mercadoLibreError(
      info({
        error: "validation_error",
        causes: [
          cause("item.attributes.missing_required", 147),
          cause("item.attributes.missing_required", 147),
          cause("seller_contact.phone.invalid"),
          cause(null, 129),
          cause("item.title.length", 999, "warning"),
        ],
      }),
    );

    expect(error).toMatchObject({ code: "ML_ITEM_REJECTED", retriable: false });
    expect(error.message).toBe(
      "Mercado Libre rechazó el aviso: falta un atributo obligatorio de la categoría; falta el contacto del corredor o está mal escrito (WhatsApp); el precio está bajo el mínimo o sobre el máximo",
    );
    expect(error.details).toMatchObject({
      httpStatus: 400,
      error: "validation_error",
      causes: expect.arrayContaining([cause("item.title.length", 999, "warning")]),
    });
  });

  it("solo advertencias no es un rechazo del aviso", () => {
    expect(
      mercadoLibreError(info({ causes: [cause("item.title.length", 1, "warning")] })).code,
    ).toBe("ML_REQUEST_REJECTED");
  });

  it("una causa sin type cuenta como error", () => {
    expect(
      mercadoLibreError(info({ causes: [{ code: "x.y", causeId: 1, type: null }] })).code,
    ).toBe("ML_ITEM_REJECTED");
  });

  it("nombra el código de Mercado Libre o el status si no hay otro", () => {
    expect(mercadoLibreError(info({ error: "invalid_scope" })).message).toBe(
      "Mercado Libre rechazó la petición (invalid_scope)",
    );
    expect(mercadoLibreError(info({ httpStatus: 418 })).message).toBe(
      "Mercado Libre rechazó la petición (código 418)",
    );
  });
});

describe("describeCause", () => {
  it.each([
    [cause("item.category_id.invalid"), "la categoría no es una categoría final de inmuebles"],
    [
      cause("item.attribute.missing_conditional_required"),
      "falta un atributo que la categoría exige en este caso",
    ],
    [cause("LTP_PICTURE_REQUIRED"), "el aviso necesita al menos una foto"],
    [cause(null, 173), "el aviso necesita al menos una foto"],
    [cause("item.pictures.max"), "el aviso tiene más fotos de las permitidas"],
    [cause(null, 3703), "una foto es demasiado chica o tiene un error"],
    [cause("item.price.invalid", 109), "el precio está bajo el mínimo o sobre el máximo"],
    [
      cause("item.description.type.invalid"),
      "la descripción tiene caracteres que Mercado Libre no acepta",
    ],
    [
      cause("seller_contact.missing"),
      "falta el contacto del corredor o está mal escrito (WhatsApp)",
    ],
    [cause("item.otra.cosa", 5), "otra causa (item.otra.cosa)"],
    [cause(null, 5), "otra causa (5)"],
    [cause(null, null), "otra causa (sin código)"],
  ])("%o → %s", (input, text) => {
    expect(describeCause(input)).toBe(text);
  });

  it("con code, el cause_id no lo cambia (el code manda)", () => {
    expect(describeCause(cause("item.otra.cosa", 147))).toBe("otra causa (item.otra.cosa)");
  });
});

describe("errores agregados en la revisión", () => {
  it("invalid_operator_user_id pide la cuenta administradora", () => {
    const error = mercadoLibreError(info({ error: "invalid_operator_user_id" }));

    expect(error.code).toBe("ML_PERMISSION_DENIED");
    expect(error.message).toContain("cuenta administradora");
  });

  it.each([408, 425])("un %i es ML_UNAVAILABLE (reintentable)", (httpStatus) => {
    expect(mercadoLibreError(info({ httpStatus }))).toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
  });
});

describe("mercadoLibreErrorOf", () => {
  it("descarta un error o un código con forma de token (podría ser un secreto)", () => {
    const access = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
    const refresh = "TG-5b9032b4e23464aed1f959f-8035443";
    const fields = mercadoLibreErrorOf({
      error: refresh,
      cause: [
        { code: access, cause_id: 1, type: "error" },
        { code: "algo-8035443", cause_id: 2, type: "error" },
        { code: "item.price.invalid", cause_id: 109, type: "error" },
      ],
    });

    expect(fields).toEqual({
      error: null,
      causes: [
        { code: null, causeId: 1, type: "error" },
        { code: null, causeId: 2, type: "error" },
        { code: "item.price.invalid", causeId: 109, type: "error" },
      ],
    });
    const error = mercadoLibreError({
      httpStatus: 400,
      ...(fields ?? { error: null, causes: [] }),
    });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(
      /APP_USR|TG-|8035443/,
    );
  });

  it("guarda como máximo 20 causas", () => {
    const fields = mercadoLibreErrorOf({
      cause: Array.from({ length: 50 }, (_, index) => ({
        code: `item.causa.${index}`,
        type: "error",
      })),
    });

    expect(fields?.causes).toHaveLength(20);
  });

  it("lee error y cause[], sin el message de Mercado Libre", () => {
    const fields = mercadoLibreErrorOf({
      message: "Validation error con datos del aviso: Av. Siempre Viva 742",
      error: "validation_error",
      status: 400,
      cause: [
        {
          department: "items",
          cause_id: 147,
          type: "error",
          code: "item.attributes.missing_required",
          references: ["item.attributes"],
          message: "Attribute [BEDROOMS] is missing",
        },
        { cause_id: "201", type: "error", code: "item.pictures.max" },
        "no es un objeto",
      ],
    });

    expect(fields).toEqual({
      error: "validation_error",
      causes: [
        { code: "item.attributes.missing_required", causeId: 147, type: "error" },
        { code: "item.pictures.max", causeId: 201, type: "error" },
      ],
    });
    expect(JSON.stringify(fields)).not.toMatch(/Siempre Viva|BEDROOMS/);
  });

  it("descarta un error o un código que no parece identificador (podría traer datos)", () => {
    expect(
      mercadoLibreErrorOf({
        error: "Error validating grant for TG-abc",
        cause: [{ code: "dirección Av. Siempre Viva", cause_id: 1.5, type: "error" }],
      }),
    ).toEqual({ error: null, causes: [{ code: null, causeId: null, type: "error" }] });
  });

  it("null si el cuerpo no es un objeto", () => {
    for (const body of [null, "texto", 42, [1, 2]]) expect(mercadoLibreErrorOf(body)).toBeNull();
  });
});
