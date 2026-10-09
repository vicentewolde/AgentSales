import {
  AppError,
  type EnsureAccessTokenOptions,
  MERCADOLIBRE_REJECTED_AFTER_REFRESH,
  type PlatformAccount,
  type PlatformContext,
  type PortalProgress,
  type PublishedRef,
} from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreItems, type MercadoLibreItems } from "./items.js";
import { createPortalOperations, MERCADOLIBRE_MODERATION_TAG } from "./operations.js";

const API = "https://api.mercadolibre.com";
const ITEM_ID = "MLC1234567890";
const NOW = new Date("2026-10-08T12:00:00Z");

const { server, recorded } = usePlatformServer();

/** El contacto enviado al crear (el del progreso); el corredor pudo cambiar su WhatsApp después. */
const SAVED_CONTACT = {
  contact: "Corredora",
  email: "c@corredor.test",
  countryCode2: "56",
  phone2: "912345678",
};
const PROGRESS: PortalProgress = {
  pictureIds: ["1-MLC_PIC"],
  sellerContact: SAVED_CONTACT,
  createRequestedAt: NOW.toISOString(),
  itemId: ITEM_ID,
  descriptionDone: true,
};
const REF: PublishedRef = { externalId: ITEM_ID, progress: PROGRESS };

const ACCOUNT: PlatformAccount = {
  id: "account-1",
  brokerId: "broker-1",
  platform: "portal_inmobiliario",
  externalAccountId: "8035443",
  displayName: "VICENTEWOLDE",
  status: "connected",
  tokenExpiresAt: null,
  meta: {},
  hasCredentials: true,
  createdAt: NOW,
  updatedAt: NOW,
};

/** Un ítem como lo devuelve Mercado Libre, con el estado pedido. */
const itemBody = (status: string, extra: Record<string, unknown> = {}) => ({
  id: ITEM_ID,
  status,
  sub_status: status === "closed" ? ["expired"] : [],
  permalink: `https://departamento.mercadolibre.cl/${ITEM_ID}-_JM`,
  stop_time: "2027-04-06T12:00:01.000-03:00",
  expiration_time: "2026-11-07T12:00:01.000-03:00",
  tags: [],
  seller_custom_field: "0b7c6c1e-2f1a-4f7e-9a0b-3c2d1e0f9a8b",
  ...extra,
});

const unauthorized = () =>
  HttpResponse.json({ message: "invalid token", error: "unauthorized" }, { status: 401 });

function setup(items: Pick<MercadoLibreItems, "get" | "setStatus" | "getLastModeration">) {
  const tokenCalls: EnsureAccessTokenOptions[] = [];
  const ctx: PlatformContext = {
    account: ACCOUNT,
    accessToken: async (opts = {}) => {
      tokenCalls.push(opts);
      return `APP_USR-token-${tokenCalls.length}`;
    },
  };
  return { operations: createPortalOperations({ items }), ctx, tokenCalls };
}

const client = () => setup(createMercadoLibreItems());

/** Mercado Libre responde al `PUT` con el estado que le pidieron. */
const usePut = () =>
  server.use(
    http.put(`${API}/items/${ITEM_ID}`, async ({ request }) => {
      const { status } = (await request.json()) as { status: string };
      return HttpResponse.json(itemBody(status));
    }),
  );

