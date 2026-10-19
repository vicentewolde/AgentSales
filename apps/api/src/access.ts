// Quién puede usar cada ruta (spec F7 §4.3, ADR-0022). Cada método y ruta de la app está aquí: un
// test recorre `app.routes` y falla si alguna falta, así una ruta nueva no queda sin clasificar.
// - `public`: sin sesión (si viene una, se lee igual: `/health` muestra el detalle al administrador).
// - `session`: cualquier usuario con sesión; la ruta aplica su alcance (desde el lote C: las listas
//   filtran en SQL y `ownedBy` responde 404 a lo de otro corredor, spec F7 §4.4).
// - `admin`: solo el administrador (spec F7 §4.5: usuarios, cambiar un corredor, conectar cuentas,
//   la carga local de desarrollo y el inicio del OAuth).

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
  "POST /publications/:id/sync": "session",
  "POST /schedule": "session",
  "GET /tracking": "session",
  "GET /agenda": "session",
  // El gasto de IA del mes (F7-T12): cada uno ve el de su alcance.
  "GET /usage": "session",
  // Corredores y cargas.
  "GET /brokers": "session",
  // F7-T13 y T14: crear es del administrador; el corredor edita su marca (lo demás, 403 en core),
  // sube su logo y baja su planilla.
  "POST /brokers": "admin",
  "GET /brokers/:id": "session",
  "PATCH /brokers/:id": "session",
  "POST /brokers/:id/logo": "session",
  "GET /brokers/:id/template.xlsx": "session",
  // F8 (spec §4.4, ADR-0025): pedir la carga con sus URLs de subida y empezarla.
  "POST /imports/uploads": "session",
  "POST /imports/:id/start": "session",
  "GET /imports": "session",
  "GET /imports/:id": "session",
  // Cuentas y OAuth. La vuelta de Instagram llega desde Instagram, sin la cookie `Strict`: la
  // protegen el `state` firmado y su propia cookie `Lax`.
  "GET /accounts": "session",
  "POST /accounts/connect-token": "admin",
  "POST /accounts/mercadolibre/authorize-url": "admin",
  "POST /accounts/mercadolibre/connect": "admin",
  "POST /accounts/marketplace/login": "admin",
  "POST /accounts/marketplace/manual": "admin",
  "POST /accounts/:id/refresh": "admin",
  "POST /accounts/:id/disconnect": "admin",
  "GET /oauth/instagram/start": "admin",
  "GET /oauth/instagram/callback": "public",
  // La vuelta automática de Mercado Libre (F8-T19): llega desde Mercado Libre, sin la cookie
  // `Strict`; la protegen el `state` firmado de un solo uso y su propia cookie `Lax`.
  "GET /oauth/mercadolibre/callback": "public",
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
