// Quién puede usar cada ruta (spec F7 §4.3, ADR-0022). Cada método y ruta de la app está aquí: un
// test recorre `app.routes` y falla si alguna falta, así una ruta nueva no queda sin clasificar.
// - `public`: sin sesión (si viene una, se lee igual: `/health` muestra el detalle al administrador).
// - `session`: cualquier usuario con sesión; la ruta aplica su alcance (desde el lote C: las listas
//   filtran en SQL y `ownedBy` responde 404 a lo de otro corredor, spec F7 §4.4).
// - `admin`: solo el administrador (spec F7 §4.5: usuarios, cambiar un corredor, conectar cuentas,
//   y el inicio del OAuth).

export type RoutePolicy = "public" | "session" | "admin";

/**
 * El prefijo de la API (spec F8 §4.3, ADR-0024): `server.ts` monta la app bajo `/api` en los dos
 * modos (`mountApi`), así el panel y la API comparten origen. La tabla de abajo va sin él.
 */
export const API_PREFIX = "/api";

/** La ruta de la app sin el prefijo `/api` (los tests llaman a `createApp` sin montar). */
export function routePathOf(path: string): string {
  if (path === API_PREFIX) return "/";
  return path.startsWith(`${API_PREFIX}/`) ? path.slice(API_PREFIX.length) : path;
}

