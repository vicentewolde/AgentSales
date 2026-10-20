import { ensureRotatingAccessToken } from "@agentsales/core";
import { createInMemoryPlatformAccountRepository } from "@agentsales/core/testing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createTikTokAuth } from "./auth.js";

// F9-T26: el OAuth de TikTok (Login Kit) con msw: la URL de autorización, el canje, la renovación
// que rota y la cuenta. Nada sale a TikTok.

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_URL = "https://open.tiktokapis.com/v2/user/info/";
const NOW = new Date("2026-10-20T12:00:00Z");
const SECRET = "secreto-de-la-app-tiktok";

const { server, recorded } = usePlatformServer();

const auth = () =>
  createTikTokAuth({
    clientKey: "clave-de-la-app",
    clientSecret: SECRET,
    redirectUri: "https://agentsales.agentpey.com/api/oauth/tiktok/callback",
    now: () => NOW,
  });

const tokenBody = (n: number) => ({
  access_token: `act.acceso-${n}`,
  refresh_token: `rft.refresco-${n}`,
  open_id: "open-id-1",
  expires_in: 86400,
  refresh_expires_in: 31536000,
  scope: "user.info.basic,video.upload",
  token_type: "Bearer",
});

describe("createTikTokAuth", () => {
  it("authorizeUrl: client_key, code, los permisos con coma, el retorno y el state", () => {
    const url = new URL(auth().authorizeUrl("state-firmado"));

    expect(`${url.origin}${url.pathname}`).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_key: "clave-de-la-app",
      response_type: "code",
      scope: "user.info.basic,video.upload",
      redirect_uri: "https://agentsales.agentpey.com/api/oauth/tiktok/callback",
      state: "state-firmado",
    });
    expect(url.href).not.toContain(SECRET);
  });

  it("exchangeCode: el canje va en el cuerpo (nunca en la URL) y devuelve el par y los vencimientos", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json(tokenBody(1))));

    const exchanged = await auth().exchangeCode(" codigo-1 ");

    expect(exchanged).toEqual({
      accessToken: "act.acceso-1",
      refreshToken: "rft.refresco-1",
      openId: "open-id-1",
      scopes: ["user.info.basic", "video.upload"],
      accessTokenExpiresAt: new Date(NOW.getTime() + 86400 * 1000),
      refreshTokenExpiresAt: new Date(NOW.getTime() + 31536000 * 1000),
    });
    const [request] = await recorded();
    expect(request?.url.search).toBe("");
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      client_key: "clave-de-la-app",
      client_secret: SECRET,
      code: "codigo-1",
      grant_type: "authorization_code",
      redirect_uri: "https://agentsales.agentpey.com/api/oauth/tiktok/callback",
    });
  });

  it("un código vencido (invalid_grant) es TIKTOK_AUTH_INVALID, sin el código ni el secret", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code is expired.",
            log_id: "l1",
          },
          { status: 400 },
        ),
      ),
    );

    const error = await auth()
      .exchangeCode("codigo-vencido")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TIKTOK_AUTH_INVALID",
      details: { oauthError: "invalid_grant", logId: "l1" },
    });
    expect(errorText(error)).not.toMatch(/codigo-vencido|secreto|expired/);
  });

  it("refresh: entrega el par que rotó (refresh token nuevo) con su vencimiento", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json(tokenBody(2))));

    const refreshed = await auth().refresh("rft.refresco-1");

    expect(refreshed).toEqual({
      accessToken: "act.acceso-2",
      refreshToken: "rft.refresco-2",
      accessTokenExpiresAt: new Date(NOW.getTime() + 86400 * 1000),
      refreshTokenExpiresAt: new Date(NOW.getTime() + 31536000 * 1000),
    });
    const [request] = await recorded();
    expect(Object.fromEntries(request?.form ?? [])).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rft.refresco-1",
    });
  });

  it("solo invalid_grant cuenta como rechazo; la red, un 5xx o el par de la app no", async () => {
    const tiktok = auth();
    const cases: Array<[Response, boolean]> = [
      [HttpResponse.json({ error: "invalid_grant" }, { status: 400 }), true],
      [HttpResponse.json({ error: "invalid_client" }, { status: 401 }), false],
      [HttpResponse.json({ error: "server_error" }, { status: 500 }), false],
      [new HttpResponse("caído", { status: 503 }), false],
      [HttpResponse.error() as Response, false],
    ];
    for (const [response, rejected] of cases) {
      server.use(http.post(TOKEN_URL, () => response.clone()));
      const error = await tiktok.refresh("rft.x").catch((caught: unknown) => caught);
      expect(tiktok.isRejected(error)).toBe(rejected);
      expect(errorText(error)).not.toContain("rft.x");
    }
  });

  it("una renovación sin el par es TIKTOK_UNEXPECTED_RESPONSE", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "act.solo" })));

    await expect(auth().refresh("rft.x")).rejects.toMatchObject({
      code: "TIKTOK_UNEXPECTED_RESPONSE",
    });
  });

  it("user: open_id y nombre a la vista, con Bearer", async () => {
    server.use(
      http.get(USER_URL, () =>
        HttpResponse.json({
          data: { user: { open_id: "open-id-1", display_name: "AgentPey" } },
          error: { code: "ok", message: "", log_id: "l2" },
        }),
      ),
    );

    await expect(auth().user("act.acceso-1")).resolves.toEqual({
      openId: "open-id-1",
      displayName: "AgentPey",
    });
    const [request] = await recorded();
    expect(request?.authorization).toBe("Bearer act.acceso-1");
    expect(request?.url.searchParams.get("fields")).toBe("open_id,display_name");
  });
});

