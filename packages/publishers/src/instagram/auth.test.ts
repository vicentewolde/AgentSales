import { redactText } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, useInstagramServer } from "../../test/instagram-server.js";
import { cleanAuthorizationCode, createInstagramAuth } from "./auth.js";

const APP_ID = "990011223344";
const SECRET = "app-secret-de-prueba-abc";
const REDIRECT = "https://agentsales.test/oauth/instagram/callback";
const CODE = "AQB-codigo-de-prueba";
const SHORT = "IGQ-token-corto-123";
const LONG = "IGAA-token-largo-456";
const NEW_LONG = "IGAA-token-nuevo-789";
const NOW = new Date("2026-10-05T12:00:00Z");

const { server, requests } = useInstagramServer();
const auth = createInstagramAuth({
  appId: APP_ID,
  appSecret: SECRET,
  redirectUri: REDIRECT,
  now: () => NOW,
});

const SECRETS = [SECRET, CODE, SHORT, LONG, NEW_LONG];
const expectNoSecrets = (error: unknown) => {
  for (const secret of SECRETS) expect(errorText(error)).not.toContain(secret);
};

/** Canje del código (`api.instagram.com`) y del token largo (`graph.instagram.com`). */
const exchangeHandlers = (shortBody: Record<string, unknown>) => [
  http.post("https://api.instagram.com/oauth/access_token", () => HttpResponse.json(shortBody)),
  http.get("https://graph.instagram.com/access_token", () =>
    HttpResponse.json({ access_token: LONG, token_type: "bearer", expires_in: 5183944 }),
  ),
];

