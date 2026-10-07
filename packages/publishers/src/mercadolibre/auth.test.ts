import { type AbortSignalLike, redactText } from "@agentsales/core";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreAuth } from "./auth.js";

const APP_ID = "1234567890123456";
const SECRET = "secreto-de-prueba-ml-xyz";
const REDIRECT = "https://localhost/oauth/mercadolibre/callback";
const CODE = "TG-61a7c3f0e4b0a1000a1b2c3d-8035443";
const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const REFRESH = "TG-5b9032b4e23464aed1f959f-8035443";
const NEW_ACCESS = "APP_USR-1234567890123456-100618-aabbccddeeff00112233445566778899-8035443";
const NEW_REFRESH = "TG-6c0143c5f34575bfe2a060a-8035443";
const NOW = new Date("2026-10-06T12:00:00Z");
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const ME_URL = "https://api.mercadolibre.com/users/me";

const { server, requests } = usePlatformServer();
const auth = createMercadoLibreAuth({
  appId: APP_ID,
  clientSecret: SECRET,
  redirectUri: REDIRECT,
  now: () => NOW,
});

const SECRETS = [SECRET, CODE, ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH];
const expectNoSecrets = (error: unknown) => {
  const text = errorText(error);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

/** La respuesta del canje y del refresco (nota §3.1). */
const tokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: NEW_ACCESS,
  token_type: "Bearer",
  expires_in: 21600,
  scope: "offline_access read write",
  user_id: 8035443,
  refresh_token: NEW_REFRESH,
  ...overrides,
});
const oauthError = (error: string, status = 400) =>
  HttpResponse.json(
    {
      error,
      error_description: `Error validating grant. Your refresh token ${REFRESH} or code ${CODE} may be expired`,
      status,
      cause: [],
    },
    { status },
  );

