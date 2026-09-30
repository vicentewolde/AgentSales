import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
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
 * Rechaza peticiones con un Host que no es local (defensa contra DNS rebinding). La API no tiene
 * autenticación hasta F7: escuchar en 127.0.0.1 no basta frente al navegador del operador.
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
