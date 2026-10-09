import {
  AppError,
  type EnsureAccessTokenOptions,
  MERCADOLIBRE_REJECTED_AFTER_REFRESH,
  type PlatformAccount,
  type PortalAttribute,
  type PortalCategory,
  type PortalLocationMatch,
  type PortalProgress,
  type PublishContext,
  type PublishInput,
  type PublishMediaItem,
} from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import type { PortalCatalog } from "./catalog.js";
import { createMercadoLibreItems } from "./items.js";
import { createMercadoLibrePictures } from "./pictures.js";
import { createPortalPublisher, validatePortalInput } from "./publisher.js";

const API = "https://api.mercadolibre.com";
const NOW = new Date("2026-10-08T12:00:00Z");
const USER_ID = "8035443";
const PUBLICATION_ID = "0b7c6c1e-2f1a-4f7e-9a0b-3c2d1e0f9a8b";
const SIGNED = "https://r2.example/p001/foto.jpg?X-Amz-Signature=firma-secreta";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const { server, recorded } = usePlatformServer();

// ---------------------------------------------------------------------------------------------
// Mercado Libre simulado, con estado: fotos subidas, ítems creados y sus descripciones.
// ---------------------------------------------------------------------------------------------

type Item = {
  id: string;
  seller_custom_field: string;
  status: string;
  sub_status: string[];
  permalink: string;
  pictures: string[];
  description: string | null;
};

type Faults = {
  /** Lo que responde la subida número N (desde 1), en vez de un id. */
  upload?: Record<number, () => Response>;
  /** Lo que responde el pedido de creación número N; `createdThenLost` crea y responde 503. */
  create?: Record<number, "createdThenLost" | (() => Response)>;
  /** Estados que la búsqueda **sin** `status` no trae (si los trae no está verificado). */
  hiddenWithoutStatus?: string[];
  /** La búsqueda no encuentra nada (el índice tarda). */
  searchEmpty?: boolean;
  /** La búsqueda falla con este status. */
  searchStatus?: number;
  /** La búsqueda devuelve estos ids, sin filtrar (por ejemplo, el de otra publicación). */
  searchResults?: string[];
  /** Lo que responde la carga de la descripción número N. */
  addDescription?: Record<number, () => Response>;
  /** Un 401 en la primera llamada a cada recurso que lo pida. */
  unauthorizedOnce?: Array<"upload" | "create" | "description">;
};

