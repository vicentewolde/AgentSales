import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessFor, routePathOf } from "./access.js";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import { internetAccess } from "./security.js";
import { contentSecurityPolicy, createServerApp } from "./server-app.js";
import { TEST_ADMIN, TEST_ADMIN_TOKEN, testAuth, testDeps } from "./testing/index.js";

// F8-T02 (spec F8 §4.3, ADR-0024): la API bajo `/api`, el panel compilado del mismo origen, sin
// CORS, las cookies `__Host-` y las cabeceras de seguridad.

const PUBLIC_URL = "https://agentsales.agentpey.com";
const STORAGE_ORIGIN = "https://agentsales-media.cuenta.r2.cloudflarestorage.com";

let panelDir: string;

beforeAll(() => {
  panelDir = mkdtempSync(join(tmpdir(), "agentsales-panel-"));
  mkdirSync(join(panelDir, "assets"));
  writeFileSync(join(panelDir, "index.html"), "<!doctype html><title>AgentSales</title>");
  writeFileSync(join(panelDir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(panelDir, "favicon.svg"), "<svg/>");
});

afterAll(() => rmSync(panelDir, { recursive: true, force: true }));

function serverApp(options: { https?: boolean; panel?: boolean } = {}) {
  const https = options.https ?? true;
  const auth = { ...testAuth(), secureCookie: https };
  const api = createApp(testDeps({ auth, access: internetAccess(PUBLIC_URL) }));
  return createServerApp(api, {
    ...(options.panel === false ? {} : { panelDir }),
    storageOrigin: STORAGE_ORIGIN,
    https,
    allowedHosts: internetAccess(PUBLIC_URL).allowedHosts,
  });
}

const at = (path: string) => `${PUBLIC_URL}${path}`;
const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

describe("el prefijo /api", () => {
  it("routePathOf quita el prefijo y deja igual una ruta sin él", () => {
    expect(routePathOf("/api/listings/1")).toBe("/listings/1");
    expect(routePathOf("/api")).toBe("/");
    expect(routePathOf("/listings")).toBe("/listings");
    expect(routePathOf("/apis/x")).toBe("/apis/x");
  });

  it("con un prefijo doble, una barra de más o mayúsculas, nada queda público ni fuera de los guardias", async () => {
    for (const path of ["/api/api/auth/login", "//api/auth/login", "/API/auth/login"]) {
      expect(accessFor("POST", routePathOf(path))).toBe("session");
    }
    for (const path of ["/api/api/health", "//api/health", "/API/health"]) {
      expect(accessFor("HEAD", routePathOf(path))).toBe("session");
    }
    const app = serverApp();
    // Con otro Host, solo `/api/health` exacto pasa el `hostGuard`.
    for (const path of ["/api/api/health", "//api/health", "/API/health"]) {
      expect((await app.request(`http://10.0.0.7:8080${path}`)).status).toBe(403);
    }
    // `/api/api/meta/*` no queda fuera del CSRF: con la cookie y sin `Origin`, se rechaza.
    const meta = await app.request(at("/api/api/meta/data-deletion"), {
      method: "POST",
      headers: { cookie: "__Host-agentsales_session=algo" },
    });
    expect(meta.status).toBe(403);
    expect((await errorOf(meta)).code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("las rutas públicas siguen públicas bajo /api y las demás piden sesión", async () => {
    const app = serverApp();
    expect(accessFor("POST", routePathOf("/api/auth/login"))).toBe("public");

    const health = await app.request(at("/api/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", publishMode: "dry-run" });

    const listings = await app.request(at("/api/listings"));
    expect(listings.status).toBe(401);
    expect((await errorOf(listings)).code).toBe("AUTH_REQUIRED");

    const login = await app.request(at("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_URL },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    expect(login.status).toBe(200);
  });

  it("un /api/x que no existe responde el 404 JSON, nunca el panel", async () => {
    const response = await serverApp().request(at("/api/no-existe"), {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect((await errorOf(response)).code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("el panel compilado", () => {
  it("una ruta del panel devuelve index.html sin caché", async () => {
    for (const path of ["/", "/corredores", "/propiedades/123", "/invitacion"]) {
      const response = await serverApp().request(at(path));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>AgentSales</title>");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("un archivo con hash va con caché larga e immutable; los demás se revalidan", async () => {
    const asset = await serverApp().request(at("/assets/index-abc123.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const icon = await serverApp().request(at("/favicon.svg"));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("un archivo que no existe es 404 (no el panel), y no se sale de la carpeta", async () => {
    expect((await serverApp().request(at("/assets/no-existe.js"))).status).toBe(404);
    for (const path of [
      "/..%2F..%2Fetc%2Fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/..%2f..%2fpackage.json",
    ]) {
      const response = await serverApp().request(at(path));
      const body = await response.text();
      // O 404, o la app de React: nunca un archivo de fuera de la carpeta.
      expect(response.status === 404 || body.includes("<title>AgentSales</title>")).toBe(true);
      expect(body).not.toMatch(/root:|"name":/);
    }
  });

  it("el panel tampoco se sirve con otro Host, ni por la IP de la máquina", async () => {
    for (const host of ["http://10.0.0.7:8080", "https://agentpey.com"]) {
      const response = await serverApp().request(`${host}/corredores`);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("HOST_NOT_ALLOWED");
    }
  });

  it("sin la carpeta del panel (en el Mac) solo responde la API", async () => {
    const app = serverApp({ panel: false });
    expect((await app.request(at("/corredores"))).status).toBe(404);
    expect((await app.request(at("/api/health"))).status).toBe(200);
  });
});

describe("hosts, orígenes y CORS en internet", () => {
  it("internetAccess: solo el host y el origen de PUBLIC_URL", () => {
    expect(internetAccess(PUBLIC_URL)).toEqual({
      allowedHosts: ["agentsales.agentpey.com"],
      allowedOrigins: [PUBLIC_URL],
    });
  });

  it("rechaza otro Host, también la IP del servidor (salvo /api/health)", async () => {
    const app = serverApp();
    for (const host of ["http://10.0.0.7:8080", "https://agentpey.com"]) {
      const response = await app.request(`${host}/api/listings`);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("HOST_NOT_ALLOWED");
    }
    expect((await app.request("http://10.0.0.7:8080/api/health")).status).toBe(200);
    expect((await app.request("http://10.0.0.7:8080/api/health/live")).status).toBe(200);
  });

  it("no hay CORS: un OPTIONS de otro origen no recibe permisos, ni para Authorization", async () => {
    const response = await serverApp().request(at("/api/listings"), {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("una escritura con la cookie y otro Origin se rechaza", async () => {
    const response = await serverApp().request(at("/api/auth/logout"), {
      method: "POST",
      headers: { cookie: "__Host-agentsales_session=algo", origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("un POST /api/meta/* sin Origin (Meta, de servidor a servidor) no lo frena el CSRF", async () => {
    const response = await serverApp().request(at("/api/meta/data-deletion"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "__Host-agentsales_session=algo",
      },
      body: "signed_request=x.y",
    });
    // Pública desde F8-T17: el CSRF no la rechaza (sería 403 ORIGIN_NOT_ALLOWED) y la que la frena
    // es su firma (aquí, una que no es de Meta).
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("META_SIGNATURE_INVALID");
  });
});

describe("cookies con HTTPS", () => {
  it("entrar pone __Host-agentsales_session, Secure, HttpOnly, Strict, Path=/ y sin Domain", async () => {
    const response = await serverApp().request(at("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_URL },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-agentsales_session=[^;]+;/);
    for (const part of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) {
      expect(cookie).toContain(part);
    }
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("la cookie que puso entrar abre la sesión en la misma app", async () => {
    const app = serverApp();
    const login = await app.request(at("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_URL },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    const session = /^(__Host-agentsales_session=[^;]+)/.exec(
      login.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(session).toBeDefined();
    const me = await app.request(at("/api/auth/me"), { headers: { cookie: session ?? "" } });
    expect(me.status).toBe(200);
  });

  it("con HTTPS, una cookie sin el prefijo (la pudo poner otro subdominio) no da sesión", async () => {
    const app = serverApp();
    const plain = await app.request(at("/api/auth/me"), {
      headers: { cookie: `agentsales_session=${TEST_ADMIN_TOKEN}` },
    });
    expect(plain.status).toBe(401);
    const prefixed = await app.request(at("/api/auth/me"), {
      headers: { cookie: `__Host-agentsales_session=${TEST_ADMIN_TOKEN}` },
    });
    expect(prefixed.status).toBe(200);
  });

  it("con HTTPS, una escritura con la cookie sin prefijo no abre sesión aunque venga del panel", async () => {
    const response = await serverApp().request(at("/api/brokers"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_URL,
        cookie: `agentsales_session=${TEST_ADMIN_TOKEN}`,
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("AUTH_REQUIRED");
  });

  it("GET a la vuelta de un OAuth no pasa por el CSRF (llega desde Instagram, sin Origin)", async () => {
    const response = await serverApp().request(at("/api/oauth/instagram/callback?error=x"));
    expect(response.status).toBe(302);
  });

  it("sin HTTPS (en el Mac) la cookie es la de F7", async () => {
    const auth = { ...testAuth(), secureCookie: false };
    const api = createApp(
      testDeps({
        auth,
        access: { allowedHosts: ["localhost:8787"], allowedOrigins: ["http://localhost:5173"] },
      }),
    );
    const app = createServerApp(api, {
      storageOrigin: STORAGE_ORIGIN,
      https: false,
      allowedHosts: ["localhost:8787"],
    });
    const response = await app.request("http://localhost:8787/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^agentsales_session=/);
    expect(cookie).not.toContain("Secure");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("cabeceras de seguridad", () => {
  it("HSTS, CSP con el origen de R2, nosniff, Referrer-Policy y frame-ancestors", async () => {
    for (const path of ["/corredores", "/api/health"]) {
      const response = await serverApp().request(at(path));
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain(
        `img-src 'self' data: blob: ${STORAGE_ORIGIN} https://pixabay.com https://cdn.pixabay.com`,
      );
      expect(csp).toContain(`media-src 'self' blob: ${STORAGE_ORIGIN}`);
      expect(csp).toContain(`connect-src 'self' ${STORAGE_ORIGIN}`);
      expect(csp).toContain("script-src 'self'");
    }
  });

  it("la CSP no permite scripts de otro origen ni en línea", () => {
    const policy = contentSecurityPolicy(STORAGE_ORIGIN);
    expect(policy.scriptSrc).toEqual(["'self'"]);
    expect(policy.objectSrc).toEqual(["'none'"]);
  });
});

describe("páginas públicas (F8-T18)", () => {
  /** Las páginas legales tal como están en el panel (`apps/web/public`, que Vite copia a `dist`). */
  const publicDir = fileURLToPath(new URL("../../web/public", import.meta.url));
  const legalApp = () => {
    const api = createApp(testDeps({ access: internetAccess(PUBLIC_URL) }));
    return createServerApp(api, {
      panelDir: publicDir,
      storageOrigin: STORAGE_ORIGIN,
      https: true,
      allowedHosts: internetAccess(PUBLIC_URL).allowedHosts,
    });
  };

  it.each(["/legal/terminos.html", "/legal/privacidad.html", "/legal/eliminacion-de-datos.html"])(
    "%s se sirve sin sesión, en HTML, sin JavaScript y con la CSP",
    async (path) => {
      const response = await legalApp().request(at(path));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      const html = await response.text();
      // Lo lee el revisor de Meta sin JavaScript, y la CSP no deja estilos en línea.
      expect(html).not.toMatch(/<script|<style|style=|\son[a-z]+=/i);
      expect(html).toContain('<link rel="stylesheet" href="/legal/legal.css">');
    },
  );

  it("la hoja de estilos de las páginas también se sirve sin sesión", async () => {
    const response = await legalApp().request(at("/legal/legal.css"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
  });

  it("la página del pedido de borrado de Meta lleva la misma CSP", async () => {
    const response = await legalApp().request(at("/api/meta/data-deletion/no-existe"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
