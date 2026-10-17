import { AppError } from "../../errors.js";
import type { PasswordHasher, SecretTokens } from "../../ports/auth.js";
import type { SessionRepository, UserRepository } from "../../ports/user-repository.js";
import {
  isValidEmail,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  type Session,
  type SessionClient,
  type User,
} from "../../user.js";

// Entrar, la sesión de cada pedido y salir (spec F7 §4.2, ADR-0021).

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Una sesión vence a los 30 días o tras 7 sin uso; el uso se anota a lo más una vez por minuto. */
export const SESSION_TTL_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
export const SESSION_TOUCH_MS = MINUTE;
/** Tras 10 fallos seguidos, 15 min de bloqueo. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MS = 15 * MINUTE;
/** Un token más largo que esto no es nuestro (nunca se busca). */
const MAX_TOKEN_LENGTH = 256;

export type SessionDeps = {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  tokens: SecretTokens;
  now?: () => Date;
};

/** Lo que recibe quien entra: el token va a la cookie o a la CLI, una sola vez. */
export type OpenedSession = { user: User; session: Session; token: string };

const invalid = () => new AppError("AUTH_INVALID", "El correo o la contraseña no son correctos");

/** Abre una sesión nueva para un usuario (entrar o aceptar una invitación). */
export async function openSession(
  deps: Pick<SessionDeps, "sessions" | "tokens">,
  user: User,
  client: SessionClient,
  now: Date,
): Promise<OpenedSession> {
  const token = deps.tokens.generate();
  const session = await deps.sessions.create({
    userId: user.id,
    tokenHash: deps.tokens.hash(token),
    client,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    now,
  });
  return { user, session, token };
}

/**
 * Entrar con correo y contraseña. Un solo error para un correo que no existe, una contraseña
 * equivocada o un usuario desactivado (`AUTH_INVALID`), con el mismo trabajo de hash en todos los
 * casos. Tras `LOGIN_MAX_FAILURES` fallos seguidos, `AUTH_LOCKED` durante `LOGIN_LOCK_MS`.
 * Riesgo aceptado (ADR-0021): solo un correo que existe llega a bloquearse, así que el undécimo
 * intento revela que existe; el bloqueo protege la contraseña, que importa más en un sistema
 * local. Intentos en paralelo antes del bloqueo cuentan todos.
 */
export async function login(
  deps: SessionDeps,
  input: { email: string; password: string; client: SessionClient },
): Promise<OpenedSession> {
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(input.email);
  const found = isValidEmail(email) ? await deps.users.findCredentials(email) : null;
  if (found?.user.lockedUntil != null && found.user.lockedUntil > now) {
    // El mismo trabajo de hash que un intento normal: el tiempo no distingue el bloqueo.
    await deps.hasher.verify(input.password.slice(0, PASSWORD_MAX_LENGTH), null);
    throw new AppError(
      "AUTH_LOCKED",
      "Demasiados intentos fallidos: espera 15 minutos o pide al administrador que te restablezca",
    );
  }
  // Una contraseña desmedida no se hashea (sería trabajo gratis para quien ataca), pero se responde igual.
  const tooLong = input.password.length > PASSWORD_MAX_LENGTH;
  const ok = !tooLong && (await deps.hasher.verify(input.password, found?.passwordHash ?? null));
  if (found === null || !ok) {
    if (found !== null && found.passwordHash !== null) {
      await deps.users.recordLoginFailure(found.user.id, {
        now,
        lockAfter: LOGIN_MAX_FAILURES,
        lockForMs: LOGIN_LOCK_MS,
      });
    }
    throw invalid();
  }
  if (found.user.disabledAt !== null) throw invalid();
  const user = await deps.users.recordLoginSuccess(found.user.id, now);
  return openSession(deps, user, input.client, now);
}

/**
 * La sesión de un token, con su usuario; `null` si no existe, venció, lleva más de
 * `SESSION_IDLE_MS` sin uso o su usuario está desactivado (las tres últimas se borran). Si la base
 * no responde, el `DB_UNAVAILABLE` sube: quien llama responde 503, nunca 401.
 */
export async function resolveSession(
  deps: Omit<SessionDeps, "hasher">,
  token: string,
): Promise<{ user: User; session: Session } | null> {
  if (token === "" || token.length > MAX_TOKEN_LENGTH) return null;
  const now = deps.now?.() ?? new Date();
  const found = await deps.sessions.findByTokenHash(deps.tokens.hash(token));
  if (found === null) return null;
  const { session, user } = found;
  const idle = now.getTime() - session.lastSeenAt.getTime() >= SESSION_IDLE_MS;
  if (session.expiresAt <= now || idle || user.disabledAt !== null) {
    await deps.sessions.delete(session.id);
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_MS) {
    await deps.sessions.touch(session.id, now);
    return { user, session: { ...session, lastSeenAt: now } };
  }
  return found;
}

/** Cierra la sesión de ese token (si existe). */
export async function logout(
  deps: Pick<SessionDeps, "sessions" | "tokens">,
  token: string,
): Promise<void> {
  if (token === "" || token.length > MAX_TOKEN_LENGTH) return;
  const found = await deps.sessions.findByTokenHash(deps.tokens.hash(token));
  if (found !== null) await deps.sessions.delete(found.session.id);
}