function useMercadoLibre(faults: Faults = {}) {
  const items = new Map<string, Item>();
  const uploaded: string[] = [];
  const counts = { upload: 0, create: 0, addDescription: 0 };
  let nextItem = 1;
  const unauthorized = new Set(faults.unauthorizedOnce ?? []);
  const rejectOnce = (kind: "upload" | "create" | "description") => {
    if (!unauthorized.has(kind)) return null;
    unauthorized.delete(kind);
    return HttpResponse.json({ message: "invalid token", error: "unauthorized" }, { status: 401 });
  };
  const itemBody = (item: Item) => ({
    id: item.id,
    status: item.status,
    sub_status: item.sub_status,
    permalink: item.permalink,
    seller_custom_field: item.seller_custom_field,
    start_time: "2026-10-08T12:00:01.000-03:00",
    stop_time: "2027-04-06T12:00:01.000-03:00",
    expiration_time: "2026-11-07T12:00:01.000-03:00",
    tags: [],
  });
  const createItem = (body: Record<string, unknown>) => {
    const id = `MLC${1000000000 + nextItem}`;
    nextItem += 1;
    const item: Item = {
      id,
      seller_custom_field: String(body.seller_custom_field),
      status: "paused",
      sub_status: ["picture_download_pending"],
      permalink: `https://departamento.mercadolibre.cl/${id}-_JM`,
      pictures: (body.pictures as { id: string }[]).map((picture) => picture.id),
      description: null,
    };
    items.set(id, item);
    return item;
  };

  server.use(
    http.post(`${API}/pictures/items/upload`, () => {
      const denied = rejectOnce("upload");
      if (denied) return denied;
      counts.upload += 1;
      const fault = faults.upload?.[counts.upload];
      if (fault) return fault();
      const id = `${counts.upload}-MLC_PIC`;
      uploaded.push(id);
      return HttpResponse.json({ id, variations: [] });
    }),
    http.post(`${API}/items`, async ({ request }) => {
      const denied = rejectOnce("create");
      if (denied) return denied;
      counts.create += 1;
      const body = (await request.json()) as Record<string, unknown>;
      const fault = faults.create?.[counts.create];
      if (fault === "createdThenLost") {
        createItem(body);
        return HttpResponse.json({ message: "boom" }, { status: 503 });
      }
      if (fault) return fault();
      return HttpResponse.json(itemBody(createItem(body)), { status: 201 });
    }),
    http.get(`${API}/items/:id/description`, ({ params }) => {
      const item = items.get(String(params.id));
      if (item?.description === null || item === undefined) {
        return HttpResponse.json({ message: "not found" }, { status: 404 });
      }
      return HttpResponse.json({ plain_text: item.description });
    }),
    http.post(`${API}/items/:id/description`, async ({ params, request }) => {
      const denied = rejectOnce("description");
      if (denied) return denied;
      counts.addDescription += 1;
      const fault = faults.addDescription?.[counts.addDescription];
      const item = items.get(String(params.id));
      if (item === undefined) return HttpResponse.json({ message: "not found" }, { status: 404 });
      if (fault) {
        // Carga la descripción y "pierde" la respuesta (el caso de retomar sin descriptionDone).
        item.description = ((await request.json()) as { plain_text: string }).plain_text;
        return fault();
      }
      if (item.description !== null) {
        return HttpResponse.json(
          {
            message: "ya tiene",
            error: "validation_error",
            cause: [{ code: "item.description.already_exists", type: "error" }],
          },
          { status: 400 },
        );
      }
      item.description = ((await request.json()) as { plain_text: string }).plain_text;
      return HttpResponse.json({ plain_text: item.description });
    }),
    http.get(`${API}/items/:id`, ({ params }) => {
      const item = items.get(String(params.id));
      return item === undefined
        ? HttpResponse.json({ message: "not found" }, { status: 404 })
        : HttpResponse.json(itemBody(item));
    }),
    http.get(`${API}/users/:user/items/search`, ({ request }) => {
      if (faults.searchStatus !== undefined) {
        return HttpResponse.json({ message: "boom" }, { status: faults.searchStatus });
      }
      const url = new URL(request.url);
      const sku = url.searchParams.get("sku");
      const status = url.searchParams.get("status");
      const results = faults.searchResults
        ? faults.searchResults
        : faults.searchEmpty
          ? []
          : [...items.values()]
              .filter((item) => item.seller_custom_field === sku)
              .filter((item) =>
                status === null
                  ? !(faults.hiddenWithoutStatus ?? []).includes(item.status)
                  : item.status === status,
              )
              .map((item) => item.id);
      return HttpResponse.json({ results, paging: { total: results.length } });
    }),
  );
  return { items, uploaded, counts };
}

// ---------------------------------------------------------------------------------------------
// Datos de muestra
// ---------------------------------------------------------------------------------------------

const attr = (id: string, extra: Partial<PortalAttribute> = {}): PortalAttribute => ({
  id,
  name: id,
  valueType: "number",
  required: true,
  conditionalRequired: false,
  tags: ["required"],
  values: [],
  allowedUnits: [],
  defaultUnit: null,
  valueMaxLength: null,
  ...extra,
});
const LEAF: PortalCategory = {
  id: "MLC157522",
  name: "Propiedades usadas",
  childrenCategories: [],
  settings: {
    listingAllowed: true,
    maxTitleLength: 60,
    maxPicturesPerItem: 30,
    maxDescriptionLength: 50000,
    currencies: ["CLP", "USD", "CLF"],
    minimumPrice: null,
    maximumPrice: null,
  },
};
const ATTRIBUTES = [
  attr("TOTAL_AREA", { valueType: "number_unit", allowedUnits: [{ id: "m²", name: "m²" }] }),
  attr("COVERED_AREA", { valueType: "number_unit", allowedUnits: [{ id: "m²", name: "m²" }] }),
  attr("BEDROOMS"),
  attr("FULL_BATHROOMS"),
  attr("PARKING_LOTS"),
  attr("CMG_SITE", { valueType: "string", required: false, tags: ["hidden"] }),
];
const LOCATION: PortalLocationMatch = {
  state: { id: "TUxDUE1FVEExM2JlYg", name: "RM (Metropolitana)" },
  city: { id: "TUxDQ05VTmE", name: "Ñuñoa" },
  neighborhood: null,
};

