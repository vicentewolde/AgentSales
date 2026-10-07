import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreValidator } from "./validate.js";

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const VALIDATE_URL = "https://api.mercadolibre.com/items/validate";
const BODY = {
  title: "Departamento en arriendo",
  category_id: "MLC157520",
  price: 650000,
  currency_id: "CLP",
  listing_type_id: "silver",
  seller_contact: { country_code2: "56", phone2: "912345678" },
};

const { server, recorded } = usePlatformServer();
const validator = createMercadoLibreValidator();

describe("createMercadoLibreValidator", () => {
  it("204: válido, sin advertencias; el cuerpo va en JSON con Bearer, a /items/validate", async () => {
    server.use(http.post(VALIDATE_URL, () => new HttpResponse(null, { status: 204 })));

    await expect(validator.validate(ACCESS, BODY)).resolves.toEqual({ valid: true, warnings: [] });

    const requests = await recorded();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${ACCESS}`,
      contentType: "application/json",
      json: BODY,
    });
    expect(requests[0]?.url.toString()).toBe(VALIDATE_URL);
  });

  it("un 2xx con advertencias (sin type o warning): válido y las devuelve", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json({
          warnings: [{ cause_id: 9, code: "item.sin.tipo" }],
          cause: [{ cause_id: 1, type: "warning", code: "item.title.length" }],
        }),
      ),
    );

    await expect(validator.validate(ACCESS, BODY)).resolves.toEqual({
      valid: true,
      warnings: [
        { code: "item.sin.tipo", causeId: 9, type: null },
        { code: "item.title.length", causeId: 1, type: "warning" },
      ],
    });
  });

  it("un 2xx con una causa de tipo error no se declara válido (ML_UNEXPECTED_RESPONSE)", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json({ cause: [{ cause_id: 2, type: "error", code: "x.y" }] }),
      ),
    );

    await expect(validator.validate(ACCESS, BODY)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "validateItem" },
    });
  });

  it("400 con errores y advertencias: no válido, motivos en español sin repetir y sin el message", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json(
          {
            message: "Validation error",
            error: "validation_error",
            status: 400,
            cause: [
              {
                department: "items",
                cause_id: 147,
                type: "error",
                code: "item.attributes.missing_required",
                references: ["item.attributes"],
                message: "Attribute [TOTAL_AREA] is missing en Av. Siempre Viva 742",
              },
              { cause_id: 147, type: "error", code: "item.attributes.missing_required" },
              { type: "error", code: "seller_contact.phone2.invalid" },
              { cause_id: 3, type: "warning", code: "item.title.length" },
            ],
          },
          { status: 400 },
        ),
      ),
    );

    const result = await validator.validate(ACCESS, BODY);

    expect(result).toEqual({
      valid: false,
      errors: [
        { code: "item.attributes.missing_required", causeId: 147, type: "error" },
        { code: "item.attributes.missing_required", causeId: 147, type: "error" },
        { code: "seller_contact.phone2.invalid", causeId: null, type: "error" },
      ],
      warnings: [{ code: "item.title.length", causeId: 3, type: "warning" }],
      issues: [
        {
          code: "item.attributes.missing_required",
          message: "falta un atributo obligatorio de la categoría",
        },
        {
          code: "seller_contact.phone2.invalid",
          message: "falta el contacto del corredor o está mal escrito (WhatsApp)",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Siempre Viva|TOTAL_AREA/);
  });

  it("un 422 con causas también es un rechazo; un issue sin código usa el cause_id", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json({ cause: [{ cause_id: 129, type: "error" }] }, { status: 422 }),
      ),
    );

    await expect(validator.validate(ACCESS, BODY)).resolves.toMatchObject({
      valid: false,
      issues: [{ code: "cause_129", message: "el precio está bajo el mínimo o sobre el máximo" }],
    });
  });

  it("un 404 con causas no es un rechazo del aviso (la ruta): se lanza", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json(
          { cause: [{ cause_id: 1, type: "error", code: "x.y" }] },
          { status: 404 },
        ),
      ),
    );

    await expect(validator.validate(ACCESS, BODY)).rejects.toMatchObject({
      code: "ML_ITEM_REJECTED",
      details: { httpStatus: 404 },
    });
  });

  it("un 400 sin causas que bloqueen (solo advertencias o ninguna) se lanza, no es un resultado", async () => {
    const replies = [
      { error: "body.invalid_field_types", status: 400, cause: [] },
      { error: "validation_error", status: 400, cause: [{ type: "warning", code: "x.y" }] },
    ];
    for (const body of replies) {
      server.use(http.post(VALIDATE_URL, () => HttpResponse.json(body, { status: 400 })));
      await expect(validator.validate(ACCESS, BODY)).rejects.toMatchObject({
        code: "ML_REQUEST_REJECTED",
      });
    }
  });

  it.each([
    [401, "ML_AUTH_INVALID", false],
    [403, "ML_PERMISSION_DENIED", false],
    [429, "ML_RATE_LIMITED", true],
    [503, "ML_UNAVAILABLE", true],
  ] as const)(
    "un %i se lanza como %s (no es un rechazo del aviso)",
    async (status, code, retriable) => {
      server.use(http.post(VALIDATE_URL, () => HttpResponse.json({}, { status })));

      const error = await validator.validate(ACCESS, BODY).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code, retriable });
      expect(errorText(error)).not.toContain(ACCESS);
    },
  );

  it("sin conexión es ML_UNAVAILABLE (reintentable)", async () => {
    server.use(http.post(VALIDATE_URL, () => HttpResponse.error()));

    await expect(validator.validate(ACCESS, BODY)).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
  });

  it("solo llama a /items/validate: nunca crea ni modifica un ítem", async () => {
    server.use(http.post(VALIDATE_URL, () => new HttpResponse(null, { status: 204 })));

    await validator.validate(ACCESS, BODY);
    await validator.validate(ACCESS, { ...BODY, title: "Otro" });

    const requests = await recorded();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(`${request.method} ${request.url.pathname}`).toBe("POST /items/validate");
    }
  });
});
