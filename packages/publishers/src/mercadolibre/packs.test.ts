import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibrePacks } from "./packs.js";

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const API = "https://api.mercadolibre.com";
const USER_ID = "8035443";

const { server, recorded } = usePlatformServer();
const packs = createMercadoLibrePacks();

describe("createMercadoLibrePacks", () => {
  it("userPacks: solo lee (GET con el token en la cabecera) y normaliza lo que entiende", async () => {
    server.use(
      http.get(`${API}/users/${USER_ID}/classifieds_promotion_packs`, () =>
        HttpResponse.json([
          {
            id: 123,
            description: "Paquete Plata",
            status: "active",
            category_id: "MLC1459",
            remaining_listings: 4,
            listing_details: [
              { listing_type_id: "silver", available_listings: 4, used_listings: "1" },
              "no es un detalle",
            ],
            date_expires: "2026-11-08T00:00:00.000-03:00",
            "campo raro con espacios": true,
          },
        ]),
      ),
    );

    const list = await packs.userPacks(ACCESS, USER_ID);

    expect(list).toEqual({
      container: null,
      fields: [],
      packs: [
        {
          id: "123",
          description: "Paquete Plata",
          status: "active",
          categoryId: "MLC1459",
          remainingListings: 4,
          listings: [{ listingTypeId: "silver", available: 4, used: 1 }],
          dateExpires: "2026-11-08T00:00:00.000-03:00",
          price: null,
          currencyId: null,
          duration: null,
          fields: [
            "id",
            "description",
            "status",
            "category_id",
            "remaining_listings",
            "listing_details",
            "date_expires",
          ],
        },
      ],
    });
    const [request] = await recorded();
    expect(request?.method).toBe("GET");
    expect(request?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      package_content: "publications",
    });
  });

  it("categoryPacks: la lista dentro de un objeto, con su precio y duración (ejemplo de la nota §2)", async () => {
    server.use(
      http.get(`${API}/categories/MLC1459/classifieds_promotion_packs`, () =>
        HttpResponse.json({
          total: 1,
          results: [
            {
              id: "PACK-1",
              description: "10000 Publicaciones Plata",
              price: "345.1",
              currency_id: "CLF",
              duration: 30,
              listing_details: [{ listing_type_id: "silver", remaining_listings: 10000 }],
            },
            { id: { raro: true } },
          ],
        }),
      ),
    );

    const list = await packs.categoryPacks(ACCESS, "MLC1459");

    expect(list.container).toBe("results");
    expect(list.fields).toEqual(["total", "results"]);
    expect(list.packs).toHaveLength(2);
    expect(list.packs[0]).toMatchObject({
      id: "PACK-1",
      price: 345.1,
      currencyId: "CLF",
      duration: 30,
      listings: [{ listingTypeId: "silver", available: 10000, used: null }],
    });
    // Un id que no se entiende queda en `null`, sin descartar el paquete.
    expect(list.packs[1]).toMatchObject({ id: null, fields: ["id"] });
  });

  it("una respuesta sin lista: sin paquetes y con los nombres de sus campos", async () => {
    server.use(
      http.get(`${API}/users/${USER_ID}/classifieds_promotion_packs`, () =>
        HttpResponse.json({ message: "sin paquetes", status: 200 }),
      ),
    );

    await expect(packs.userPacks(ACCESS, USER_ID)).resolves.toEqual({
      packs: [],
      container: null,
      fields: ["message", "status"],
    });
  });

  it("un usuario o una categoría que no son de Mercado Libre no se llaman", async () => {
    await expect(packs.userPacks(ACCESS, "../me")).rejects.toMatchObject({
      code: "ML_ID_INVALID",
      details: { kind: "user" },
    });
    await expect(packs.categoryPacks(ACCESS, "MLA1459")).rejects.toMatchObject({
      code: "ML_ID_INVALID",
      details: { kind: "category" },
    });
    expect(await recorded()).toHaveLength(0);
  });

  it("un 401 es ML_AUTH_INVALID con su status y sin el token", async () => {
    server.use(
      http.get(`${API}/users/${USER_ID}/classifieds_promotion_packs`, () =>
        HttpResponse.json({ message: "invalid token", error: "unauthorized" }, { status: 401 }),
      ),
    );

    const error = await packs.userPacks(ACCESS, USER_ID).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "ML_AUTH_INVALID", details: { httpStatus: 401 } });
    expect(errorText(error)).not.toContain(ACCESS);
  });
});