/** Un catálogo falso (el real se prueba en catalog.test.ts): cuenta sus llamadas. */
function fakeCatalog(fault?: AppError) {
  const calls: string[] = [];
  const catalog: Pick<PortalCatalog, "leafCategory" | "attributes" | "location"> = {
    leafCategory: async (path) => {
      calls.push(`leaf:${path.join(">")}`);
      if (fault) throw fault;
      return LEAF;
    },
    attributes: async () => {
      calls.push("attributes");
      return ATTRIBUTES;
    },
    location: async () => {
      calls.push("location");
      return LOCATION;
    },
  };
  return { catalog, calls };
}

const photo = (index: number): PublishMediaItem => ({
  mediaId: `media-${index}`,
  kind: "image",
  mime: "image/jpeg",
  storagePath: `listings/p001/pi_4x3/${index}.jpg`,
  url: `${SIGNED}&n=${index}`,
  bytes: JPEG.length,
  width: 1440,
  height: 1080,
  durationS: null,
});

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  publicationId: PUBLICATION_ID,
  platform: "portal_inmobiliario",
  format: "post",
  title: "Departamento en venta 2 dormitorios 1 baño en Ñuñoa",
  caption: "Departamento luminoso, a pasos del metro.",
  media: [photo(1), photo(2), photo(3)],
  listing: {
    id: "listing-1",
    externalRef: "P001",
    operation: "sale",
    propertyType: "Departamento",
    region: "Metropolitana",
    comuna: "Ñuñoa",
    address: "Av. Irarrázaval 1234",
    unitNumber: null,
    showExactAddress: false,
    priceAmount: 5800,
    priceCurrency: "UF",
    attributes: {
      dormitorios: 2,
      banos: 1,
      estacionamientos: 1,
      sup_util_m2: 60,
      sup_total_m2: 65,
    },
  },
  brokerContact: { name: "Corredora", email: "c@corredor.test", whatsapp: "+56 9 1234 5678" },
  ...overrides,
});

