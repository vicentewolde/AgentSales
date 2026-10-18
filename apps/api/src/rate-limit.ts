import type { Context, MiddlewareHandler } from "hono";
import { routePathOf } from "./access.js";
import type { AppEnv } from "./auth.js";
import { errorJson } from "./errors.js";

// Límites por IP (spec F8 §4.8, ADR-0026, D14): en memoria, porque hay una sola instancia de la
// API. No es un puerto de core (core no lo usa). Con más de una instancia dejarían de ser globales:
// eso pide un ADR nuevo.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Un tope: `limit` pedidos por ventana fija de `windowMs`. */
export type RateLimitRule = { name: string; limit: number; windowMs: number };

/**
 * Los topes (spec F8 §4.8): entrar y su segundo paso comparten los suyos; aceptar una invitación
 * tiene el propio; toda la API, 300 por minuto por IP y, con sesión, también por usuario. El bloqueo
 * por usuario de F7 (10 fallos, 15 min) sigue aparte.
 */
export const RATE_LIMITS = {
  login: [
    { name: "login-minute", limit: 10, windowMs: MINUTE },
    { name: "login-hour", limit: 50, windowMs: HOUR },
  ],
  invitation: [{ name: "invitation-hour", limit: 10, windowMs: HOUR }],
  api: [{ name: "api-minute", limit: 300, windowMs: MINUTE }],
} as const satisfies Record<string, readonly RateLimitRule[]>;

/** Las rutas con tope propio, sin el prefijo `/api`. */
const LOGIN_PATHS = new Set(["/auth/login", "/auth/login/totp"]);
const INVITATION_PATH = "/auth/invitations/accept";

export type RateLimiter = {
  /**
   * Cuenta un pedido de `key` en la ventana de `rule`. `null` si cabe; si no, cuántos ms faltan
   * para que la ventana se renueve.
   */
  hit(key: string, rule: RateLimitRule): number | null;
};

/** Sobre esta cantidad de claves se borran las ventanas vencidas (la memoria no crece sin fin). */
const DEFAULT_MAX_KEYS = 50_000;

/**
 * Ventanas fijas en un `Map`: la primera vez que una clave pide en una ventana, la ventana empieza;
 * al vencer, se renueva con el pedido siguiente. Con `maxKeys` claves se borran las vencidas y, si
 * todavía no hay lugar (un ataque desde muchas IP), las más viejas del tope general de la API; los
 * topes de entrar y de las invitaciones se borran al final, los más viejos primero. Nunca se cae ni
 * crece sin fin.
 */
export function createRateLimiter(
  options: { now?: () => number; maxKeys?: number } = {},
): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const windows = new Map<string, { count: number; resetAt: number }>();
  const sweep = (at: number) => {
    for (const [key, window] of windows) if (window.resetAt <= at) windows.delete(key);
    // El `Map` guarda el orden de llegada: se recorren de la más vieja a la más nueva.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) return;
      if (key.startsWith(`${RATE_LIMITS.api[0].name}:`)) windows.delete(key);
    }
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) return;
      windows.delete(key);
    }
  };
  return {
    hit(key, rule) {
      const at = now();
      const id = `${rule.name}:${key}`;
      const current = windows.get(id);
      if (current === undefined || current.resetAt <= at) {
        if (windows.size >= maxKeys) sweep(at);
        windows.set(id, { count: 1, resetAt: at + rule.windowMs });
        return rule.limit >= 1 ? null : rule.windowMs;
      }
      current.count += 1;
      return current.count > rule.limit ? current.resetAt - at : null;
    },
  };
}

/** La IP del cliente de un pedido. */
export type ClientIpOf = (c: Context) => string;

/**
 * La clave de los topes para una IP: una IPv4 tal cual; una IPv6, su prefijo /64 (una conexión
 * suele tener un /64 entero, así que cambiar de dirección dentro de él no salta los topes). Una
 * IPv4 escrita como IPv6 (`::ffff:1.2.3.4`) cuenta como la IPv4.
 */
export function rateLimitKeyOf(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]?.split("::") ?? [];
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * La IP del cliente (spec F8 §4.2): con `CLIENT_IP_HEADER` (en Fly, `Fly-Client-IP`), esa cabecera
 * si viene; si no, la del socket. `X-Forwarded-For` y las demás cabeceras **nunca** cuentan sin
 * configurarlas: cualquiera las puede escribir. Sin IP conocida, `unknown` (todas juntas).
 */
export function clientIpResolver(
  header: string | undefined,
  socketIp: (c: Context) => string | undefined,
): ClientIpOf {
  return (c) => {
    if (header !== undefined) {
      // Si la cabecera trae una lista, la primera (Fly pone una sola).
      const value = c.req.header(header)?.split(",")[0]?.trim();
      if (value !== undefined && value !== "") return value;
    }
    return socketIp(c) ?? "unknown";
  };
}

export type RateLimitDeps = { limiter: RateLimiter; clientIp: ClientIpOf };

/** El 429 con `Retry-After` (en segundos, hacia arriba). */
function tooMany(c: Context, retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return errorJson(
    c,
    429,
    "RATE_LIMITED",
    `Demasiados pedidos seguidos: espera ${seconds} s y vuelve a intentarlo`,
    new Headers({ "Retry-After": String(seconds) }),
  );
}

/** El primer tope que se pasa (todos cuentan el pedido), o `null`. */
function firstExceeded(
  limiter: RateLimiter,
  key: string,
  rules: readonly RateLimitRule[],
): number | null {
  let wait: number | null = null;
  for (const rule of rules) {
    const retry = limiter.hit(key, rule);
    if (retry !== null && (wait === null || retry > wait)) wait = retry;
  }
  return wait;
}

/**
 * Los topes por IP, antes de leer la sesión: toda la API y, en entrar (y su segundo paso) y en
 * aceptar una invitación, los suyos.
 */
export function rateLimitByIp(deps: RateLimitDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = rateLimitKeyOf(deps.clientIp(c));
    const path = routePathOf(c.req.path);
    const route =
      c.req.method === "POST" && LOGIN_PATHS.has(path)
        ? RATE_LIMITS.login
        : c.req.method === "POST" && path === INVITATION_PATH
          ? RATE_LIMITS.invitation
          : null;
    const wait = Math.max(
      firstExceeded(deps.limiter, `ip:${ip}`, RATE_LIMITS.api) ?? -1,
      route === null ? -1 : (firstExceeded(deps.limiter, `ip:${ip}`, route) ?? -1),
    );
    if (wait >= 0) return tooMany(c, wait);
    return next();
  };
}

/** Con sesión, también por usuario (una cuenta desde muchas IP). Va después de `authenticate`. */
export function rateLimitByUser(deps: Pick<RateLimitDeps, "limiter">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth !== null) {
      const wait = firstExceeded(deps.limiter, `user:${auth.user.id}`, RATE_LIMITS.api);
      if (wait !== null) return tooMany(c, wait);
    }
    return next();
  };
}
