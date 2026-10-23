import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { API_PREFIX } from "./access.js";
import { type AppType, mountApi } from "./app.js";
import { notFoundHandler } from "./errors.js";
import { hostGuard } from "./security.js";

// Lo que sirve `server.ts` (spec F8 §4.3, ADR-0024): la API bajo `/api` en los dos modos y, en el
// servidor, el panel compilado del mismo origen, con las cabeceras de seguridad. Usa `node:*`, así
// que no se exporta desde `index.ts` (no entra en `AppType`).

/** Un año: los archivos del build llevan un hash en el nombre y nunca cambian. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** `index.html` y lo demás de la carpeta: siempre se revalida (apunta al build vigente). */
const REVALIDATE = "no-cache";
/** HSTS de un año (solo tiene efecto con HTTPS). */
const HSTS = "max-age=31536000; includeSubDomains";

export type ServerAppOptions = {
  /** La carpeta del build del panel (`apps/web/dist`); sin ella, solo la API (con Vite en el Mac). */
  panelDir?: string;
  /**
   * El origen de las URLs prefirmadas de R2 (`https://<bucket>.<cuenta>.r2.cloudflarestorage.com`):
   * la CSP deja que el panel muestre fotos y videos desde ahí y suba con `PUT` (F8-T07).
   */
  storageOrigin: string;
  /** HSTS solo con `https://` (en el Mac no se manda). */
  https: boolean;
  /**
   * Los hosts permitidos (los mismos de la API): el panel tampoco se sirve con otro `Host`, ni por
   * la IP de la máquina (spec F8 §4.2); `GET /api/health` sigue fuera, para el chequeo del proveedor.
   */
  allowedHosts: readonly string[];
};

/**
 * Las miniaturas de la biblioteca de Pixabay (F9.5-T25): el panel las muestra para elegir, sin
 * guardarlas; la elegida se descarga a R2 en el worker.
 */
export const STOCK_PREVIEW_ORIGINS = ["https://pixabay.com", "https://cdn.pixabay.com"] as const;

/**
 * La CSP del panel (spec F8 §4.3): todo del mismo origen, salvo los medios y las subidas a R2 (y,
 * desde F9.5-T25, las miniaturas de la biblioteca).
 */
export function contentSecurityPolicy(storageOrigin: string) {
  return {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    fontSrc: ["'self'", "data:"],
    imgSrc: ["'self'", "data:", "blob:", storageOrigin, ...STOCK_PREVIEW_ORIGINS],
    mediaSrc: ["'self'", "blob:", storageOrigin],
    connectSrc: ["'self'", storageOrigin],
  };
}

/** La app que escucha `server.ts`: `/api/*` es la API; lo demás, el panel (si hay `panelDir`). */
export function createServerApp(api: AppType, options: ServerAppOptions) {
  const root = new Hono();
  root.use(
    secureHeaders({
      contentSecurityPolicy: contentSecurityPolicy(options.storageOrigin),
      strictTransportSecurity: options.https ? HSTS : false,
      // Ninguna dirección del panel (ni una URL prefirmada) sale en el `Referer` hacia otro sitio.
      referrerPolicy: "same-origin",
      xFrameOptions: "DENY",
      crossOriginResourcePolicy: "same-origin",
      crossOriginOpenerPolicy: "same-origin",
    }),
  );
  root.use(hostGuard(options.allowedHosts));
  root.route("/", mountApi(api));
  const panelDir = options.panelDir;
  if (panelDir !== undefined) {
    const isApi = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
    const files = serveStatic({ root: panelDir });
    const indexHtml = serveStatic({ path: join(panelDir, "index.html") });
    // `serveStatic` devuelve la respuesta si encontró el archivo; si no, lo que devuelve `next()`.
    const withCache = <T>(result: T, cache: string): T => {
      if (result instanceof Response) result.headers.set("Cache-Control", cache);
      return result;
    };
    // Un `/api/x` que no existe nunca cae en el panel: responde el 404 JSON de la API.
    root.on(["GET", "HEAD"], "*", async (c, next) => {
      if (isApi(c.req.path)) return next();
      const cache = c.req.path.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE;
      return withCache(await files(c, next), cache);
    });
    // Una ruta del panel que no es archivo (`/corredores`, `/entrar`…) es la app de React.
    root.on(["GET", "HEAD"], "*", async (c, next) => {
      if (isApi(c.req.path) || /\.[a-z0-9]+$/i.test(c.req.path)) return next();
      return withCache(await indexHtml(c, next), REVALIDATE);
    });
  }
  root.notFound(notFoundHandler);
  return root;
}
