import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { createInMemoryBrokerRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "./access.js";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import { TEST_ADMIN, TEST_ADMIN_TOKEN, testAuth, testDeps } from "./testing/index.js";

// F7-T04 y T05 (spec F7 §4.2 y §4.3): la sesión en la API, la tabla de permisos, el CSRF con cookie,
// los usuarios y `/health` en dos niveles.

const ORIGIN = "http://localhost:5173";
const BROKER_TOKEN = "token-corredor-de-prueba";
const SAMPLE_ID = "00000000-0000-4000-8000-000000000123";

async function setup() {
  const brokers = createInMemoryBrokerRepository();
  const auth = { ...testAuth(), brokers };
  // Todo lo que la API escribe en el log, para revisar que no salgan tokens ni enlaces.
  const logged: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write: (chunk, _encoding, callback) => {
        logged.push(String(chunk));
        callback();
      },
    }),
  );
  const app = createApp(
    testDeps({
      logger,
      auth,
      brokers,
      access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    }),
  );
  const broker = await brokers.create({
    slug: "corredor-demo",
    name: "Corredor Demo",
    brandName: "Demo Propiedades",
    primaryColor: "#112233",
    secondaryColor: "#112233",
    whatsapp: null,
    email: null,
    instagramHandle: null,
    website: null,
    tone: null,
    fixedHashtags: [],
  });
  const brokerUser = auth.repos.seed.user({
    email: "corredor@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: broker.id,
    passwordHash: "fake:clave-del-corredor",
  });
  auth.repos.seed.session({ userId: brokerUser.id, tokenHash: auth.tokens.hash(BROKER_TOKEN) });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return { app, auth, broker, brokerUser, bearer, logged };
}

const pathOf = (key: string) => {
  const [method = "", path = ""] = key.split(" ");
  return { method, path: path.replace(/:[a-z]+/g, SAMPLE_ID) };
};

/** Como la CLI y el panel: una escritura va como JSON (sin él, el CSRF de formularios la frena). */
const jsonType = (method: string): Record<string, string> =>
  method === "GET" ? {} : { "content-type": "application/json" };

const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

describe("la tabla de permisos", () => {
  it("clasifica cada ruta de la app, y no tiene rutas que no existen", async () => {
    const { app } = await setup();
    const routes = new Set(
      app.routes.filter((route) => route.method !== "ALL").map((r) => `${r.method} ${r.path}`),
    );
    expect([...routes].filter((route) => ROUTE_ACCESS[route] === undefined)).toEqual([]);
    expect(Object.keys(ROUTE_ACCESS).filter((route) => !routes.has(route))).toEqual([]);
  });

  it("sin sesión, cada ruta que la pide responde 401 AUTH_REQUIRED", async () => {
    const { app } = await setup();
    for (const [key, policy] of Object.entries(ROUTE_ACCESS)) {
      if (policy === "public") continue;
      const { method, path } = pathOf(key);
      const response = await app.request(path, { method, headers: jsonType(method) });
      expect([key, response.status]).toEqual([key, 401]);
      expect((await errorOf(response)).code).toBe("AUTH_REQUIRED");
    }
  });

  it("un corredor en una ruta del administrador recibe 403 FORBIDDEN", async () => {
    const { app, bearer } = await setup();
    for (const [key, policy] of Object.entries(ROUTE_ACCESS)) {
      if (policy !== "admin") continue;
      const { method, path } = pathOf(key);
      const response = await app.request(path, {
        method,
        headers: { ...jsonType(method), ...bearer(BROKER_TOKEN) },
      });
      expect([key, response.status]).toEqual([key, 403]);
      expect((await errorOf(response)).code).toBe("FORBIDDEN");
    }
  });

  it("una ruta que no existe pide sesión antes de decir que no existe", async () => {
    const { app } = await setup();
    expect((await app.request("/no-existe")).status).toBe(401);
    const found = await app.request("/no-existe", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(found.status).toBe(404);
  });

  it("la vuelta del OAuth de Instagram llega sin la cookie de sesión y no pide sesión", async () => {
    const { app } = await setup();
    const response = await app.request("/oauth/instagram/callback?code=x&state=y");
    expect(response.status).not.toBe(401);
  });
});

describe("entrar y salir", () => {
  it("el panel recibe la sesión en una cookie HttpOnly, Strict, de 30 días", async () => {
    const { app } = await setup();
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { email: string }; token?: string };
    expect(body.user.email).toBe(TEST_ADMIN.email);
    expect(body.token).toBeUndefined();
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^agentsales_session=[^;]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");

    const session = cookie.split(";")[0] ?? "";
    const me = await app.request("/auth/me", { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: TEST_ADMIN.email, role: "admin", broker: null },
    });

    const logout = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie: session, origin: ORIGIN },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("/auth/me", { headers: { cookie: session } })).status).toBe(401);
  });

  it("la CLI recibe el token en el cuerpo, sin cookie, y lo usa como Bearer", async () => {
    const { app, broker } = await setup();
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "CORREDOR@ejemplo.cl",
        password: "clave-del-corredor",
        client: "cli",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const { token } = (await response.json()) as { token: string };
    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({
      user: { role: "broker", broker: { id: broker.id, slug: "corredor-demo" } },
    });
  });

  it("mal: 401 AUTH_INVALID; bloqueado: 423 AUTH_LOCKED", async () => {
    const { app } = await setup();
    const attempt = (password: string) =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: TEST_ADMIN.email, password, client: "cli" }),
      });
    const wrong = await attempt("equivocada-larga");
    expect(wrong.status).toBe(401);
    expect(await errorOf(wrong)).toEqual({
      code: "AUTH_INVALID",
      message: "El correo o la contraseña no son correctos",
    });
    for (let i = 0; i < 9; i++) await attempt("equivocada-larga");
    const locked = await attempt(TEST_ADMIN.password);
    expect(locked.status).toBe(423);
    expect((await errorOf(locked)).code).toBe("AUTH_LOCKED");
  });

  it("aceptar el enlace fija la contraseña y deja la sesión en la cookie", async () => {
    const { app, auth } = await setup();
    const created = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ email: "nueva@ejemplo.cl", name: "Nueva", role: "admin" }),
    });
    const { invitationUrl } = (await created.json()) as { invitationUrl: string };
    const token = invitationUrl.split("#")[1] ?? "";
    const accepted = await app.request("/auth/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token, password: "una-clave-larga-1" }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("agentsales_session=");
    expect((await auth.users.findByEmail("nueva@ejemplo.cl"))?.hasPassword).toBe(true);
    const again = await app.request("/auth/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token, password: "una-clave-larga-1" }),
    });
    expect(again.status).toBe(410);
    expect((await errorOf(again)).code).toBe("INVITATION_INVALID");
  });
});