describe("createMercadoLibreAuth", () => {
  it("authorizeUrl: Mercado Libre Chile, el App ID, la URI exacta y el state, sin PKCE ni secret", () => {
    const url = new URL(auth.authorizeUrl("estado-firmado"));

    expect(`${url.origin}${url.pathname}`).toBe("https://auth.mercadolibre.cl/authorization");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: APP_ID,
      redirect_uri: REDIRECT,
      state: "estado-firmado",
    });
    expect(url.toString()).not.toContain(SECRET);
  });

  it("exchangeCode: los parámetros van en el cuerpo (nunca en la URL) y devuelve el par y los permisos", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json(tokenBody())));

    const tokens = await auth.exchangeCode(`  ${CODE}\n`);

    expect(tokens).toEqual({
      accessToken: NEW_ACCESS,
      refreshToken: NEW_REFRESH,
      accessTokenExpiresAt: new Date(NOW.getTime() + 21600 * 1000),
      scopes: ["offline_access", "read", "write"],
      userId: "8035443",
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url.search).toBe("");
    expect(request?.authorization).toBeNull();
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      client_id: APP_ID,
      client_secret: SECRET,
      code: CODE,
      redirect_uri: REDIRECT,
    });
  });

  it("exchangeCode lee expires_in (no fija 6 h) y acepta user_id como texto", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(tokenBody({ expires_in: "10800", user_id: "8035443" })),
      ),
    );

    const tokens = await auth.exchangeCode(CODE);

    expect(tokens.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 10800 * 1000));
    expect(tokens.userId).toBe("8035443");
  });

  it("exchangeCode sin offline_access: refreshToken null, para que conectar lo explique con los permisos", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(tokenBody({ scope: "read write", refresh_token: undefined })),
      ),
    );

    const tokens = await auth.exchangeCode(CODE);

    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toEqual(["read", "write"]);
  });

  it("exchangeCode con invalid_grant: ML_AUTH_INVALID que pide conectar de nuevo, sin el código ni el secret", async () => {
    server.use(http.post(TOKEN_URL, () => oauthError("invalid_grant")));

    const error = await auth.exchangeCode(CODE).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ML_AUTH_INVALID",
      retriable: false,
      details: { httpStatus: 400, error: "invalid_grant" },
    });
    expect((error as Error).message).toContain("conecta de nuevo");
    expectNoSecrets(error);
  });

  it("refresh: manda el refresh en el cuerpo y devuelve el par nuevo (el refresh rota)", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json(tokenBody())));

    const tokens = await auth.refresh(REFRESH);

    expect(tokens).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH });
    expect(tokens.refreshToken).not.toBe(REFRESH);
    const [request] = requests;
    expect(request?.url.search).toBe("");
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: "refresh_token",
      client_id: APP_ID,
      client_secret: SECRET,
      refresh_token: REFRESH,
    });
  });

  it("refresh sin refresh_token nuevo es ML_UNEXPECTED_RESPONSE, sin el token", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json(tokenBody({ refresh_token: null }))));

    const error = await auth.refresh(REFRESH).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "ML_UNEXPECTED_RESPONSE", details: { call: "refresh" } });
    expectNoSecrets(error);
  });

  it("refresh con invalid_grant (vencido, usado o revocado) es ML_AUTH_INVALID y no lleva el refresh", async () => {
    server.use(http.post(TOKEN_URL, () => oauthError("invalid_grant")));

    const error = await auth.refresh(REFRESH).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "ML_AUTH_INVALID", retriable: false });
    expect((error as Error).message).toContain("reconecta la cuenta");
    expectNoSecrets(error);
  });

  it.each([
    ["invalid_client", 401],
    ["unauthorized_client", 400],
  ])(
    "refresh con %s es ML_APP_CREDENTIALS_INVALID (revisar .env), no un token vencido",
    async (code, status) => {
      server.use(http.post(TOKEN_URL, () => oauthError(code, status)));

      const error = await auth.refresh(REFRESH).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "ML_APP_CREDENTIALS_INVALID", retriable: false });
      expectNoSecrets(error);
    },
  );

  it("refresh con un token que no cabe en un formulario no llama", async () => {
    await expect(auth.refresh(`${REFRESH}\nX`)).rejects.toMatchObject({
      code: "ML_AUTH_INVALID",
      details: { reason: "token_malformed" },
    });
    expect(requests).toHaveLength(0);
  });

  it("un token de la respuesta con espacios es ML_UNEXPECTED_RESPONSE (no se guardaría bien)", async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json(tokenBody({ access_token: "APP_USR-a b" }))),
    );

    await expect(auth.exchangeCode(CODE)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
    });
  });

  it("me: la cabecera Bearer, sin el token en la URL, y los datos de la cuenta", async () => {
    server.use(
      http.get(ME_URL, () =>
        HttpResponse.json({
          id: 8035443,
          nickname: "CORREDOR_PRUEBA",
          site_id: "MLC",
          user_type: "normal",
          tags: ["normal", "test_user"],
          email: "no-se-guarda@example.com",
        }),
      ),
    );

    const user = await auth.me(ACCESS);

    expect(user).toEqual({
      userId: "8035443",
      nickname: "CORREDOR_PRUEBA",
      siteId: "MLC",
      userType: "normal",
      tags: ["normal", "test_user"],
    });
    expect(requests[0]?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(requests[0]?.url.toString()).toBe(ME_URL);
  });

  it("me sin user_type ni tags (o con tags raros) los deja vacíos", async () => {
    server.use(
      http.get(ME_URL, () =>
        HttpResponse.json({ id: "8035443", nickname: "C", site_id: "MLC", tags: "x" }),
      ),
    );

    await expect(auth.me(ACCESS)).resolves.toMatchObject({ userType: null, tags: [] });
  });

  it("forma inesperada: me sin id, un id mayor que 2^53, un 2xx que no es JSON o vacío", async () => {
    const replies = [
      () => HttpResponse.json({ nickname: "C", site_id: "MLC" }),
      () => HttpResponse.text('{"id": 9007199254740993, "nickname": "C", "site_id": "MLC"}'),
      () => HttpResponse.text("<html>hola</html>"),
      () => new HttpResponse(null, { status: 204 }),
    ];
    for (const reply of replies) {
      server.use(http.get(ME_URL, reply));
      await expect(auth.me(ACCESS)).rejects.toMatchObject({
        code: "ML_UNEXPECTED_RESPONSE",
        retriable: false,
        details: { call: "me" },
      });
    }
  });

  it.each([
    [
      401,
      { message: "invalid access token", error: "unauthorized", status: 401 },
      "ML_AUTH_INVALID",
      false,
    ],
    [403, { message: "forbidden", error: "forbidden", status: 403 }, "ML_PERMISSION_DENIED", false],
    [
      429,
      { message: "too many requests", error: "local_rate_limited", status: 429 },
      "ML_RATE_LIMITED",
      true,
    ],
    [500, { message: "boom", error: "internal_error", status: 500 }, "ML_UNAVAILABLE", true],
    [502, "<html>bad gateway</html>", "ML_UNAVAILABLE", true],
  ] as const)("me con %i es %s", async (status, body, code, retriable) => {
    server.use(
      http.get(ME_URL, () =>
        typeof body === "string"
          ? HttpResponse.text(body, { status })
          : HttpResponse.json(body, { status }),
      ),
    );

    const error = await auth.me(ACCESS).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, retriable, details: { httpStatus: status } });
    expectNoSecrets(error);
  });

  it("sin conexión es ML_UNAVAILABLE (network), sin la URL ni el secret", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.error()));

    const error = await auth.refresh(REFRESH).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
      details: { reason: "network" },
    });
    expect(errorText(error)).not.toContain("api.mercadolibre.com");
    expectNoSecrets(error);
  });

  it("pasado el tope de tiempo es ML_UNAVAILABLE (timeout); la API pasa uno corto", async () => {
    const slow = createMercadoLibreAuth({
      appId: APP_ID,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      timeoutMs: 30,
    });
    server.use(
      http.get(ME_URL, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );

    await expect(slow.me(ACCESS)).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
      details: { reason: "timeout" },
    });
  });

  it("la señal corta la llamada en curso (ML_ABORTED) y una ya disparada no llama", async () => {
    server.use(
      http.post(TOKEN_URL, async () => {
        await delay("infinite");
        return HttpResponse.json(tokenBody());
      }),
    );
    const controller = new AbortController();
    const pending = auth.refresh(REFRESH, { signal: controller.signal });
    await delay(10);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "ML_ABORTED", retriable: true });
    const before = requests.length;
    await expect(auth.me(ACCESS, { signal: controller.signal })).rejects.toMatchObject({
      code: "ML_ABORTED",
    });
    expect(requests).toHaveLength(before);
  });

  it("la señal no deja listeners colgando tras éxito, error, sin red y tope", async () => {
    const slow = createMercadoLibreAuth({
      appId: APP_ID,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      timeoutMs: 30,
    });
    const replies = [
      () => HttpResponse.json({ id: 1, nickname: "C", site_id: "MLC" }),
      () => HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      () => HttpResponse.error(),
      async () => {
        await delay("infinite");
        return HttpResponse.json({});
      },
    ];
    for (const reply of replies) {
      server.use(http.get(ME_URL, reply));
      const controller = new AbortController();
      let active = 0;
      const signal: AbortSignalLike = {
        get aborted() {
          return controller.signal.aborted;
        },
        addEventListener(type, listener, options) {
          active += 1;
          controller.signal.addEventListener(type, listener, options);
        },
        removeEventListener(type, listener) {
          active -= 1;
          controller.signal.removeEventListener(type, listener);
        },
      };
      await slow.me(ACCESS, { signal }).catch(() => undefined);
      expect(active).toBe(0);
    }
  });

  it("los tokens de Mercado Libre que pudieran llegar a un log quedan ocultos por el redactor", () => {
    const line = `POST /oauth/token code=${CODE}&refresh_token=${REFRESH} → ${JSON.stringify(tokenBody())}`;

    for (const secret of [CODE, REFRESH, NEW_ACCESS, NEW_REFRESH]) {
      expect(redactText(line)).not.toContain(secret);
    }
  });
});
