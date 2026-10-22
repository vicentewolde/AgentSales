import { type AccessTokenProvider, isAppError, type PlatformAccount } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createXApi } from "./api.js";
import { createXOperations, deleteXPost } from "./publisher.js";

// F9.5-T09: retirar borrando en X (`DELETE /2/tweets/:id`, `x.md` §4.3) con msw. Ninguna petición
// sale a X: una sin handler falla el test (`usePlatformServer`). El cuerpo de la respuesta es el de
// la doc (`{"data":{"deleted":true}}`); el costo de borrar no está verificado y no se anota.

const API = "https://api.x.com";
const TOKEN = "tokenDeAccesoDeX-1234567890";
const NEW_TOKEN = "tokenNuevoDeX-0987654321";
const POST_ID = "1850000000000000001";

const { server, recorded } = usePlatformServer();

const account: PlatformAccount = {
  id: "cuenta-x",
  brokerId: "marca",
  platform: "x",
  externalAccountId: "12345",
  displayName: "@agentpey",
  status: "connected",
  tokenExpiresAt: null,
  meta: {
    userId: "12345",
    username: "agentpey",
    mode: "api",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    connectedAt: "2026-10-20T12:00:00.000Z",
    tokenRefreshedAt: null,
    accessTokenExpiresAt: "2026-10-20T14:00:00.000Z",
  },
  hasCredentials: true,
  createdAt: new Date("2026-10-20T12:00:00Z"),
  updatedAt: new Date("2026-10-20T12:00:00Z"),
};

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);

/** Un proveedor de token que anota cada pedido: el primero da `TOKEN`; con `rejectedToken`, otro. */
function tokenProvider() {
  const asked: Array<string | undefined> = [];
  const provider: AccessTokenProvider = async (options) => {
    asked.push(options?.rejectedToken);
    return options?.rejectedToken === undefined ? TOKEN : NEW_TOKEN;
  };
  return { provider, asked };
}

const deleted = () => HttpResponse.json({ data: { deleted: true } });

describe("retirar borrando en X (F9.5-T09, createXOperations)", () => {
  it("borra el post con DELETE /2/tweets/:id y el token de la cuenta; repetirlo (404) no falla", async () => {
    let calls = 0;
    server.use(
      http.delete(`${API}/2/tweets/:id`, () => {
        calls += 1;
        return calls === 1
          ? deleted()
          : HttpResponse.json(
              {
                title: "Not Found Error",
                type: "https://api.twitter.com/2/problems/resource-not-found",
              },
              { status: 404 },
            );
      }),
    );
    const { provider } = tokenProvider();
    const { remove } = createXOperations({ api: createXApi() });

    await remove({ externalId: POST_ID, progress: null }, { account, accessToken: provider });
    await remove({ externalId: POST_ID, progress: null }, { account, accessToken: provider });

    const requests = await recorded();
    expect(requests.map((r) => [r.method, r.url.pathname, r.authorization])).toEqual([
      ["DELETE", `/2/tweets/${POST_ID}`, `Bearer ${TOKEN}`],
      ["DELETE", `/2/tweets/${POST_ID}`, `Bearer ${TOKEN}`],
    ]);
  });

  it("un 401 pide otro token (rejectedToken) y repite una sola vez con el nuevo", async () => {
    server.use(
      http.delete(`${API}/2/tweets/:id`, ({ request }) =>
        request.headers.get("authorization") === `Bearer ${NEW_TOKEN}`
          ? deleted()
          : HttpResponse.json({ title: "Unauthorized", status: 401 }, { status: 401 }),
      ),
    );
    const { provider, asked } = tokenProvider();
    const { remove } = createXOperations({ api: createXApi() });

    await remove({ externalId: POST_ID, progress: null }, { account, accessToken: provider });

    expect(asked).toEqual([undefined, TOKEN]);
    expect((await recorded()).map((r) => r.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${NEW_TOKEN}`,
    ]);
  });

  it("un 401 también con el token nuevo sube como X_AUTH_INVALID, sin un tercer intento", async () => {
    server.use(
      http.delete(`${API}/2/tweets/:id`, () =>
        HttpResponse.json({ title: "Unauthorized", status: 401 }, { status: 401 }),
      ),
    );
    const { provider } = tokenProvider();
    const { remove } = createXOperations({ api: createXApi() });

    const error = await caught(
      remove({ externalId: POST_ID, progress: null }, { account, accessToken: provider }),
    );

    expect(isAppError(error) && error.code).toBe("X_AUTH_INVALID");
    expect(await recorded()).toHaveLength(2);
  });

  it("un 403 (un post de otra cuenta) sube como X_FORBIDDEN, sin repetir", async () => {
    server.use(
      http.delete(`${API}/2/tweets/:id`, () =>
        HttpResponse.json({ title: "Forbidden", status: 403 }, { status: 403 }),
      ),
    );
    const error = await caught(
      deleteXPost({ api: createXApi(), accessToken: TOKEN, postId: POST_ID }),
    );
    expect(isAppError(error) && error.code).toBe("X_FORBIDDEN");
    expect(await recorded()).toHaveLength(1);
  });

  it("un 200 que no dice deleted: true es X_UNEXPECTED_RESPONSE (no se da por borrado)", async () => {
    server.use(
      http.delete(`${API}/2/tweets/:id`, () => HttpResponse.json({ data: { deleted: false } })),
    );
    const error = await caught(
      deleteXPost({ api: createXApi(), accessToken: TOKEN, postId: POST_ID }),
    );
    expect(isAppError(error) && error.code).toBe("X_UNEXPECTED_RESPONSE");
  });

  it("un id que no es de un post de X se borra a mano: RETIRE_DELETE_UNSUPPORTED sin llamar", async () => {
    const { provider, asked } = tokenProvider();
    const { remove } = createXOperations({ api: createXApi() });

    const error = await caught(
      remove(
        { externalId: "https://x.com/agentpey/status/1", progress: null },
        { account, accessToken: provider },
      ),
    );

    expect(isAppError(error) && error.code).toBe("RETIRE_DELETE_UNSUPPORTED");
    expect(asked).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  it("ningún error lleva el token", async () => {
    server.use(
      http.delete(`${API}/2/tweets/:id`, () =>
        HttpResponse.json({ title: "Forbidden", status: 403 }, { status: 403 }),
      ),
    );
    const error = await caught(
      deleteXPost({ api: createXApi(), accessToken: TOKEN, postId: POST_ID }),
    );
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