describe("el refresh que rota con ensureRotatingAccessToken (ADR-0029 punto 11)", () => {
  it("renueva con TikTok, guarda el par nuevo y el siguiente refresco usa el refresh token rotado", async () => {
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls += 1;
        return HttpResponse.json(tokenBody(calls + 1));
      }),
    );
    const platformAccounts = createInMemoryPlatformAccountRepository();
    const account = await platformAccounts.upsertConnected({
      brokerId: "marca",
      platform: "tiktok",
      externalAccountId: "open-id-1",
      displayName: "AgentPey",
      tokenExpiresAt: null,
      meta: { openId: "open-id-1", accessTokenExpiresAt: NOW.toISOString() },
      credentials: { accessToken: "act.acceso-1", refreshToken: "rft.refresco-1" },
    });
    let now = NOW;
    const deps = { platformAccounts, refreshers: { tiktok: auth() }, now: () => now };

    await expect(ensureRotatingAccessToken(deps, account.id)).resolves.toBe("act.acceso-2");
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.acceso-2",
      refreshToken: "rft.refresco-2",
    });

    // Un día después, el access token venció: se renueva con el refresh token que rotó.
    now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await ensureRotatingAccessToken(deps, account.id);
    const forms = (await recorded()).map((request) => request.form?.get("refresh_token"));
    expect(forms).toEqual(["rft.refresco-1", "rft.refresco-2"]);
  });

  it("un refresh token rechazado deja la cuenta vencida (TOKEN_REFRESH_REJECTED)", async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })),
    );
    const platformAccounts = createInMemoryPlatformAccountRepository();
    const account = await platformAccounts.upsertConnected({
      brokerId: "marca",
      platform: "tiktok",
      externalAccountId: "open-id-1",
      displayName: "AgentPey",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "act.viejo", refreshToken: "rft.viejo" },
    });

    await expect(
      ensureRotatingAccessToken(
        { platformAccounts, refreshers: { tiktok: auth() }, now: () => NOW },
        account.id,
      ),
    ).rejects.toMatchObject({ code: "TOKEN_REFRESH_REJECTED" });
    expect((await platformAccounts.get(account.id))?.status).toBe("expired");
  });
});
