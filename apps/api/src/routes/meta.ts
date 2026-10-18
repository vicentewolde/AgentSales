import {
  getMetaDeletionRequest,
  handleMetaDataDeletion,
  handleMetaDeauthorize,
  type MetaCallbackDeps,
  type MetaDeletionRequest,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { API_PREFIX } from "../access.js";
import type { AppEnv } from "../auth.js";
import { errorJson } from "../errors.js";
import type { AppLogger } from "../logger.js";

/**
 * Verifica el `signed_request` de Meta (`createSignedRequestVerifier` de config, con la clave de la
 * app de Instagram y la de la app de Meta): el usuario de Instagram, o `null`. Lo compone
 * `server.ts`: la ruta no importa `node:crypto` (entra en `AppType`).
 */
export type MetaSignatureVerifier = (signedRequest: string) => { userId: string } | null;

export type MetaRoutesDeps = Pick<MetaCallbackDeps, "metaDeletion" | "now"> & {
  verifyMetaSignature: MetaSignatureVerifier;
  /** El código del pedido y el hash del `user_id` (los mismos tokens de las sesiones). */
  auth: { tokens: MetaCallbackDeps["tokens"] };
  /** La dirección pública (`PUBLIC_URL`, o el panel en el Mac): la de la página de estado. */
  panelUrl: string;
  logger: AppLogger;
};

/** La respuesta que pide Meta a la vuelta de borrar los datos (nota de Instagram §13.4). */
export type MetaDataDeletionResponse = { url: string; confirmation_code: string };

/** El cuerpo de Meta es un formulario corto: más de esto no es suyo. */
const MAX_META_BODY_BYTES = 16 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_META_BODY_BYTES,
  onError: (c) => errorJson(c, 413, "REQUEST_TOO_LARGE", "El pedido es demasiado grande"),
});

/** El usuario de Instagram del `signed_request` del formulario, o `null` si falta o no calza. */
async function signedUser(c: Context, verify: MetaSignatureVerifier): Promise<string | null> {
  let value: unknown;
  try {
    value = (await c.req.parseBody()).signed_request;
  } catch {
    return null;
  }
  return typeof value === "string" ? (verify(value)?.userId ?? null) : null;
}

const invalidSignature = (c: Context) =>
  errorJson(c, 400, "META_SIGNATURE_INVALID", "La firma del pedido de Meta no es válida");

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

/** La fecha y hora en Chile, como la lee una persona (`18 de octubre de 2026, 12:00`). */
const chileDateTime = (date: Date) =>
  new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);

/**
 * La página de estado de un pedido (HTML estático, sin JavaScript: la CSP del servidor no permite
 * estilos en línea, así que usa la hoja de las páginas legales del panel).
 */
function statusPage(code: string, request: MetaDeletionRequest | null): string {
  const body =
    request === null
      ? `<h1>Pedido no encontrado</h1>
<p>No hay un pedido de borrado con el código <code>${escapeHtml(code)}</code>. Revisa que el enlace esté completo.</p>`
      : `<h1>Pedido de borrado de datos</h1>
<dl>
<dt>Código</dt><dd><code>${escapeHtml(request.code)}</code></dd>
<dt>Recibido</dt><dd>${escapeHtml(chileDateTime(request.receivedAt))} (hora de Chile)</dd>
<dt>Estado</dt><dd>Completado${request.completedAt === null ? "" : ` el ${escapeHtml(chileDateTime(request.completedAt))}`}</dd>
</dl>
<p>${
          request.accountsAffected > 0
            ? "Borramos la conexión con tu cuenta de Instagram y los datos que guardábamos de ella: el acceso, el identificador y el nombre de la cuenta, y los enlaces e identificadores de las publicaciones. Lo que ya está publicado en Instagram sigue en Instagram: puedes borrarlo desde la app."
            : "No teníamos datos guardados de esa cuenta de Instagram: no hubo nada que borrar."
        }</p>`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Borrado de datos · AgentSales</title>
<link rel="stylesheet" href="/legal/legal.css">
</head>
<body>
<main>
${body}
<p><a href="/legal/eliminacion-de-datos.html">Cómo pedir el borrado de tus datos</a></p>
</main>
</body>
</html>
`;
}

/**
 * Las vueltas de Meta (spec F8 §4.11, D18), públicas y fuera del CSRF (las protege la firma, no el
 * `Origin`): `POST /meta/deauthorize` (quitar la app), `POST /meta/data-deletion` (borrar los datos)
 * y `GET /meta/data-deletion/:code` (la página del pedido). Una firma inválida responde 400 sin
 * tocar nada. En los logs, solo cuántas cuentas cambiaron: nunca el `user_id`.
 */
export function metaRoutes(deps: MetaRoutesDeps) {
  return new Hono<AppEnv>()
    .post("/deauthorize", tooLarge, async (c) => {
      const userId = await signedUser(c, deps.verifyMetaSignature);
      if (userId === null) return invalidSignature(c);
      const { accounts } = await handleMetaDeauthorize(deps, { instagramUserId: userId });
      deps.logger.info({ accounts }, "Meta: se quitó la app de una cuenta de Instagram");
      return c.json({ received: true as const }, 200);
    })
    .post("/data-deletion", tooLarge, async (c) => {
      const userId = await signedUser(c, deps.verifyMetaSignature);
      if (userId === null) return invalidSignature(c);
      const request = await handleMetaDataDeletion(
        { ...deps, tokens: deps.auth.tokens },
        { instagramUserId: userId },
      );
      deps.logger.info(
        { accounts: request.accountsAffected },
        "Meta: se borraron los datos de una cuenta de Instagram",
      );
      const url = new URL(
        `${API_PREFIX}/meta/data-deletion/${encodeURIComponent(request.code)}`,
        deps.panelUrl,
      );
      const body: MetaDataDeletionResponse = {
        url: url.toString(),
        confirmation_code: request.code,
      };
      return c.json(body, 200);
    })
    .get("/data-deletion/:code", async (c) => {
      const code = c.req.param("code");
      const request = await getMetaDeletionRequest(deps, code);
      c.header("Cache-Control", "no-store");
      return c.html(statusPage(code, request), request === null ? 404 : 200);
    });
}