describe("CSRF con la cookie", () => {
  async function cookieOf(app: Awaited<ReturnType<typeof setup>>["app"]) {
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  it("una escritura con la cookie y otro Origin, o sin Origin, es 403 ORIGIN_NOT_ALLOWED", async () => {
    const { app } = await setup();
    const cookie = await cookieOf(app);
    for (const headers of [{ cookie, origin: "http://malo.example" }, { cookie }]) {
      const response = await app.request("/auth/logout", { method: "POST", headers });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("ORIGIN_NOT_ALLOWED");
    }
    const ok = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    expect(ok.status).toBe(204);
  });

  it("con Bearer y sin Origin (la CLI) pasa; un Origin ajeno se rechaza igual", async () => {
    const { app } = await setup();
    const headers = {
      authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "content-type": "application/json",
    };
    expect((await app.request("/auth/logout", { method: "POST", headers })).status).toBe(204);
    const foreign = await app.request("/auth/logout", {
      method: "POST",
      headers: { ...headers, origin: "http://malo.example" },
    });
    expect(foreign.status).toBe(403);
  });
});

describe("el matcher de la tabla", () => {
  it("una barra final, HEAD o mayúsculas no abren una ruta", async () => {
    const { app, bearer } = await setup();
    expect((await app.request("/users/")).status).toBe(401);
    expect((await app.request("/users/", { headers: bearer(BROKER_TOKEN) })).status).toBe(403);
    expect((await app.request("/users", { method: "HEAD" })).status).toBe(401);
    expect(
      (await app.request("/users", { method: "HEAD", headers: bearer(BROKER_TOKEN) })).status,
    ).toBe(403);
    // Una ruta en mayúsculas no está en la tabla: pide sesión (y después no existe).
    expect((await app.request("/USERS")).status).toBe(401);
    expect((await app.request("/USERS", { headers: bearer(BROKER_TOKEN) })).status).toBe(404);
  });
});

describe("el log", () => {
  it("nunca lleva el token de la CLI, la cookie ni el enlace de invitación", async () => {
    const { app, logged } = await setup();
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: TEST_ADMIN.email,
        password: TEST_ADMIN.password,
        client: "cli",
      }),
    });
    const { token } = (await login.json()) as { token: string };
    const created = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: "log@ejemplo.cl", name: "Log", role: "admin" }),
    });
    const { invitationUrl } = (await created.json()) as { invitationUrl: string };
    const invitation = invitationUrl.split("#")[1] ?? "";
    await app.request("/auth/me", { headers: { cookie: `agentsales_session=${token}` } });
    const text = logged.join("");
    expect(text).not.toBe("");
    for (const secret of [token, invitation, TEST_ADMIN.password, TEST_ADMIN_TOKEN]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("sin base", () => {
  it("una ruta con sesión da 503 (nunca 401); /health responde lo básico", async () => {
    const { app, auth } = await setup();
    auth.sessions.findByTokenHash = async () => {
      throw new AppError("DB_UNAVAILABLE", "La base de datos no responde", { retriable: true });
    };
    const headers = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
    const listings = await app.request("/listings", { headers });
    expect(listings.status).toBe(503);
    // Con la sesión del administrador que no se puede leer: lo básico, nunca el detalle.
    const health = await app.request("/health", { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", publishMode: "dry-run" });
  });
});

describe("/health en dos niveles", () => {
  it("sin sesión y con la de un corredor, el estado y el modo; el administrador, el detalle", async () => {
    const { app, bearer } = await setup();
    expect(await (await app.request("/health")).json()).toEqual({
      status: "ok",
      publishMode: "dry-run",
    });
    expect(await (await app.request("/health", { headers: bearer(BROKER_TOKEN) })).json()).toEqual({
      status: "ok",
      publishMode: "dry-run",
    });
    const admin = await (
      await app.request("/health", { headers: bearer(TEST_ADMIN_TOKEN) })
    ).json();
    expect(admin).toMatchObject({ status: "ok", version: "0.0.1", checks: { db: { ok: true } } });
  });
});

describe("usuarios (administrador)", () => {
  const json = (body: unknown) => ({
    "content-type": "application/json",
    authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
    body: JSON.stringify(body),
  });
  const post = (app: Awaited<ReturnType<typeof setup>>["app"], path: string, body?: unknown) => {
    const { body: payload, ...headers } = json(body ?? {});
    return app.request(path, { method: "POST", headers, body: payload });
  };

  it("crear da el enlace una vez, con el token en el fragmento; un correo repetido es 409", async () => {
    const { app } = await setup();
    const response = await post(app, "/users", {
      email: "Asistente@Ejemplo.cl",
      name: "Asistente",
      role: "admin",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { user: { email: string }; invitationUrl: string };
    expect(body.user).toMatchObject({ email: "asistente@ejemplo.cl", hasPassword: false });
    expect(body.invitationUrl).toMatch(/^http:\/\/localhost:5173\/invitacion#token-\d+$/);

    const list = (await (
      await app.request("/users", { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } })
    ).json()) as { users: Record<string, unknown>[] };
    expect(list.users.map((user) => user.email)).toContain("asistente@ejemplo.cl");
    // El listado nunca trae enlaces ni hashes.
    expect(JSON.stringify(list)).not.toMatch(/token|fake:|invitacion/);

    const taken = await post(app, "/users", {
      email: "asistente@ejemplo.cl",
      name: "Otra",
      role: "admin",
    });
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).code).toBe("USER_EMAIL_TAKEN");
  });

  it("restablecer da otro enlace y cierra las sesiones; desactivar y reactivar", async () => {
    const { app, brokerUser, bearer } = await setup();
    const reset = await post(app, `/users/${brokerUser.id}/reset`);
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { invitationUrl: string }).invitationUrl).toContain("#token-");
    expect((await app.request("/auth/me", { headers: bearer(BROKER_TOKEN) })).status).toBe(401);

    const disabled = await post(app, `/users/${brokerUser.id}/disable`);
    expect(await disabled.json()).toMatchObject({ user: { disabled: true } });
    const enabled = await post(app, `/users/${brokerUser.id}/enable`);
    expect(await enabled.json()).toMatchObject({ user: { disabled: false } });

    const self = await post(app, `/users/${TEST_ADMIN.id}/disable`);
    expect(self.status).toBe(409);
    expect((await errorOf(self)).code).toBe("USER_SELF_DISABLE");
    const missing = await post(app, `/users/${SAMPLE_ID}/reset`);
    expect(missing.status).toBe(404);
  });

  it("un corredor no puede crear usuarios", async () => {
    const { app } = await setup();
    const response = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BROKER_TOKEN}` },
      body: JSON.stringify({ email: "x@ejemplo.cl", name: "X", role: "admin" }),
    });
    expect(response.status).toBe(403);
  });
});
