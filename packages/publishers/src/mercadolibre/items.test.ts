import { readFileSync } from "node:fs";
import type { PortalSellerContact } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreItems, type MercadoLibreItems } from "./items.js";

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const API = "https://api.mercadolibre.com";
const ITEM_ID = "MLC1234567890";
const USER_ID = "8035443";
const PUBLICATION_ID = "0b7c6c1e-2f1a-4f7e-9a0b-3c2d1e0f9a8b";
const CONTACT: PortalSellerContact = {
  contact: "Corredora de Prueba",
  email: "contacto@corredor.test",
  countryCode2: "56",
  phone2: "912345678",
};

const { server, requests } = usePlatformServer();
const items = createMercadoLibreItems();

/** Un ítem como lo devuelve Mercado Libre (nota §4.1, ejemplo MLA adaptado a MLC). */
const itemBody = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM_ID,
  site_id: "MLC",
  title: "Departamento en arriendo",
  seller_id: 8035443,
  permalink: "https://departamento.mercadolibre.cl/MLC-1234567890-departamento-_JM",
  status: "paused",
  sub_status: ["picture_download_pending"],
  start_time: "2026-10-07T12:00:00.000Z",
  stop_time: "2026-11-21T12:00:00.000-03:00",
  expiration_time: "2026-11-06T12:00:00.000-03:00",
  last_updated: "2026-10-07T12:00:01.000Z",
  tags: ["good_quality_thumbnail"],
  listing_source: "portalinmobiliario",
  seller_custom_field: PUBLICATION_ID,
  seller_contact: { phone2: "912345678" },
  ...overrides,
});

const expectBearer = () => {
  for (const request of requests) {
    expect(request.authorization).toBe(`Bearer ${ACCESS}`);
    expect(request.url.toString()).not.toContain(ACCESS);
  }
};

