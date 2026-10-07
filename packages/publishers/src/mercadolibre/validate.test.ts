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

  it("un 2xx con advertencias: válido y las devuelve", async () => {
    server.use(
      http.post(VALIDATE_URL, () =>
        HttpResponse.json({
          cause: [
            { cause_id: 1, type: "warning", code: "item.title.length" },
            { cause_id: 2, type: "error", code: "no.cuenta.en.un.2xx" },
          ],
        }),
      ),
    );

    await expect(validator.validate(ACCESS, BODY)).resolves.toEqual({
      valid: true,
      warnings: [{ code: "item.title.length", causeId: 1, type: "warning" }],
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
      reasons: [
        "falta un atributo obligatorio de la categoría",
        "falta el contacto del corredor o está mal escrito (WhatsApp)",
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Siempre Viva|TOTAL_AREA/);
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

    for (const request of await recorded()) {
      expect(`${request.method} ${request.url.pathname}`).toBe("POST /items/validate");
    }
  });
});