describe("createPortalOperations · pausar, reactivar y cerrar", () => {
  it("cada una manda su estado con el seller_contact guardado y devuelve el estado del ítem", async () => {
    usePut();
    const { operations, ctx } = client();

    expect(await operations.pause(REF, ctx)).toEqual({
      status: "paused",
      subStatus: [],
      stopTime: "2027-04-06T12:00:01.000-03:00",
      expirationTime: "2026-11-07T12:00:01.000-03:00",
    });
    expect(await operations.resume(REF, ctx)).toMatchObject({ status: "active" });
    expect(await operations.close(REF, ctx)).toEqual({
      status: "closed",
      subStatus: ["expired"],
      stopTime: "2027-04-06T12:00:01.000-03:00",
      expirationTime: "2026-11-07T12:00:01.000-03:00",
    });

    const requests = await recorded();
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      `PUT /items/${ITEM_ID}`,
      `PUT /items/${ITEM_ID}`,
      `PUT /items/${ITEM_ID}`,
    ]);
    const seller_contact = {
      contact: "Corredora",
      email: "c@corredor.test",
      country_code2: "56",
      phone2: "912345678",
    };
    expect(requests.map((request) => request.json)).toEqual([
      { status: "paused", seller_contact },
      { status: "active", seller_contact },
      { status: "closed", seller_contact },
    ]);
    // Cada operación pide su token al proveedor (sin estado).
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer APP_USR-token-1",
      "Bearer APP_USR-token-2",
      "Bearer APP_USR-token-3",
    ]);
    for (const request of requests) expect(request.rawBody).not.toContain("deleted");
  });

  it("sin el contacto guardado, ilegible o de otro ítem: PORTAL_PROGRESS_UNUSABLE sin llamar", async () => {
    usePut();
    const { operations, ctx, tokenCalls } = client();
    const { sellerContact: _none, ...withoutContact } = PROGRESS;
    // `publish` guarda el `itemId` antes de devolver: sin él, el progreso no es de este ítem.
    const { itemId: _id, ...withoutItemId } = PROGRESS;
    const cases: Array<[unknown, string]> = [
      [null, "missing"],
      [withoutContact, "missing"],
      [{ pictureIds: "no es una lista" }, "unreadable"],
      [{ ...PROGRESS, itemId: "MLC9999999999" }, "other_item"],
      [withoutItemId, "other_item"],
    ];
    for (const [progress, reason] of cases) {
      for (const operation of [operations.pause, operations.resume, operations.close]) {
        await expect(operation({ externalId: ITEM_ID, progress }, ctx)).rejects.toMatchObject({
          code: "PORTAL_PROGRESS_UNUSABLE",
          retriable: false,
          details: { reason },
        });
      }
    }
    expect(await recorded()).toEqual([]);
    expect(tokenCalls).toEqual([]);
  });

  it("cada problema del progreso tiene su propio mensaje", async () => {
    const { operations, ctx } = client();
    const messageOf = async (progress: unknown) =>
      (
        (await operations
          .close({ externalId: ITEM_ID, progress }, ctx)
          .catch((e: unknown) => e)) as Error
      ).message;

    const messages = new Set([
      await messageOf(null),
      await messageOf({ pictureIds: 1 }),
      await messageOf({ ...PROGRESS, itemId: "MLC9999999999" }),
    ]);
    expect(messages.size).toBe(3);
    expect(await messageOf({ pictureIds: 1 })).toContain("no se puede leer");
  });

  it("un 401 refresca una vez con el token rechazado y repite solo esa llamada", async () => {
    let calls = 0;
    server.use(
      http.put(`${API}/items/${ITEM_ID}`, () => {
        calls += 1;
        return calls === 1 ? unauthorized() : HttpResponse.json(itemBody("paused"));
      }),
    );
    const { operations, ctx, tokenCalls } = client();

    expect(await operations.pause(REF, ctx)).toMatchObject({ status: "paused" });
    expect(tokenCalls).toEqual([{}, { rejectedToken: "APP_USR-token-1" }]);
    expect((await recorded()).map((request) => request.authorization)).toEqual([
      "Bearer APP_USR-token-1",
      "Bearer APP_USR-token-2",
    ]);
  });

  it("un 401 que se repite sube marcado (rejected_after_refresh), sin un tercer intento", async () => {
    server.use(http.put(`${API}/items/${ITEM_ID}`, unauthorized));
    const { operations, ctx, tokenCalls } = client();

    await expect(operations.close(REF, ctx)).rejects.toMatchObject({
      code: "ML_AUTH_INVALID",
      retriable: false,
      details: { reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
    });
    expect(tokenCalls).toHaveLength(2);
    expect(await recorded()).toHaveLength(2);
  });

  it("los errores de Mercado Libre suben con su retriable (409 conflicto, 5xx, un rechazo)", async () => {
    const { operations, ctx } = client();
    const cases: Array<[() => Response, string, boolean]> = [
      [
        () => HttpResponse.json({ message: "item optimistic locking" }, { status: 409 }),
        "ML_CONFLICT",
        true,
      ],
      [() => HttpResponse.json({ message: "boom" }, { status: 503 }), "ML_UNAVAILABLE", true],
      [
        () =>
          HttpResponse.json(
            {
              message: "bad",
              error: "validation_error",
              cause: [{ code: "seller_contact.phone.invalid", type: "error" }],
            },
            { status: 400 },
          ),
        "ML_ITEM_REJECTED",
        false,
      ],
    ];
    for (const [response, code, retriable] of cases) {
      server.use(http.put(`${API}/items/${ITEM_ID}`, response));
      await expect(operations.pause(REF, ctx)).rejects.toMatchObject({ code, retriable });
    }
  });

  it("un id que no es de Mercado Libre no se llama (ML_ID_INVALID)", async () => {
    const { operations, ctx } = client();
    const ref = { externalId: "dry-run:abc", progress: { ...PROGRESS, itemId: "dry-run:abc" } };

    await expect(operations.close(ref, ctx)).rejects.toMatchObject({ code: "ML_ID_INVALID" });
    await expect(operations.getStatus(ref, ctx)).rejects.toMatchObject({ code: "ML_ID_INVALID" });
    expect(await recorded()).toEqual([]);
  });
});