describe("createMercadoLibreItems", () => {
  it("create: POST /items con el cuerpo en JSON, tal cual, y el ítem leído", async () => {
    server.use(http.post(`${API}/items`, () => HttpResponse.json(itemBody(), { status: 201 })));
    const body = {
      title: "Departamento en arriendo",
      category_id: "MLC1474",
      listing_type_id: "silver",
      seller_custom_field: PUBLICATION_ID,
      pictures: [{ id: "123-MLC456_102026" }],
    };

    const item = await items.create(ACCESS, body);

    expect(item).toEqual({
      id: ITEM_ID,
      permalink: "https://departamento.mercadolibre.cl/MLC-1234567890-departamento-_JM",
      status: "paused",
      subStatus: ["picture_download_pending"],
      startTime: "2026-10-07T12:00:00.000Z",
      stopTime: "2026-11-21T12:00:00.000-03:00",
      expirationTime: "2026-11-06T12:00:00.000-03:00",
      lastUpdated: "2026-10-07T12:00:01.000Z",
      tags: ["good_quality_thumbnail"],
      listingSource: "portalinmobiliario",
      sellerCustomField: PUBLICATION_ID,
      warnings: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      contentType: "application/json",
      json: body,
    });
    expectBearer();
  });

  it("create devuelve las advertencias (warnings o cause[] con type warning) sin bloquear", async () => {
    server.use(
      http.post(`${API}/items`, () =>
        HttpResponse.json(
          itemBody({
            warnings: [
              {
                department: "items",
                cause_id: 7810,
                type: "warning",
                code: "item.attribute.missing_conditional_required",
                message: "Dirección Av. Siempre Viva 742 incompleta",
              },
            ],
            cause: [
              { cause_id: 1, type: "warning", code: "item.title.length" },
              { cause_id: 2, type: "error", code: "no.es.advertencia" },
            ],
          }),
          { status: 201 },
        ),
      ),
    );

    const item = await items.create(ACCESS, { title: "x" });

    expect(item.warnings).toEqual([
      { code: "item.attribute.missing_conditional_required", causeId: 7810, type: "warning" },
      { code: "item.title.length", causeId: 1, type: "warning" },
    ]);
    expect(JSON.stringify(item)).not.toContain("Siempre Viva");
  });

  it("create rechazado: ML_ITEM_REJECTED con las causas y las advertencias en los detalles", async () => {
    server.use(
      http.post(`${API}/items`, () =>
        HttpResponse.json(
          {
            message: "Validation error",
            error: "validation_error",
            status: 400,
            cause: [
              { cause_id: 173, type: "error", code: "item.listing_type_id.requiresPictures" },
              { cause_id: 2, type: "warning", code: "item.title.length" },
            ],
          },
          { status: 400 },
        ),
      ),
    );

    const error = await items.create(ACCESS, {}).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ML_ITEM_REJECTED",
      message: "Mercado Libre rechazó el aviso: el aviso necesita al menos una foto",
      details: {
        causes: [
          { code: "item.listing_type_id.requiresPictures", causeId: 173, type: "error" },
          { code: "item.title.length", causeId: 2, type: "warning" },
        ],
      },
    });
  });

  it("get: GET /items/{id} sin cuerpo; campos que faltan quedan vacíos", async () => {
    server.use(
      http.get(`${API}/items/${ITEM_ID}`, () =>
        HttpResponse.json({ id: ITEM_ID, status: "active", sub_status: "raro", tags: null }),
      ),
    );

    const item = await items.get(ACCESS, ITEM_ID);

    expect(item).toMatchObject({
      id: ITEM_ID,
      status: "active",
      subStatus: [],
      tags: [],
      permalink: null,
      stopTime: null,
      warnings: [],
    });
    expect(requests[0]).toMatchObject({ method: "GET", rawBody: null });
    expectBearer();
  });

  it.each([["paused"], ["active"], ["closed"]] as const)(
    "setStatus %s: PUT con el estado y el seller_contact completo, solo dígitos",
    async (status) => {
      server.use(
        http.put(`${API}/items/${ITEM_ID}`, () => HttpResponse.json(itemBody({ status }))),
      );

      const item = await items.setStatus(ACCESS, ITEM_ID, status, CONTACT);

      expect(item.status).toBe(status);
      expect(requests[0]).toMatchObject({
        method: "PUT",
        contentType: "application/json",
        json: {
          status,
          seller_contact: {
            contact: "Corredora de Prueba",
            email: "contacto@corredor.test",
            country_code2: "56",
            phone2: "912345678",
          },
        },
      });
      expectBearer();
    },
  );

  it("setStatus omite contact y email nulos (Mercado Libre pide solo dígitos y sin vacíos)", async () => {
    server.use(http.put(`${API}/items/${ITEM_ID}`, () => HttpResponse.json(itemBody())));

    await items.setStatus(ACCESS, ITEM_ID, "paused", { ...CONTACT, contact: null, email: null });

    expect(requests[0]?.json).toEqual({
      status: "paused",
      seller_contact: { country_code2: "56", phone2: "912345678" },
    });
  });

  it("setStatus sin el contacto, rechazado por Mercado Libre: ML_ITEM_REJECTED con el motivo", async () => {
    server.use(
      http.put(`${API}/items/${ITEM_ID}`, () =>
        HttpResponse.json(
          {
            error: "validation_error",
            status: 400,
            cause: [{ type: "error", code: "seller_contact.phone2.required" }],
          },
          { status: 400 },
        ),
      ),
    );

    await expect(items.setStatus(ACCESS, ITEM_ID, "active", CONTACT)).rejects.toMatchObject({
      code: "ML_ITEM_REJECTED",
      message: expect.stringContaining("WhatsApp"),
    });
  });

  it("setStatus con 409 (optimistic locking) es ML_CONFLICT, reintentable", async () => {
    server.use(
      http.put(`${API}/items/${ITEM_ID}`, () =>
        HttpResponse.json(
          { message: "item optimistic locking error", status: 409 },
          { status: 409 },
        ),
      ),
    );

    await expect(items.setStatus(ACCESS, ITEM_ID, "closed", CONTACT)).rejects.toMatchObject({
      code: "ML_CONFLICT",
      retriable: true,
    });
  });

  it("addDescription: POST /items/{id}/description con plain_text, saltos incluidos", async () => {
    server.use(
      http.post(`${API}/items/${ITEM_ID}/description`, () =>
        HttpResponse.json({ text: "", plain_text: "Línea 1\nLínea 2" }, { status: 201 }),
      ),
    );

    await items.addDescription(ACCESS, ITEM_ID, "Línea 1\nLínea 2");

    expect(requests[0]).toMatchObject({
      method: "POST",
      json: { plain_text: "Línea 1\nLínea 2" },
    });
    expectBearer();
  });

  it("hideAddress: PUT /items/{id}/address_line_by_reference sin cuerpo", async () => {
    server.use(
      http.put(
        `${API}/items/${ITEM_ID}/address_line_by_reference`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    await items.hideAddress(ACCESS, ITEM_ID);

    expect(requests[0]).toMatchObject({ method: "PUT", rawBody: "", contentType: null });
    expectBearer();
  });

  it("findBySellerCustomField: ?sku=<id de la publicación> y los ids encontrados", async () => {
    server.use(
      http.get(`${API}/users/${USER_ID}/items/search`, () =>
        HttpResponse.json({
          seller_id: USER_ID,
          query: null,
          paging: { limit: 50, offset: 0, total: 1 },
          results: [ITEM_ID],
          orders: [{ id: "stop_time_asc", name: "Order by stop time ascending" }],
        }),
      ),
    );

    const found = await items.findBySellerCustomField(ACCESS, USER_ID, PUBLICATION_ID);

    expect(found).toEqual([ITEM_ID]);
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      sku: PUBLICATION_ID,
    });
    expectBearer();
  });

  it("findBySellerCustomField sin resultados devuelve una lista vacía", async () => {
    server.use(
      http.get(`${API}/users/${USER_ID}/items/search`, () =>
        HttpResponse.json({ results: [], paging: { total: 0 } }),
      ),
    );

    await expect(items.findBySellerCustomField(ACCESS, USER_ID, PUBLICATION_ID)).resolves.toEqual(
      [],
    );
  });

  it("un id que no es de Mercado Libre no se llama (ML_ID_INVALID, sin el valor)", async () => {
    const calls: Array<(client: MercadoLibreItems) => Promise<unknown>> = [
      (client) => client.get(ACCESS, "../users/me"),
      (client) => client.setStatus(ACCESS, "MLC123/description", "closed", CONTACT),
      (client) => client.addDescription(ACCESS, "MLC 123", "x"),
      (client) => client.hideAddress(ACCESS, "123"),
    ];
    for (const run of calls) {
      const error = await run(items).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "ML_ID_INVALID", details: { kind: "item" } });
      expect(errorText(error)).not.toMatch(/users\/me|MLC 123|description/);
    }
    await expect(
      items.findBySellerCustomField(ACCESS, "8035443/../..", PUBLICATION_ID),
    ).rejects.toMatchObject({ code: "ML_ID_INVALID", details: { kind: "user" } });
    expect(requests).toHaveLength(0);
  });

  it("una respuesta sin id válido o un resultado de búsqueda raro es ML_UNEXPECTED_RESPONSE", async () => {
    server.use(
      http.get(`${API}/items/${ITEM_ID}`, () => HttpResponse.json({ id: "x", status: "active" })),
      http.get(`${API}/users/${USER_ID}/items/search`, () =>
        HttpResponse.json({ results: [{ id: ITEM_ID }] }),
      ),
    );

    await expect(items.get(ACCESS, ITEM_ID)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "getItem" },
    });
    await expect(
      items.findBySellerCustomField(ACCESS, USER_ID, PUBLICATION_ID),
    ).rejects.toMatchObject({ code: "ML_UNEXPECTED_RESPONSE" });
  });

  it("una llamada a create que no termina es ML_UNAVAILABLE: quien llama busca antes de repetir", async () => {
    server.use(http.post(`${API}/items`, () => HttpResponse.error()));

    await expect(items.create(ACCESS, {})).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
  });

  describe("nunca borra ítems", () => {
    it("setStatus no acepta otro estado (deleted), ni con un cast: no llama", async () => {
      for (const status of ["deleted", "DELETED", "inactive"]) {
        await expect(
          items.setStatus(ACCESS, ITEM_ID, status as "closed", CONTACT),
        ).rejects.toMatchObject({ code: "ML_STATUS_NOT_ALLOWED" });
      }
      expect(requests).toHaveLength(0);
    });

    it("ninguna operación manda DELETE ni deleted, y el código no los tiene", async () => {
      server.use(
        http.post(`${API}/items`, () => HttpResponse.json(itemBody(), { status: 201 })),
        http.get(`${API}/items/${ITEM_ID}`, () => HttpResponse.json(itemBody())),
        http.put(`${API}/items/${ITEM_ID}`, () => HttpResponse.json(itemBody())),
        http.post(`${API}/items/${ITEM_ID}/description`, () => HttpResponse.json({})),
        http.put(`${API}/items/${ITEM_ID}/address_line_by_reference`, () => HttpResponse.json({})),
        http.get(`${API}/users/${USER_ID}/items/search`, () => HttpResponse.json({ results: [] })),
      );

      await items.create(ACCESS, { title: "x" });
      await items.get(ACCESS, ITEM_ID);
      for (const status of ["paused", "active", "closed"] as const) {
        await items.setStatus(ACCESS, ITEM_ID, status, CONTACT);
      }
      await items.addDescription(ACCESS, ITEM_ID, "x");
      await items.hideAddress(ACCESS, ITEM_ID);
      await items.findBySellerCustomField(ACCESS, USER_ID, PUBLICATION_ID);

      expect(requests).toHaveLength(8);
      for (const request of requests) {
        expect(request.method).not.toBe("DELETE");
        expect(request.rawBody ?? "").not.toContain("deleted");
      }
      for (const file of ["items.ts", "http.ts", "pictures.ts"]) {
        const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
        expect(source).not.toMatch(/"DELETE"|deleted:\s*true|"deleted"/);
      }
    });
  });
});
