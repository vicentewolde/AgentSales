// Quién puede usar cada ruta (spec F7 §4.3, ADR-0022). Cada método y ruta de la app está aquí: un
// test recorre `app.routes` y falla si alguna falta, así una ruta nueva no queda sin clasificar.
// - `public`: sin sesión (si viene una, se lee igual: `/health` muestra el detalle al administrador).
// - `session`: cualquier usuario con sesión; la ruta aplica su alcance (desde el lote C).
// - `admin`: solo el administrador.
// Hasta el lote C, las rutas de hoy son `admin`: el corredor todavía no tiene acceso a nada.

export type RoutePolicy = "public" | "session" | "admin";

export const ROUTE_ACCESS: Readonly<Record<string, RoutePolicy>> = {
  "GET /health": "public",
  // Entrar, salir y la invitación (F7-T04).
  "POST /auth/login": "public",
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
  "GET /listings": "admin",
  "GET /listings/:id": "admin",
  "POST /listings/:id/status": "admin",
  "POST /listings/:id/content-runs": "admin",
  "GET /listings/:id/content": "admin",
  "GET /listings/:id/publications": "admin",
  "POST /listings/:id/publish": "admin",
  "GET /content-runs/:id": "admin",
  "PATCH /contents/:id": "admin",
  "POST /contents/:id/approve": "admin",
  "POST /contents/:id/unapprove": "admin",
  // Publicaciones.
  "GET /publications/:id": "admin",
  "GET /publications/:id/events": "admin",
  "POST /publications/:id/publish": "admin",
  "POST /publications/:id/schedule": "admin",
  "POST /publications/:id/unschedule": "admin",
  "POST /publications/:id/update": "admin",
  "POST /publications/:id/relist": "admin",
  "POST /publications/:id/cancel": "admin",
  "POST /publications/:id/retire": "admin",
  "POST /publications/:id/pause": "admin",
  "POST /publications/:id/resume": "admin",
  "POST /publications/:id/close": "admin",
  "POST /publications/:id/confirm": "admin",
  "POST /publications/:id/not-published": "admin",
  "POST /publications/:id/sync": "admin",
  "POST /schedule": "admin",
  "GET /tracking": "admin",
  "GET /agenda": "admin",
  // Corredores y cargas.
  "GET /brokers": "admin",
  "PATCH /brokers/:id": "admin",
  "POST /imports": "admin",
  "POST /imports/local": "admin",
  "GET /imports": "admin",
  "GET /imports/:id": "admin",
  // Cuentas y OAuth. La vuelta de Instagram llega desde Instagram, sin la cookie `Strict`: la
  // protegen el `state` firmado y su propia cookie `Lax`.
  "GET /accounts": "admin",
  "POST /accounts/connect-token": "admin",
  "POST /accounts/mercadolibre/authorize-url": "admin",
  "POST /accounts/mercadolibre/connect": "admin",
  "POST /accounts/marketplace/login": "admin",
  "POST /accounts/:id/refresh": "admin",
  "POST /accounts/:id/disconnect": "admin",
  "GET /oauth/instagram/start": "admin",
  "GET /oauth/instagram/callback": "public",
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