describe("createPortalOperations · getStatus", () => {
  const useItem = (body: Record<string, unknown>) =>
    server.use(http.get(`${API}/items/${ITEM_ID}`, () => HttpResponse.json(body)));
  const useModeration = (response: () => Response) =>
    server.use(http.get(`${API}/moderations/last_moderation/${ITEM_ID}-ITM`, response));

  it("lee el ítem (GET /items/{id}) y devuelve su estado; sin progreso también", async () => {
    useItem(itemBody("active", { sub_status: ["pack_quota_assigned"] }));
    const { operations, ctx } = client();

    expect(await operations.getStatus({ externalId: ITEM_ID, progress: null }, ctx)).toEqual({
      status: "active",
      subStatus: ["pack_quota_assigned"],
      stopTime: "2027-04-06T12:00:01.000-03:00",
      expirationTime: "2026-11-07T12:00:01.000-03:00",
    });
    expect(
      (await recorded()).map((request) => `${request.method} ${request.url.pathname}`),
    ).toEqual([`GET /items/${ITEM_ID}`]);
  });

  it("pausado sin la etiqueta de moderación (lo pausó el operador): no pregunta el motivo", async () => {
    useItem(itemBody("paused", { tags: ["good_quality_thumbnail"] }));
    const { operations, ctx } = client();

    const status = await operations.getStatus(REF, ctx);

    expect(status).not.toHaveProperty("reason");
    expect(await recorded()).toHaveLength(1);
  });

  it("pausado por moderación: el motivo con su código y un texto propio, nunca el de Mercado Libre", async () => {
    useItem(itemBody("paused", { tags: [MERCADOLIBRE_MODERATION_TAG] }));
    useModeration(() =>
      HttpResponse.json([
        {
          name: "ABANDONED_ITEM_REX_DEN",
          id: "9195714319",
          date_created: "2026-06-03T18:58:51.000-0400",
          wordings: [
            { type: "REASON", value: "Reportada como no disponible." },
            { type: "REMEDY", value: "Pausamos esta publicación porque tus personas interesadas…" },
          ],
          evidence: [{ text_matched: "El precio alertado es 77393", section_name: "item" }],
        },
      ]),
    );
    const { operations, ctx } = client();

    const status = await operations.getStatus(REF, ctx);

    expect(status).toEqual({
      status: "paused",
      subStatus: [],
      stopTime: "2027-04-06T12:00:01.000-03:00",
      expirationTime: "2026-11-07T12:00:01.000-03:00",
      reason: {
        code: "ABANDONED_ITEM_REX_DEN",
        message:
          "Mercado Libre la pausó porque la reportaron como no disponible: si se vendió o arrendó, ciérrala; si no, reactívala",
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/Reportada|personas interesadas|77393/);
    expect((await recorded()).map((request) => request.url.pathname)).toEqual([
      `/items/${ITEM_ID}`,
      `/moderations/last_moderation/${ITEM_ID}-ITM`,
    ]);
  });

  it("una moderación desconocida o sin nombre se muestra con su código", async () => {
    useItem(itemBody("paused", { tags: [MERCADOLIBRE_MODERATION_TAG] }));
    const { operations, ctx } = client();

    useModeration(() => HttpResponse.json([{ name: "NEW_FILTER_2027" }]));
    expect((await operations.getStatus(REF, ctx)).reason).toEqual({
      code: "NEW_FILTER_2027",
      message: "Mercado Libre la pausó por moderación (NEW_FILTER_2027)",
    });
    // Un nombre que existe en los objetos de JavaScript no da una función como texto.
    useModeration(() => HttpResponse.json([{ name: "constructor" }]));
    expect((await operations.getStatus(REF, ctx)).reason).toEqual({
      code: "constructor",
      message: "Mercado Libre la pausó por moderación (constructor)",
    });
    useModeration(() => HttpResponse.json([{ name: "con espacios y datos" }]));
    expect((await operations.getStatus(REF, ctx)).reason).toEqual({
      code: "unknown",
      message: "Mercado Libre la pausó por moderación (unknown)",
    });
  });

  it("sin moderación (404 o lista vacía) o si leerla falla: el estado sin motivo", async () => {
    useItem(itemBody("paused", { tags: [MERCADOLIBRE_MODERATION_TAG] }));
    const { operations, ctx } = client();
    const responses = [
      () => HttpResponse.json({ message: "not found" }, { status: 404 }),
      () => HttpResponse.json([]),
      () => HttpResponse.json({ message: "boom" }, { status: 500 }),
      () => HttpResponse.json({ message: "forbidden", error: "forbidden" }, { status: 403 }),
      () => HttpResponse.json({ otra: "forma" }),
    ];
    for (const response of responses) {
      useModeration(response);
      const status = await operations.getStatus(REF, ctx);
      expect(status).toMatchObject({ status: "paused" });
      expect(status).not.toHaveProperty("reason");
    }
  });

  it("leer el motivo con un token rechazado otra vez, o cortado, sube: no se esconde", async () => {
    useItem(itemBody("paused", { tags: [MERCADOLIBRE_MODERATION_TAG] }));
    useModeration(unauthorized);
    const { operations, ctx } = client();

    await expect(operations.getStatus(REF, ctx)).rejects.toMatchObject({
      code: "ML_AUTH_INVALID",
      details: { reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
    });

    const aborted = setup({
      get: async () => ({
        id: ITEM_ID,
        permalink: null,
        status: "paused",
        subStatus: [],
        startTime: null,
        stopTime: null,
        expirationTime: null,
        lastUpdated: null,
        tags: [MERCADOLIBRE_MODERATION_TAG],
        listingSource: null,
        sellerCustomField: null,
        warnings: [],
      }),
      setStatus: async () => {
        throw new Error("no se usa");
      },
      getLastModeration: async () => {
        throw new AppError("ML_ABORTED", "cortada", { retriable: true });
      },
    });
    await expect(aborted.operations.getStatus(REF, aborted.ctx)).rejects.toMatchObject({
      code: "ML_ABORTED",
    });
  });

  it("si al leer el motivo el refresco del token es rechazado (invalid_grant), sube: no se esconde", async () => {
    useItem(itemBody("paused", { tags: [MERCADOLIBRE_MODERATION_TAG] }));
    useModeration(unauthorized);
    const ctx: PlatformContext = {
      account: ACCOUNT,
      accessToken: async (opts = {}) => {
        if (opts.rejectedToken !== undefined) {
          throw new AppError("ML_AUTH_INVALID", "refresco rechazado", {
            details: { error: "invalid_grant" },
          });
        }
        return "APP_USR-token-1";
      },
    };
    const { operations } = client();

    await expect(operations.getStatus(REF, ctx)).rejects.toMatchObject({
      code: "ML_AUTH_INVALID",
      details: { error: "invalid_grant" },
    });
  });

  it("un 401 al leer el ítem refresca una vez con el token rechazado", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/items/${ITEM_ID}`, () => {
        calls += 1;
        return calls === 1 ? unauthorized() : HttpResponse.json(itemBody("active"));
      }),
    );
    const { operations, ctx, tokenCalls } = client();

    expect(await operations.getStatus(REF, ctx)).toMatchObject({ status: "active" });
    expect(tokenCalls).toEqual([{}, { rejectedToken: "APP_USR-token-1" }]);
  });
});
