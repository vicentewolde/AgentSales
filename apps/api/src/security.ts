import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { SESSION_COOKIE } from "./auth.js";
import { errorJson } from "./errors.js";

export type LocalAccess = {
  /** `host:puerto` aceptados en el Host de la petición (la API y el proxy de Vite). */
  allowedHosts: readonly string[];
  /** Orígenes del panel que pueden enviar formularios o `multipart` (CSRF). */
  allowedOrigins: readonly string[];
};

/** Hosts y orígenes de un uso local: la API en `apiPort` y el panel en `webPort`. */
export function localAccess(apiPort: number, webPort: number): LocalAccess {
  const hosts = ["127.0.0.1", "localhost"];
  return {
    allowedHosts: hosts.flatMap((host) => [`${host}:${apiPort}`, `${host}:${webPort}`]),
    allowedOrigins: hosts.map((host) => `http://${host}:${webPort}`),
  };
}

/**
 * Rechaza peticiones con un Host que no es local (defensa contra DNS rebinding): escuchar en
 * 127.0.0.1 no basta frente al navegador del operador. Desde F7 hay sesión; F8 cambia esto al
 * desplegar.
 */
export function hostGuard(allowedHosts: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedHosts);
  return async (c, next) => {
    const host = new URL(c.req.url).host;
    if (!allowed.has(host)) {
      return errorJson(c, 403, "HOST_NOT_ALLOWED", `Host no permitido: ${host}`);
    }
    await next();
  };
}

/** CSRF: formularios y `multipart` solo desde el panel. Las peticiones JSON exigen preflight CORS. */
export function csrfGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  return csrf({ origin: [...allowedOrigins] });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF con sesión (spec F7 §4.3, D11): una escritura con un `Origin` que no es el del panel se
 * rechaza siempre, y una con la cookie de sesión exige el `Origin` del panel (los navegadores lo
 * mandan en todo `POST`). Con `Authorization: Bearer` (la CLI, que no manda `Origin`) no aplica: un
 * sitio ajeno no puede poner esa cabecera sin pasar por CORS.
 */
export function originGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    const bearer = c.req.header("authorization") !== undefined;
    const cookie = getCookie(c, SESSION_COOKIE) !== undefined;
    const rejected = origin !== undefined ? !allowed.has(origin) : cookie && !bearer;
    if (rejected) {
      return errorJson(c, 403, "ORIGIN_NOT_ALLOWED", "El pedido no viene del panel");
    }
    return next();
  };
}
