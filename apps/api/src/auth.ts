import {
  type AccessScope,
  AppError,
  type BrokerRepository,
  type InvitationRepository,
  isAppError,
  type PasswordHasher,
  resolveSession,
  SESSION_TTL_MS,
  type SecretTokens,
  type Session,
  type SessionClient,
  type SessionRepository,
  scopeOf,
  type User,
  type UserRepository,
} from "@agentsales/core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { accessFor } from "./access.js";
import type { AppLogger } from "./logger.js";
import type { RequestContext } from "./request-context.js";

// La sesión de cada pedido (spec F7 §4.3, ADR-0021): cookie en el panel o `Bearer` en la CLI.

export const SESSION_COOKIE = "agentsales_session";

/** Lo que la API sabe de quién hace el pedido. */
export type RequestAuth = {
  user: User;
  session: Session;
  scope: AccessScope;
  client: SessionClient;
};

/** Las variables de contexto de la app: `auth` es `null` sin sesión (solo en rutas públicas). */
export type AppEnv = { Variables: { auth: RequestAuth | null } };

/** Lo que la autenticación necesita (`server.ts` lo compone; los tests, con dobles). */
export type AuthDeps = {
  users: UserRepository;
  sessions: SessionRepository;
  invitations: InvitationRepository;
  brokers: Pick<BrokerRepository, "findById">;
  hasher: PasswordHasher;
  tokens: SecretTokens;
  /** La cookie va `Secure` (con HTTPS, F8). */
  secureCookie: boolean;
  now?: () => Date;
};

/**
 * Si el pedido trae `Authorization` (la CLI): entonces `credentialOf` **nunca** usa la cookie. Es la
 * misma razón que usan `originGuard` y `csrfGuard` para no exigir `Origin` (ADR-0021): un sitio
 * ajeno no puede poner esa cabecera sin CORS, y sin la cookie no hay sesión que robar.
 */
export const hasAuthorizationHeader = (c: Context): boolean =>
  c.req.header("authorization") !== undefined;

/** El token del pedido: `Authorization: Bearer` (la CLI) o la cookie del panel. */
export function credentialOf(c: Context): { token: string; via: "bearer" | "cookie" } | null {
  const header = c.req.header("authorization");
  // Con `Authorization`, la cookie no cuenta (aunque el encabezado no sirva): ver `hasAuthorizationHeader`.
  if (header !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match?.[1] === undefined ? null : { token: match[1], via: "bearer" };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie === undefined || cookie === "" ? null : { token: cookie, via: "cookie" };
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Strict" });
}

/**
 * Lee la sesión y aplica la política de la ruta (`access.ts`): sin sesión, `AUTH_REQUIRED` (401);
 * un corredor en una ruta del administrador, `FORBIDDEN` (403). Si la base no responde, el
 * `DB_UNAVAILABLE` sube (503), nunca un 401; en una ruta pública se sigue sin sesión.
 */
export function authenticate(
  deps: AuthDeps,
  logger: Pick<AppLogger, "warn">,
  context: Pick<RequestContext, "run">,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const policy = accessFor(c.req.method, c.req.path);
    const credential = credentialOf(c);
    let auth: RequestAuth | null = null;
    if (credential !== null) {
      try {
        const found = await resolveSession(deps, credential.token);
        if (found !== null) {
          auth = {
            user: found.user,
            session: found.session,
            scope: scopeOf(found.user),
            client: found.session.client,
          };
        }
      } catch (error) {
        if (policy !== "public") throw error;
        // En una ruta pública se sigue sin sesión (por ejemplo, `/health` con la base caída).
        logger.warn(
          { code: isAppError(error) ? error.code : undefined, path: c.req.path },
          "no se pudo leer la sesión: la ruta pública sigue sin ella",
        );
      }
    }
    c.set("auth", auth);
    // El usuario del pedido firma los eventos de la bitácora (`withEventUser`, spec F7 §4.3).
    const proceed = () => context.run(auth?.user.id ?? null, next);
    if (policy === "public") return proceed();
    if (auth === null) throw new AppError("AUTH_REQUIRED", "Inicia sesión para seguir");
    if (policy === "admin" && auth.user.role !== "admin") {
      throw new AppError("FORBIDDEN", "Esto lo hace el administrador");
    }
    return proceed();
  };
}

/** La sesión de una ruta que la exige (el middleware ya la revisó). */
export function requireAuth(c: Context<AppEnv>): RequestAuth {
  const auth = c.get("auth");
  if (auth === null) throw new AppError("AUTH_REQUIRED", "Inicia sesión para seguir");
  return auth;
}
