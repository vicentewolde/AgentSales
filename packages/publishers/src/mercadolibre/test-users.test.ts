import { isAppError } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreTestUsers } from "./test-users.js";

// F4-T25: crear un usuario de prueba (`POST /users/test_user`) contra un Mercado Libre simulado.

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const API = "https://api.mercadolibre.com";
const PASSWORD = "clave-de-prueba-qwerty";

const { server, recorded } = usePlatformServer();
const testUsers = createMercadoLibreTestUsers();

describe("createMercadoLibreTestUsers", () => {
  it("un solo POST con el token en la cabecera y { site_id: MLC }; devuelve id, apodo y clave", async () => {
    server.use(
      http.post(`${API}/users/test_user`, () =>
        HttpResponse.json(
          { id: 1234567890, nickname: "TESTUSER123", password: PASSWORD, site_status: "active" },
          { status: 201 },
        ),
      ),
    );

    expect(await testUsers.create(ACCESS, "MLC")).toEqual({
      id: "1234567890",
      nickname: "TESTUSER123",
      password: PASSWORD,
      siteStatus: "active",
    });
    const requests = await recorded();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${ACCESS}`,
      json: { site_id: "MLC" },
    });
    expect(requests[0]?.url.search).toBe("");
  });

  it("una respuesta que no calza es ML_UNEXPECTED_RESPONSE sin la clave en el error", async () => {
    server.use(
      http.post(`${API}/users/test_user`, () =>
        HttpResponse.json({ id: "no-es-numero", password: PASSWORD }),
      ),
    );

    const error = await testUsers.create(ACCESS, "MLC").catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("ML_UNEXPECTED_RESPONSE");
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect(String(error)).not.toContain(PASSWORD);
  });

  it("un 401 es ML_AUTH_INVALID (quien llama refresca y repite una vez)", async () => {
    server.use(
      http.post(`${API}/users/test_user`, () =>
        HttpResponse.json({ message: "invalid token", error: "unauthorized" }, { status: 401 }),
      ),
    );

    const error = await testUsers.create(ACCESS, "MLC").catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("ML_AUTH_INVALID");
  });
});
