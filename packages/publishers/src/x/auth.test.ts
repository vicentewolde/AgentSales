import { createHash } from "node:crypto";
import { isAppError } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createPkcePair, createXAuth, pkceChallenge } from "./auth.js";

// F9-T16: el OAuth 2.0 con PKCE de X con msw (nada sale a X). La forma exacta de las respuestas y
// de la autenticación del cliente confidencial es NO VERIFICADO hasta la prueba S4 (`x.md` §3.1).

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const NOW = new Date("2026-10-20T12:00:00Z");
const { server, recorded } = usePlatformServer();

const auth = () =>
  createXAuth({
    clientId: "client-id-x",
    clientSecret: "client-secret-x",
    redirectUri: "http://127.0.0.1:8787/api/oauth/x/callback",
    now: () => NOW,
  });

const tokenResponse = (extra: Record<string, unknown> = {}) =>
  HttpResponse.json({
    token_type: "bearer",
    expires_in: 7200,
    access_token: "access-token-nuevo-123",
    refresh_token: "refresh-token-nuevo-456",
    scope: "tweet.read tweet.write users.read media.write offline.access",
    ...extra,
  });

describe("PKCE", () => {
  it("el desafío es base64url(sha256(verificador)) y el verificador tiene 43 caracteres", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    // El ejemplo del RFC 7636 (apéndice B).
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("createXAuth", () => {
  it("arma la URL de autorización con el state, el desafío S256 y los permisos", () => {
    const url = new URL(auth().authorizeUrl("state-firmado", "desafio"));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-id-x",
      redirect_uri: "http://127.0.0.1:8787/api/oauth/x/callback",
      scope: "tweet.read tweet.write users.read media.write offline.access",
      state: "state-firmado",
      code_challenge: "desafio",
      code_challenge_method: "S256",
    });
  });

  it("canjea el código con el verificador y el par de la app en Basic", async () => {
    server.use(http.post(TOKEN_URL, () => tokenResponse()));
    const result = await auth().exchangeCode("codigo-123", "verificador-456");
    expect(result).toEqual({
      accessToken: "access-token-nuevo-123",
      refreshToken: "refresh-token-nuevo-456",
      accessTokenExpiresAt: new Date("2026-10-20T14:00:00Z"),
      refreshTokenExpiresAt: null,
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    });
    const [request] = await recorded();
    expect(request?.authorization).toBe(
      `Basic ${Buffer.from("client-id-x:client-secret-x").toString("base64")}`,
    );
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "codigo-123",
      redirect_uri: "http://127.0.0.1:8787/api/oauth/x/callback",
      code_verifier: "verificador-456",
      client_id: "client-id-x",
    });
  });

  it("sin refresh token (falta offline.access) no conecta", async () => {
    server.use(http.post(TOKEN_URL, () => tokenResponse({ refresh_token: undefined })));
    const error = await auth()
      .exchangeCode("codigo", "verificador")
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("X_PERMISSION_MISSING");
  });

  it("el refresco que rota devuelve el par nuevo", async () => {
    server.use(http.post(TOKEN_URL, () => tokenResponse()));
    const refreshed = await auth().refresh("refresh-token-viejo");
    expect(refreshed).toEqual({
      accessToken: "access-token-nuevo-123",
      refreshToken: "refresh-token-nuevo-456",
      accessTokenExpiresAt: new Date("2026-10-20T14:00:00Z"),
      refreshTokenExpiresAt: null,
    });
    const [request] = await recorded();
    expect(request?.form?.get("grant_type")).toBe("refresh_token");
    expect(request?.form?.get("refresh_token")).toBe("refresh-token-viejo");
  });

  it("si X no devuelve otro refresh token, se conserva el anterior", async () => {
    server.use(http.post(TOKEN_URL, () => tokenResponse({ refresh_token: undefined })));
    const refreshed = await auth().refresh("refresh-token-viejo");
    expect(refreshed.refreshToken).toBe("refresh-token-viejo");
  });

  it("solo invalid_grant cuenta como rechazo (la cuenta queda vencida)", async () => {
    const client = auth();
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "invalid_grant", error_description: "Value passed for the token was invalid." },
          { status: 400 },
        ),
      ),
    );
    const rejected = await client.refresh("refresh-usado").catch((caught: unknown) => caught);
    expect(isAppError(rejected) && rejected.code).toBe("X_AUTH_INVALID");
    expect(client.isRejected(rejected)).toBe(true);
    expect(errorText(rejected)).not.toContain("refresh-usado");
    expect(errorText(rejected)).not.toContain("client-secret-x");

    server.use(http.post(TOKEN_URL, () => HttpResponse.json({}, { status: 503 })));
    const down = await client.refresh("refresh").catch((caught: unknown) => caught);
    expect(isAppError(down) && down.code).toBe("X_UNAVAILABLE");
    expect(client.isRejected(down)).toBe(false);

    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })),
    );
    const app = await client.refresh("refresh").catch((caught: unknown) => caught);
    expect(isAppError(app) && app.code).toBe("X_APP_CREDENTIALS_INVALID");
    expect(client.isRejected(app)).toBe(false);
  });

  it("el refresco tiene su propio tope de 10 s", async () => {
    const client = createXAuth({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://agentsales.test/api/oauth/x/callback",
      tokenTimeoutMs: 20,
    });
    server.use(
      http.post(TOKEN_URL, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return tokenResponse();
      }),
    );
    const error = await client.refresh("refresh").catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("X_UNAVAILABLE");
    expect(isAppError(error) && error.details).toMatchObject({ reason: "timeout" });
    expect(client.isRejected(error)).toBe(false);
  });

  it("lee el usuario del token", async () => {
    server.use(
      http.get("https://api.x.com/2/users/me", () =>
        HttpResponse.json({ data: { id: "12345", username: "agentpey", name: "AgentPey" } }),
      ),
    );
    expect(await auth().me("access")).toEqual({
      id: "12345",
      username: "agentpey",
      name: "AgentPey",
    });
    const [request] = await recorded();
    expect(request?.authorization).toBe("Bearer access");
  });
});