const ACCOUNT: PlatformAccount = {
  id: "account-1",
  brokerId: "broker-1",
  platform: "portal_inmobiliario",
  externalAccountId: USER_ID,
  displayName: "VICENTEWOLDE",
  status: "connected",
  tokenExpiresAt: null,
  meta: {},
  hasCredentials: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(options: { progress?: PortalProgress | unknown; catalogFault?: AppError } = {}) {
  const tokenCalls: EnsureAccessTokenOptions[] = [];
  const saved: PortalProgress[] = [];
  const read: string[] = [];
  const { catalog, calls: catalogCalls } = fakeCatalog(options.catalogFault);
  const publisher = createPortalPublisher({
    items: createMercadoLibreItems(),
    pictures: createMercadoLibrePictures(),
    catalog,
    readPicture: async (media) => {
      read.push(media.mediaId);
      return JPEG;
    },
    now: () => NOW,
  });
  let current: unknown = options.progress ?? null;
  const ctx = (): PublishContext => ({
    account: ACCOUNT,
    credentials: { accessToken: "APP_USR-guardado" },
    accessToken: async (opts = {}) => {
      tokenCalls.push(opts);
      return `APP_USR-token-${tokenCalls.length}`;
    },
    progress: current,
    saveProgress: async (progress) => {
      saved.push(structuredClone(progress as PortalProgress));
      current = progress;
    },
  });
  return {
    publisher,
    ctx,
    saved,
    read,
    tokenCalls,
    catalogCalls,
    progress: () => current as PortalProgress | null,
  };
}

const writes = async () =>
  (await recorded())
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.url.pathname}`);

// ---------------------------------------------------------------------------------------------

describe("validatePortalInput", () => {
  it("lo que Portal exige antes de llamar, sin suponer el aviso ni el contacto", () => {
    expect(validatePortalInput(input())).toEqual({ ok: true });
    const result = validatePortalInput(
      input({ listing: undefined, brokerContact: undefined, title: "x".repeat(61), media: [] }),
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "PORTAL_INPUT_INCOMPLETE",
          message: "Faltan los datos del aviso o del corredor para Portal",
        },
        { code: "PORTAL_TITLE_TOO_LONG", message: "El título de Portal pasa de 60 caracteres" },
        { code: "PORTAL_PICTURES_MISSING", message: "Mercado Libre exige al menos una foto" },
      ],
    });
    expect(validatePortalInput(input({ title: null })).ok).toBe(false);
    expect(
      validatePortalInput(input({ media: [{ ...photo(1), mime: "image/png" }] })),
    ).toMatchObject({ ok: false, issues: [{ code: "PORTAL_PICTURE_NOT_JPEG" }] });
    expect(
      validatePortalInput(input({ media: Array.from({ length: 31 }, (_, index) => photo(index)) })),
    ).toMatchObject({ ok: false, issues: [{ code: "PORTAL_TOO_MANY_PICTURES" }] });
  });
});

describe("createPortalPublisher · publicar", () => {
  it("sube las fotos, crea el ítem con sus ids, carga la descripción y devuelve el enlace y el estado", async () => {
    const ml = useMercadoLibre();
    const { publisher, ctx, saved, read } = setup();

    const result = await publisher.publish(input(), ctx());

    const [item] = [...ml.items.values()];
    expect(result).toEqual({
      externalId: item?.id,
      externalUrl: item?.permalink,
      simulated: false,
      remote: {
        status: "paused",
        subStatus: ["picture_download_pending"],
        stopTime: "2027-04-06T12:00:01.000-03:00",
        expirationTime: "2026-11-07T12:00:01.000-03:00",
      },
    });
    expect(item?.pictures).toEqual(["1-MLC_PIC", "2-MLC_PIC", "3-MLC_PIC"]);
    expect(item?.description).toBe("Departamento luminoso, a pasos del metro.");
    expect(read).toEqual(["media-1", "media-2", "media-3"]);
    expect(await writes()).toEqual([
      "POST /pictures/items/upload",
      "POST /pictures/items/upload",
      "POST /pictures/items/upload",
      "POST /items",
      "POST /items/" + item?.id + "/description",
    ]);
    // El progreso, foto por foto y antes de crear (con el contacto enviado y la hora del pedido).
    expect(saved.map((progress) => progress.pictureIds.length)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(saved[3]).toEqual({
      pictureIds: ["1-MLC_PIC", "2-MLC_PIC", "3-MLC_PIC"],
      sellerContact: {
        contact: "Corredora",
        email: "c@corredor.test",
        countryCode2: "56",
        phone2: "912345678",
      },
      createRequestedAt: NOW.toISOString(),
    });
    expect(saved.at(-1)).toMatchObject({ itemId: item?.id, descriptionDone: true });
    // El cuerpo de POST /items: las fotos por id (no las URLs firmadas) y sin la descripción.
    const create = (await recorded()).find((request) => request.url.pathname === "/items");
    expect(create?.json).toMatchObject({
      category_id: "MLC157522",
      price: 5800,
      currency_id: "CLF",
      seller_custom_field: PUBLICATION_ID,
      pictures: [{ id: "1-MLC_PIC" }, { id: "2-MLC_PIC" }, { id: "3-MLC_PIC" }],
    });
    expect(create?.rawBody).not.toContain("firma-secreta");
    expect(create?.json).not.toHaveProperty("description");
  });

  it("un aviso que la revisión local rechaza no sube ninguna foto ni llama a Mercado Libre", async () => {
    useMercadoLibre();
    const { publisher, ctx, read } = setup();

    const error = await publisher
      .publish(
        input({ listing: { ...input().listing!, priceCurrency: "CLP", priceAmount: 10.5 } }),
        ctx(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "PUBLISH_INPUT_INVALID", retriable: false });
    expect(await recorded()).toEqual([]);
    expect(read).toEqual([]);
  });

  it("retoma desde la foto que faltaba: un límite por minuto a mitad de camino no repite las subidas", async () => {
    const ml = useMercadoLibre({
      upload: {
        2: () => HttpResponse.json({ message: "Bad_request", error: "" }, { status: 400 }),
      },
    });
    const first = setup();
    await expect(first.publisher.publish(input(), first.ctx())).rejects.toMatchObject({
      code: "ML_RATE_LIMITED",
      retriable: true,
    });
    expect(first.progress()).toEqual({ pictureIds: ["1-MLC_PIC"] });

    const second = setup({ progress: first.progress() });
    await second.publisher.publish(input(), second.ctx());

    expect(second.read).toEqual(["media-2", "media-3"]);
    expect([...ml.items.values()][0]?.pictures).toEqual(["1-MLC_PIC", "3-MLC_PIC", "4-MLC_PIC"]);
  });

  it("con itemId en el progreso no arma ni crea de nuevo: lee la descripción y la carga si falta", async () => {
    const ml = useMercadoLibre();
    const first = setup();
    // El ítem se crea y la descripción falla (Mercado Libre caído).
    server.use(
      http.post(`${API}/items/:id/description`, () => HttpResponse.json({}, { status: 503 }), {
        once: true,
      }),
    );
    await expect(first.publisher.publish(input(), first.ctx())).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
    });
    const progress = first.progress();
    expect(progress?.itemId).toBeDefined();
    expect(progress?.descriptionDone).toBeUndefined();

    // El corredor cambió su WhatsApp y el catálogo no responde: igual se termina.
    const second = setup({
      progress,
      catalogFault: new AppError("ML_UNAVAILABLE", "caído", { retriable: true }),
    });
    const result = await second.publisher.publish(
      input({ brokerContact: { name: "C", email: null, whatsapp: null } }),
      second.ctx(),
    );

    expect(result.externalId).toBe(progress?.itemId);
    expect(second.catalogCalls).toEqual([]);
    expect(ml.counts.create).toBe(1);
    expect([...ml.items.values()][0]?.description).toBe(
      "Departamento luminoso, a pasos del metro.",
    );
  });

  it("la descripción ya cargada y sin descriptionDone (se perdió la respuesta): no la carga dos veces", async () => {
    const ml = useMercadoLibre({
      addDescription: { 1: () => HttpResponse.json({}, { status: 503 }) },
    });
    const first = setup();
    await expect(first.publisher.publish(input(), first.ctx())).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
    });

    const second = setup({ progress: first.progress() });
    await second.publisher.publish(input(), second.ctx());

    expect(ml.counts.addDescription).toBe(1);
    expect(second.progress()).toMatchObject({ descriptionDone: true });
    expect(await writes()).toEqual([
      "POST /pictures/items/upload",
      "POST /pictures/items/upload",
      "POST /pictures/items/upload",
      "POST /items",
      `POST /items/${first.progress()?.itemId}/description`,
    ]);
  });

  it("descriptionDone en el progreso: ni la lee ni la carga, solo lee el ítem", async () => {
    const ml = useMercadoLibre();
    const first = setup();
    await first.publisher.publish(input(), first.ctx());
    const progress = first.progress();
    const before = (await recorded()).length;

    const second = setup({ progress });
    const result = await second.publisher.publish(input(), second.ctx());

    expect(result.externalId).toBe(progress?.itemId);
    expect(
      (await recorded())
        .slice(before)
        .map((request) => `${request.method} ${request.url.pathname}`),
    ).toEqual([`GET /items/${progress?.itemId}`]);
    expect(ml.counts.create).toBe(1);
  });

  it("ante 508 o 509 vuelve a subir las fotos una sola vez y crea de nuevo (no se había creado)", async () => {
    const reject508 = () =>
      HttpResponse.json(
        {
          message: "x",
          error: "validation_error",
          status: 400,
          cause: [{ code: "item.pictures.invalid", cause_id: 508, type: "error" }],
        },
        { status: 400 },
      );
    const ml = useMercadoLibre({ create: { 1: reject508 } });
    const { publisher, ctx, saved } = setup();

    await publisher.publish(input(), ctx());

    expect(ml.counts.upload).toBe(6);
    expect([...ml.items.values()][0]?.pictures).toEqual(["4-MLC_PIC", "5-MLC_PIC", "6-MLC_PIC"]);
    expect(saved).toContainEqual(
      expect.objectContaining({ pictureIds: [], picturesReuploaded: true }),
    );

    // Una segunda vez no se repite: sube el error, sin hora de pedido (no se creó).
    const again = useMercadoLibre({ create: { 1: reject508, 2: reject508 } });
    const second = setup();
    await expect(second.publisher.publish(input(), second.ctx())).rejects.toMatchObject({
      code: "ML_ITEM_REJECTED",
    });
    expect(again.counts.create).toBe(2);
    expect(second.progress()?.createRequestedAt).toBeUndefined();
  });

  it("un rechazo que dice que no se creó deja crear de nuevo en el próximo intento", async () => {
    const ml = useMercadoLibre({
      create: {
        1: () =>
          HttpResponse.json(
            {
              message: "x",
              error: "validation_error",
              status: 400,
              cause: [{ code: "item.price.invalid", cause_id: 109, type: "error" }],
            },
            { status: 400 },
          ),
      },
    });
    const first = setup();
    await expect(first.publisher.publish(input(), first.ctx())).rejects.toMatchObject({
      code: "ML_ITEM_REJECTED",
      retriable: false,
    });
    expect(first.progress()?.createRequestedAt).toBeUndefined();
    expect(first.progress()?.pictureIds).toHaveLength(3);

    const second = setup({ progress: first.progress() });
    await second.publisher.publish(input(), second.ctx());

    expect(ml.counts.create).toBe(2);
    expect(ml.counts.upload).toBe(3);
    expect(ml.items.size).toBe(1);
  });

  it("POST /items sin respuesta (pudo crearse): no lo repite; el próximo intento lo encuentra y sigue", async () => {
    const ml = useMercadoLibre({ create: { 1: "createdThenLost" } });
    const first = setup();
    await expect(first.publisher.publish(input(), first.ctx())).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
    expect(first.progress()).toMatchObject({ createRequestedAt: NOW.toISOString() });
    expect(first.progress()?.itemId).toBeUndefined();

    const second = setup({ progress: first.progress() });
    const result = await second.publisher.publish(input(), second.ctx());

    expect(ml.counts.create).toBe(1);
    expect(ml.items.size).toBe(1);
    expect(result.externalId).toBe([...ml.items.keys()][0]);
    expect(second.catalogCalls).toEqual([]);
    const search = (await recorded()).filter((request) =>
      request.url.pathname.endsWith("/items/search"),
    );
    expect(search.map((request) => Object.fromEntries(request.url.searchParams))).toEqual([
      { sku: PUBLICATION_ID },
    ]);
  });

  it("si la búsqueda sin estado no lo trae, busca entre not_yet_active y paused y junta sin repetir", async () => {
    const ml = useMercadoLibre({
      create: { 1: "createdThenLost" },
      hiddenWithoutStatus: ["paused"],
    });
    const first = setup();
    await first.publisher.publish(input(), first.ctx()).catch(() => undefined);

    const second = setup({ progress: first.progress() });
    const result = await second.publisher.publish(input(), second.ctx());

    expect(result.externalId).toBe([...ml.items.keys()][0]);
    const search = (await recorded()).filter((request) =>
      request.url.pathname.endsWith("/items/search"),
    );
    expect(search.map((request) => request.url.searchParams.get("status"))).toEqual([
      null,
      "not_yet_active",
      "paused",
    ]);
  });

  it("si no lo encuentra, o encuentra más de uno: ML_PUBLISH_OUTCOME_UNKNOWN y nunca repite POST /items", async () => {
    useMercadoLibre({ create: { 1: "createdThenLost" }, searchEmpty: true });
    const first = setup();
    await first.publisher.publish(input(), first.ctx()).catch(() => undefined);
    const second = setup({ progress: first.progress() });
    await expect(second.publisher.publish(input(), second.ctx())).rejects.toMatchObject({
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      retriable: false,
      details: { found: "none" },
    });
    expect((await writes()).filter((call) => call === "POST /items")).toHaveLength(1);

    server.resetHandlers();
    const ml = useMercadoLibre({ create: { 1: "createdThenLost", 2: "createdThenLost" } });
    const a = setup();
    await a.publisher.publish(input(), a.ctx()).catch(() => undefined);
    const b = setup();
    await b.publisher.publish(input(), b.ctx()).catch(() => undefined);
    expect(ml.items.size).toBe(2);
    const c = setup({ progress: a.progress() });
    await expect(c.publisher.publish(input(), c.ctx())).rejects.toMatchObject({
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      details: { found: "many" },
    });
    expect(ml.counts.create).toBe(2);
  });

  it("si el ítem encontrado no es de esta publicación (otro seller_custom_field), no lo toma", async () => {
    const ml = useMercadoLibre({
      create: { 1: "createdThenLost" },
      searchResults: ["MLC9999999999"],
    });
    ml.items.set("MLC9999999999", {
      id: "MLC9999999999",
      seller_custom_field: "otra-publicacion",
      status: "active",
      sub_status: [],
      permalink: "https://departamento.mercadolibre.cl/MLC-9999999999-_JM",
      pictures: [],
      description: null,
    });
    const first = setup();
    await first.publisher.publish(input(), first.ctx()).catch(() => undefined);
    const second = setup({ progress: first.progress() });

    await expect(second.publisher.publish(input(), second.ctx())).rejects.toMatchObject({
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(second.progress()?.itemId).toBeUndefined();
  });

  it("una búsqueda que falla por la red se reintenta más tarde (solo lee): sin crear ni dar por perdido", async () => {
    const ml = useMercadoLibre({ create: { 1: "createdThenLost" }, searchStatus: 503 });
    const first = setup();
    await first.publisher.publish(input(), first.ctx()).catch(() => undefined);
    const second = setup({ progress: first.progress() });

    await expect(second.publisher.publish(input(), second.ctx())).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
    expect(ml.counts.create).toBe(1);
    expect(second.progress()).toMatchObject({ createRequestedAt: NOW.toISOString() });
  });

  it("un progreso ilegible no se adivina: ML_PUBLISH_OUTCOME_UNKNOWN sin llamar", async () => {
    useMercadoLibre();
    const { publisher, ctx } = setup({ progress: { pictureIds: "x" } });
    await expect(publisher.publish(input(), ctx())).rejects.toMatchObject({
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(await recorded()).toEqual([]);
  });

  it("un 401 refresca una vez con el token rechazado y repite solo esa llamada", async () => {
    const ml = useMercadoLibre({ unauthorizedOnce: ["upload", "create", "description"] });
    const { publisher, ctx, tokenCalls } = setup();

    await publisher.publish(input(), ctx());

    expect(ml.items.size).toBe(1);
    expect(ml.counts.create).toBe(1);
    expect(tokenCalls.filter((call) => call.rejectedToken !== undefined)).toHaveLength(3);
    const authorizations = (await recorded()).map((request) => request.authorization);
    expect(authorizations).not.toContain(null);
  });

  it("un rejected_after_refresh del catálogo sube tal cual: no se vuelve a refrescar", async () => {
    useMercadoLibre();
    const rejected = new AppError("ML_AUTH_INVALID", "rechazado otra vez", {
      details: { httpStatus: 401, reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
    });
    const { publisher, ctx, tokenCalls } = setup({ catalogFault: rejected });

    await expect(publisher.publish(input(), ctx())).rejects.toBe(rejected);
    expect(tokenCalls).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  it("ningún error ni progreso lleva el token, la URL firmada ni el WhatsApp", async () => {
    useMercadoLibre({
      create: {
        1: () => HttpResponse.json({ message: `APP_USR-token-1 ${SIGNED}` }, { status: 500 }),
      },
    });
    const { publisher, ctx, saved } = setup();

    const error = await publisher.publish(input(), ctx()).catch((caught: unknown) => caught);

    const text = `${errorText(error)} ${JSON.stringify(saved)}`;
    expect(text).not.toContain("APP_USR-token");
    expect(text).not.toContain("firma-secreta");
    expect(text).not.toContain("+56 9 1234 5678");
  });
});
