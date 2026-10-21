import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createLinkedInAuth } from "./auth.js";

// F9-T15: el OAuth del perfil personal de LinkedIn contra LinkedIn simulado (msw).

const NOW = new Date("2026-10-20T12:00:00Z");
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO = "https://api.linkedin.com/v2/userinfo";
const SECRET = "secreto-de-la-app-linkedin";
const CODE = "AQT-codigo-de-autorizacion";
const ACCESS = "AQV-token-de-acceso-linkedin";
const REDIRECT = "https://agentsales.test/api/oauth/linkedin/callback";

const { server, recorded } = usePlatformServer();

const auth = createLinkedInAuth({
  clientId: "cliente-123",
  clientSecret: SECRET,
  redirectUri: REDIRECT,
  now: () => NOW,
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("se esperaba un error");
}

describe("createLinkedInAuth", () => {
  it("la URL de autorización: code, cliente, retorno, los tres permisos y el state", () => {
    const url = new URL(auth.authorizeUrl("state-firmado"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cliente-123",
      redirect_uri: REDIRECT,
      scope: "openid profile w_member_social",
      state: "state-firmado",
    });
  });

  it("canjea el código como formulario y devuelve el token, su vencimiento y los permisos", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: ACCESS,
          expires_in: 5_184_000,
          scope: "openid,profile,w_member_social",
        }),
      ),
    );
    const token = await auth.exchangeCode(` ${CODE} `);
    expect(token).toEqual({
      accessToken: ACCESS,
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
      scopes: ["openid", "profile", "w_member_social"],
    });
    const [request] = await recorded();
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      client_id: "cliente-123",
      client_secret: SECRET,
      redirect_uri: REDIRECT,
    });
  });

  it("sin expires_in ni scope: 60 días y permisos desconocidos (null)", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: ACCESS })));
    await expect(auth.exchangeCode(CODE)).resolves.toMatchObject({
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
      scopes: null,
    });
  });

  it("un código vencido o usado es LINKEDIN_AUTH_INVALID; un par malo, LINKEDIN_APP_CREDENTIALS_INVALID; sin secretos", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "invalid_request", error_description: `code ${CODE} expired` },
          { status: 400 },
        ),
      ),
    );
    const expired = await caught(auth.exchangeCode(CODE));
    expect(expired).toMatchObject({
      code: "LINKEDIN_AUTH_INVALID",
      details: { httpStatus: 400, oauthError: "invalid_request" },
    });
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })),
    );
    const client = await caught(auth.exchangeCode(CODE));
    expect(client).toMatchObject({ code: "LINKEDIN_APP_CREDENTIALS_INVALID" });
    for (const error of [expired, client]) {
      expect(errorText(error)).not.toContain(CODE);
      expect(errorText(error)).not.toContain(SECRET);
    }
  });

  it("un canje sin el token es LINKEDIN_UNEXPECTED_RESPONSE; un 503, LINKEDIN_UNAVAILABLE", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ expires_in: 10 })));
    expect(await caught(auth.exchangeCode(CODE))).toMatchObject({
      code: "LINKEDIN_UNEXPECTED_RESPONSE",
    });
    server.use(http.post(TOKEN_URL, () => new HttpResponse(null, { status: 503 })));
    expect(await caught(auth.exchangeCode(CODE))).toMatchObject({
      code: "LINKEDIN_UNAVAILABLE",
      retriable: true,
    });
  });

  it("me: /v2/userinfo con Bearer, el sub como miembro y el nombre", async () => {
    server.use(
      http.get(USERINFO, () =>
        HttpResponse.json({ sub: "abc-DEF_123", given_name: "Vicente", family_name: "Wolde" }),
      ),
    );
    await expect(auth.me(ACCESS)).resolves.toEqual({
      memberId: "abc-DEF_123",
      name: "Vicente Wolde",
    });
    const [request] = await recorded();
    expect(request?.authorization).toBe(`Bearer ${ACCESS}`);
  });

  it("me con un token rechazado (401): LINKEDIN_AUTH_INVALID sin el token", async () => {
    server.use(http.get(USERINFO, () => new HttpResponse(null, { status: 401 })));
    const error = await caught(auth.me(ACCESS));
    expect(error).toMatchObject({ code: "LINKEDIN_AUTH_INVALID" });
    expect(errorText(error)).not.toContain(ACCESS);
  });
});