export const ROUTE_ACCESS: Readonly<Record<string, RoutePolicy>> = {
  "GET /health": "public",
  "GET /health/live": "public",
  // Entrar, salir y la invitación (F7-T04).
  "POST /auth/login": "public",
  // El segundo paso de entrar y el doble factor de cada usuario (F8-T15).
  "POST /auth/login/totp": "public",
  "GET /auth/totp": "session",
  "POST /auth/totp/setup": "session",
  "POST /auth/totp/confirm": "session",
  "POST /auth/totp/disable": "session",
  "POST /auth/invitations/accept": "public",
  // Salir es idempotente: con una sesión vencida igual borra la cookie (no responde 401).
  "POST /auth/logout": "public",
  "GET /auth/me": "session",
  // Usuarios (F7-T05).
  "GET /users": "admin",
  "POST /users": "admin",
  "POST /users/:id/reset": "admin",
  "POST /users/:id/disable": "admin",
  "POST /users/:id/enable": "admin",
  // Propiedades y su contenido.
  "GET /listings": "session",
  "GET /listings/:id": "session",
  "POST /listings/:id/status": "session",
  "POST /listings/:id/content-runs": "session",
  "GET /listings/:id/content": "session",
  "GET /listings/:id/publications": "session",
  "POST /listings/:id/publish": "session",
  "GET /content-runs/:id": "session",
  "PATCH /contents/:id": "session",
  "POST /contents/:id/approve": "session",
  "POST /contents/:id/unapprove": "session",
  // Publicaciones.
  "GET /publications/:id": "session",
  "GET /publications/:id/events": "session",
  "POST /publications/:id/publish": "session",
  "POST /publications/:id/schedule": "session",
  "POST /publications/:id/unschedule": "session",
  "POST /publications/:id/update": "session",
  "POST /publications/:id/relist": "session",
  "POST /publications/:id/cancel": "session",
  "POST /publications/:id/retire": "session",
  "POST /publications/:id/pause": "session",
  "POST /publications/:id/resume": "session",
  "POST /publications/:id/close": "session",
  "POST /publications/:id/confirm": "session",
  "POST /publications/:id/not-published": "session",
  // F9-T12: decir si salió una publicación con resultado dudoso (aviso o post).
  "POST /publications/:id/resolve": "session",
  "POST /publications/:id/sync": "session",
  "POST /schedule": "session",
  "GET /tracking": "session",
  "GET /agenda": "session",
  // F9-T18: el calendario (lo programado y lo publicado, avisos y posts) del alcance.
  "GET /calendar": "session",
  // El gasto de IA del mes (F7-T12): cada uno ve el de su alcance.
  "GET /usage": "session",
  // Corredores y cargas.
  "GET /brokers": "session",
  // F7-T13 y T14: crear es del administrador; el corredor edita su marca (lo demás, 403 en core),
  // sube su logo y baja su planilla.
  "POST /brokers": "admin",
  // F9.5-T16: leer la hoja Corredor de una planilla para llenar el formulario de crear (no guarda).
  "POST /brokers/parse-template": "admin",
  "GET /brokers/:id": "session",
  "PATCH /brokers/:id": "session",
  "POST /brokers/:id/logo": "session",
  "GET /brokers/:id/template.xlsx": "session",
  // F9.5-T14 (ADR-0035): borrar un corredor y todo lo suyo, y el resumen de antes.
  "GET /brokers/:id/purge-summary": "admin",
  "DELETE /brokers/:id": "admin",
  // F9-T09: el perfil editorial; leer con `broker.view` y editar con `brand.edit` (el corredor, el
  // suyo), revisados en core; el de otro corredor es 404 (`ownedBy`).
  "GET /brokers/:id/editorial-profile": "session",
  "PUT /brokers/:id/editorial-profile": "session",
  // F9-T10: los posts y sus medios, con `posts.manage` revisado en core; un corredor ve y gestiona
  // solo los de su marca (lo ajeno es 404: `ownedBy` y core), el administrador todos.
  "GET /posts": "session",
  "POST /posts": "session",
  "GET /posts/:id": "session",
  "PATCH /posts/:id": "session",
  "POST /posts/:id/archive": "session",
  "POST /posts/:id/uploads": "session",
  "POST /posts/:id/uploads/complete": "session",
  // F9-T12: pedir los textos, editarlos, aprobarlos o quitarles la aprobación por red e idioma,
  // publicar una red y programar; con `posts.manage` revisado en core y lo ajeno 404.
  "POST /posts/:id/draft": "session",
  "PATCH /posts/:id/contents/:platform/:language": "session",
  "POST /posts/:id/contents/:platform/:language/approve": "session",
  "POST /posts/:id/contents/:platform/:language/unapprove": "session",
  "POST /posts/:id/publish": "session",
  "POST /posts/:id/schedule": "session",
  // F9-T21: el plan de ideas (pedirlo, listarlo y verlo) y aceptar o descartar una idea, con
  // `posts.manage` revisado en core; un plan o una idea de otra marca es 404.
  "POST /plans": "session",
  "GET /plans": "session",
  "GET /plans/:id": "session",
  "POST /posts/:id/accept": "session",
  "POST /posts/:id/discard": "session",
  // F8 (spec §4.4, ADR-0025): pedir la carga con sus URLs de subida y empezarla.
  "POST /imports/uploads": "session",
  "POST /imports/:id/start": "session",
  "GET /imports": "session",
  "GET /imports/:id": "session",
  // Cuentas y OAuth. La vuelta de Instagram llega desde Instagram, sin la cookie `Strict`: la
  // protegen el `state` firmado y su propia cookie `Lax`.
  "GET /accounts": "session",
  "POST /accounts/connect-token": "admin",
  "POST /accounts/discord/connect": "admin",
  "POST /accounts/mercadolibre/authorize-url": "admin",
  "POST /accounts/mercadolibre/connect": "admin",
  "POST /accounts/marketplace/login": "admin",
  "POST /accounts/marketplace/manual": "admin",
  "POST /accounts/:id/refresh": "admin",
  "POST /accounts/:id/disconnect": "admin",
  // F9-T15 (ADR-0029 punto 9): pasar una red de contenido de marca a `manual` o `api`.
  "POST /accounts/:id/mode": "admin",
  // De sesión: el administrador conecta a cualquier corredor y un corredor, solo el suyo (la ruta
  // lo revisa con `instagram.connect`, ADR-0028).
  "GET /oauth/instagram/start": "session",
  "GET /oauth/instagram/callback": "public",
  // La vuelta automática de Mercado Libre (F8-T19): llega desde Mercado Libre, sin la cookie
  // `Strict`; la protegen el `state` firmado de un solo uso y su propia cookie `Lax`.
  "GET /oauth/mercadolibre/callback": "public",
  // X (F9-T16): el inicio, de sesión (la ruta revisa `x.connect`); la vuelta llega desde X, sin la
  // cookie `Strict`: la protegen el `state` firmado de un solo uso y la cookie firmada con PKCE. El
  // tope de gasto de una cuenta de X lo fija el administrador.
  "GET /oauth/x/start": "session",
  "GET /oauth/x/callback": "public",
  "POST /accounts/:id/spend-limit": "admin",
  // LinkedIn (F9-T15): el inicio con sesión (la ruta revisa `linkedin.connect`: el corredor, el
  // suyo) y la vuelta pública, protegida por el `state` firmado de un solo uso y su cookie `Lax`.
  "GET /oauth/linkedin/start": "session",
  "GET /oauth/linkedin/callback": "public",
  // TikTok (F9-T26): el inicio, con sesión (la ruta revisa `tiktok.connect`); la vuelta llega desde
  // TikTok, sin la cookie `Strict`: la protegen el `state` firmado de un solo uso y su cookie `Lax`.
  "GET /oauth/tiktok/start": "session",
  "GET /oauth/tiktok/callback": "public",
  // Las vueltas de Meta (F8-T17): de servidor a servidor, las protege la firma de la app; la página
  // del pedido la abre la persona que pidió el borrado (con su código).
  "POST /meta/deauthorize": "public",
  "POST /meta/data-deletion": "public",
  "GET /meta/data-deletion/:code": "public",
};

const STRICTNESS: Readonly<Record<RoutePolicy, number>> = { public: 0, session: 1, admin: 2 };

type CompiledRule = { method: string; pattern: RegExp; policy: RoutePolicy };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RULES: readonly CompiledRule[] = Object.entries(ROUTE_ACCESS).map(([key, policy]) => {
  const [method = "", path = ""] = key.split(" ");
  const pattern = path
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/]+" : escapeRegExp(part)))
    .join("/");
  return { method, pattern: new RegExp(`^${pattern}/?$`), policy };
});

/**
 * La política de un pedido. Si calza con más de una regla, la más estricta; una ruta que no está
 * en la tabla (que terminará en 404) pide sesión: nunca se abre por omisión.
 */
export function accessFor(method: string, path: string): RoutePolicy {
  const effective = method === "HEAD" ? "GET" : method;
  let found: RoutePolicy | undefined;
  for (const rule of RULES) {
    if (rule.method !== effective || !rule.pattern.test(path)) continue;
    if (found === undefined || STRICTNESS[rule.policy] > STRICTNESS[found]) found = rule.policy;
  }
  return found ?? "session";
}