describe("createInstagramAuth", () => {
  it("authorizeUrl: el ID de Instagram, la URI, los dos permisos y el state", () => {
    const url = new URL(auth.authorizeUrl("estado-firmado"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish",
      state: "estado-firmado",
    });
    expect(url.toString()).not.toContain(SECRET);
  });

  it("exchangeCode quita el #_, canjea el corto por el largo y devuelve los permisos", async () => {
    server.use(
      ...exchangeHandlers({
        data: [
          {
            access_token: SHORT,
            user_id: "1789",
            permissions: "instagram_business_basic,instagram_business_content_publish",
          },
        ],
      }),
    );
    await expect(auth.exchangeCode(`${CODE}#_`)).resolves.toEqual({
      accessToken: LONG,
      expiresAt: new Date(NOW.getTime() + 5183944 * 1000),
      permissions: ["instagram_business_basic", "instagram_business_content_publish"],
    });
    const [codeExchange, longExchange] = requests;
    expect(Object.fromEntries(codeExchange?.form ?? [])).toEqual({
      client_id: APP_ID,
      client_secret: SECRET,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code: CODE,
    });
    expect(longExchange?.url.pathname).toBe("/access_token");
    expect(Object.fromEntries(longExchange?.url.searchParams ?? [])).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: SECRET,
      access_token: SHORT,
    });
  });

  it("exchangeCode acepta la respuesta sin envoltura y los permisos como lista", async () => {
    server.use(
      ...exchangeHandlers({
        access_token: SHORT,
        user_id: 1789,
        permissions: ["instagram_business_basic"],
      }),
    );
    await expect(auth.exchangeCode(CODE)).resolves.toMatchObject({
      accessToken: LONG,
      permissions: ["instagram_business_basic"],
    });
  });

  it("un código vencido o usado es IG_AUTH_INVALID, sin el código ni el secret", async () => {
    server.use(
      http.post("https://api.instagram.com/oauth/access_token", () =>
        HttpResponse.json(
          {
            error_type: "OAuthException",
            code: 400,
            error_message: `Invalid authorization code ${CODE} for ${SECRET}`,
          },
          { status: 400 },
        ),
      ),
    );
    const error = await auth.exchangeCode(CODE).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "IG_AUTH_INVALID", retriable: false });
    expectNoSecrets(error);
  });

  it("sin red o con la señal cortada en el primer paso, el error no lleva el código ni el secret", async () => {
    server.use(
      http.post("https://api.instagram.com/oauth/access_token", () => HttpResponse.error()),
    );
    const offline = await auth.exchangeCode(CODE).catch((caught: unknown) => caught);
    expect(offline).toMatchObject({ code: "IG_UNAVAILABLE", retriable: true });
    expectNoSecrets(offline);

    const controller = new AbortController();
    controller.abort();
    const aborted = await auth
      .exchangeCode(CODE, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(aborted).toMatchObject({ code: "IG_ABORTED", retriable: true });
    expectNoSecrets(aborted);
  });

  it("si falla el canje por el largo, el error no lleva el token corto ni el secret", async () => {
    server.use(
      http.post("https://api.instagram.com/oauth/access_token", () =>
        HttpResponse.json({ access_token: SHORT, permissions: "" }),
      ),
      http.get("https://graph.instagram.com/access_token", ({ request }) =>
        HttpResponse.json(
          { error: { code: 190, message: `Bad token in ${request.url}` } },
          { status: 400 },
        ),
      ),
    );
    const error = await auth.exchangeCode(CODE).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "IG_AUTH_INVALID" });
    expectNoSecrets(error);
  });

  it("refresh pide un token nuevo con el vigente y calcula su vencimiento", async () => {
    server.use(
      http.get("https://graph.instagram.com/refresh_access_token", () =>
        HttpResponse.json({
          data: [{ access_token: NEW_LONG, token_type: "bearer", expires_in: 5184000 }],
        }),
      ),
    );
    await expect(auth.refresh(LONG)).resolves.toEqual({
      accessToken: NEW_LONG,
      expiresAt: new Date(NOW.getTime() + 5184000 * 1000),
    });
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      grant_type: "ig_refresh_token",
      access_token: LONG,
    });
  });

  it("refresh con un token vencido es IG_AUTH_INVALID; sin red, IG_UNAVAILABLE; nunca con el token", async () => {
    server.use(
      http.get("https://graph.instagram.com/refresh_access_token", () =>
        HttpResponse.json({ error: { code: 190, error_subcode: 463 } }, { status: 400 }),
      ),
    );
    const expired = await auth.refresh(LONG).catch((caught: unknown) => caught);
    expect(expired).toMatchObject({ code: "IG_AUTH_INVALID" });
    expectNoSecrets(expired);

    server.use(
      http.get("https://graph.instagram.com/refresh_access_token", () => HttpResponse.error()),
    );
    const offline = await auth.refresh(LONG).catch((caught: unknown) => caught);
    expect(offline).toMatchObject({ code: "IG_UNAVAILABLE", retriable: true });
    expectNoSecrets(offline);
  });

  it("me usa la cabecera Bearer", async () => {
    server.use(
      http.get("https://graph.instagram.com/v25.0/me", () =>
        HttpResponse.json({ user_id: "1789", username: "corredora", account_type: "BUSINESS" }),
      ),
    );
    await expect(auth.me(LONG)).resolves.toEqual({
      userId: "1789",
      username: "corredora",
      accountType: "BUSINESS",
    });
    expect(requests[0]?.authorization).toBe(`Bearer ${LONG}`);
    expect(requests[0]?.url.toString()).not.toContain(LONG);
  });

  it("si alguien registrara las URLs o el formulario del canje, el redactor oculta los secretos", async () => {
    server.use(...exchangeHandlers({ access_token: SHORT, permissions: "" }));
    await auth.exchangeCode(CODE);
    const logged = requests
      .map((request) => `${request.url} ${request.form?.toString() ?? ""}`)
      .map(redactText)
      .join("\n");
    for (const secret of [SECRET, CODE, SHORT]) expect(logged).not.toContain(secret);
  });
});

describe("cleanAuthorizationCode", () => {
  it("quita el #_ final y los espacios, y deja el resto igual", () => {
    expect(cleanAuthorizationCode("abc#_")).toBe("abc");
    expect(cleanAuthorizationCode("  abc#_\n")).toBe("abc");
    expect(cleanAuthorizationCode("abc")).toBe("abc");
  });
});
