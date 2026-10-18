import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { routePathOf } from "./access.js";
import { hasAuthorizationHeader, SESSION_COOKIE } from "./auth.js";
import { errorJson } from "./errors.js";

export type LocalAccess = {
  /** `host:puerto` aceptados en el Host de la petición (la API y el proxy de Vite). */
  allowedHosts: readonly string[];
  /** Orígenes del panel que pueden enviar formularios o `multipart` (CSRF). */
  allowedOrigins: readonly string[];
};

/** Los hosts y orígenes de la API (`localAccess` en el Mac, `internetAccess` en el servidor). */
export type ApiAccess = LocalAccess;

/** Hosts y orígenes de un uso local: la API en `apiPort` y el panel en `webPort`. */
export function localAccess(apiPort: number, webPort: number): LocalAccess {
  const hosts = ["127.0.0.1", "localhost"];
  return {
    allowedHosts: hosts.flatMap((host) => [`${host}:${apiPort}`, `${host}:${webPort}`]),
    allowedOrigins: hosts.map((host) => `http://${host}:${webPort}`),
  };
}

/**
 * Hosts y orígenes en internet (spec F8 §4.2): solo el de `PUBLIC_URL` (sin la IP del servidor ni
 * otro nombre). El panel es del mismo origen que la API (ADR-0024).
 */
export function internetAccess(publicUrl: string): ApiAccess {
  const url = new URL(publicUrl);
  return { allowedHosts: [url.host], allowedOrigins: [url.origin] };
}

/**
 * El chequeo de salud del proveedor puede llegar con otro `Host` (la IP de la máquina, NO
 * VERIFICADO en Fly): `GET /health` no pasa por `hostGuard`. Sin sesión no revela nada (F7).
 */
const isHealthCheck = (method: string, path: string): boolean =>
  (method === "GET" || method === "HEAD") && routePathOf(path) === "/health";

/**
 * Las vueltas de servidor a servidor (spec F8 §4.3): Meta manda un formulario sin `Origin` (quitar
 * la app y borrar los datos, F8-T17). Las protege su firma, no el CSRF.
 */
const SERVER_TO_SERVER_PREFIXES = ["/meta/"] as const;
const isServerToServer = (path: string): boolean => {
  const route = routePathOf(path);
  return SERVER_TO_SERVER_PREFIXES.some((prefix) => route.startsWith(prefix));
};

/**
 * Rechaza peticiones con un Host que no es local (defensa contra DNS rebinding): escuchar en
 * 127.0.0.1 no basta frente al navegador del operador. En internet, el único host es el de
 * `PUBLIC_URL` (`internetAccess`).
 */
export function hostGuard(allowedHosts: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedHosts);
  return async (c, next) => {
    if (isHealthCheck(c.req.method, c.req.path)) return next();
    const host = new URL(c.req.url).host;
    if (!allowed.has(host)) {
      return errorJson(c, 403, "HOST_NOT_ALLOWED", `Host no permitido: ${host}`);
    }
    await next();
  };
}

/**
 * CSRF: formularios y `multipart` solo desde el panel. Las peticiones JSON exigen preflight CORS.
 * Con `Authorization: Bearer` (la CLI: subir el logo, F7-T16) no aplica, por la misma razón que en
 * `originGuard`: un sitio ajeno no puede poner esa cabecera sin pasar por CORS.
 */
export function csrfGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  const guard = csrf({ origin: [...allowedOrigins] });
  return async (c, next) => {
    if (hasAuthorizationHeader(c) || isServerToServer(c.req.path)) return next();
    return guard(c, next);
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF con sesión (spec F7 §4.3, D11): una escritura con un `Origin` que no es el del panel se
 * rechaza siempre, y una con la cookie de sesión exige el `Origin` del panel (los navegadores lo
 * mandan en todo `POST`). Con `Authorization: Bearer` (la CLI, que no manda `Origin`) no aplica: un
 * sitio ajeno no puede poner esa cabecera sin pasar por CORS.
 */
export function originGuard(
  allowedOrigins: readonly string[],
  sessionCookie: string = SESSION_COOKIE,
): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || isServerToServer(c.req.path)) return next();
    const origin = c.req.header("origin");
    const bearer = hasAuthorizationHeader(c);
    const cookie = getCookie(c, sessionCookie) !== undefined;
    const rejected = origin !== undefined ? !allowed.has(origin) : cookie && !bearer;
    if (rejected) {
      return errorJson(c, 403, "ORIGIN_NOT_ALLOWED", "El pedido no viene del panel");
    }
    return next();
  };
}
