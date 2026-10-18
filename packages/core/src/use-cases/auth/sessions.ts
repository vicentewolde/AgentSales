import { AppError } from "../../errors.js";
import type { PasswordHasher, SecretTokens } from "../../ports/auth.js";
import type {
  LoginChallengeRepository,
  OAuthStateRepository,
  SessionRepository,
  UserRepository,
} from "../../ports/user-repository.js";
import {
  isValidEmail,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  type Session,
  type SessionClient,
  type User,
} from "../../user.js";
import { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES } from "./login-policy.js";
import { type TotpDeps, verifySecondFactor } from "./totp.js";

// Entrar, la sesión de cada pedido y salir (spec F7 §4.2, ADR-0021).

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Una sesión vence a los 30 días o tras 7 sin uso; el uso se anota a lo más una vez por minuto. */
export const SESSION_TTL_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
export const SESSION_TOUCH_MS = MINUTE;
export { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES } from "./login-policy.js";

/** Un token más largo que esto no es nuestro (nunca se busca). */
const MAX_TOKEN_LENGTH = 256;
/** El segundo paso de entrar con el doble factor vence a los 5 min (spec F8 §4.8). */
export const LOGIN_CHALLENGE_TTL_MS = 5 * MINUTE;

export type SessionDeps = {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  tokens: SecretTokens;
  /** El segundo paso de quien tiene el doble factor (F8-T15). */
  loginChallenges: Pick<LoginChallengeRepository, "create">;
  now?: () => Date;
};

/** Lo que recibe quien entra: el token va a la cookie o a la CLI, una sola vez. */
export type OpenedSession = { user: User; session: Session; token: string };

/**
 * Lo que da la contraseña correcta (spec F8 §4.8): la sesión o, con el doble factor activo, un
 * desafío de un solo uso (5 min) para el segundo paso (`loginWithTotp`). El token del desafío se
 * entrega una vez; la base guarda su hash.
 */
export type LoginResult =
  | ({ kind: "session" } & OpenedSession)
  | { kind: "totp_required"; challenge: string; expiresAt: Date };

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
): Promise<LoginResult> {
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
  // Con el doble factor, la contraseña sola no abre sesión: el contador de fallos sigue igual
  // hasta el segundo paso (sus fallos también cuentan).
  if (found.user.totpEnabledAt !== null) {
    const challenge = deps.tokens.generate();
    const expiresAt = new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS);
    await deps.loginChallenges.create({
      userId: found.user.id,
      tokenHash: deps.tokens.hash(challenge),
      expiresAt,
    });
    return { kind: "totp_required", challenge, expiresAt };
  }
  const user = await deps.users.recordLoginSuccess(found.user.id, now);
  return { kind: "session", ...(await openSession(deps, user, input.client, now)) };
}

const challengeInvalid = () =>
  new AppError(
    "LOGIN_CHALLENGE_INVALID",
    "El paso de entrar venció o ya se usó: vuelve a escribir tu correo y tu contraseña",
  );

/**
 * El segundo paso (spec F8 §4.8): el desafío de `login` y un código de la app (o uno de
 * recuperación) abren la sesión. `LOGIN_CHALLENGE_INVALID` si el desafío no existe, venció o ya
 * se usó; `TOTP_CODE_INVALID` si el código no sirve, y el fallo cuenta para el bloqueo (F7); con
 * el usuario bloqueado, `AUTH_LOCKED`. El desafío se gasta solo al entrar: un código mal escrito se
 * puede corregir mientras no venza.
 */
export async function loginWithTotp(
  deps: Omit<SessionDeps, "loginChallenges" | "hasher"> &
    Omit<TotpDeps, "sessions"> & {
      loginChallenges: Pick<LoginChallengeRepository, "findByTokenHash" | "consume">;
    },
  input: { challenge: string; code: string; client: SessionClient },
): Promise<OpenedSession> {
  const now = deps.now?.() ?? new Date();
  if (input.challenge === "" || input.challenge.length > MAX_TOKEN_LENGTH) {
    throw challengeInvalid();
  }
  const challenge = await deps.loginChallenges.findByTokenHash(deps.tokens.hash(input.challenge));
  if (challenge === null || challenge.usedAt !== null || challenge.expiresAt <= now) {
    throw challengeInvalid();
  }
  const user = await deps.users.get(challenge.userId);
  if (user === null || user.disabledAt !== null) throw invalid();
  if (user.lockedUntil !== null && user.lockedUntil > now) {
    throw new AppError(
      "AUTH_LOCKED",
      "Demasiados intentos fallidos: espera 15 minutos o pide al administrador que te restablezca",
    );
  }
  // Le quitaron el doble factor mientras tanto: el desafío ya no corresponde.
  if (user.totpEnabledAt === null) throw challengeInvalid();
  if (!(await verifySecondFactor(deps, { userId: user.id, code: input.code, now }))) {
    await deps.users.recordLoginFailure(user.id, {
      now,
      lockAfter: LOGIN_MAX_FAILURES,
      lockForMs: LOGIN_LOCK_MS,
    });
    throw new AppError(
      "TOTP_CODE_INVALID",
      "El código no es correcto o ya se usó: prueba con el siguiente de la app",
    );
  }
  if (!(await deps.loginChallenges.consume(challenge.id, now))) throw challengeInvalid();
  const entered = await deps.users.recordLoginSuccess(user.id, now);
  return openSession(deps, entered, input.client, now);
}

/**
 * La sesión de un token, con su usuario; `null` si no existe, venció, lleva más de
 * `SESSION_IDLE_MS` sin uso o su usuario está desactivado (las tres últimas se borran). Si la base
 * no responde, el `DB_UNAVAILABLE` sube: quien llama responde 503, nunca 401.
 */
export async function resolveSession(
  deps: Pick<SessionDeps, "sessions" | "tokens" | "now">,
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

/**
 * Borra las sesiones vencidas o sin uso desde `SESSION_IDLE_MS`, los `state` de OAuth vencidos y
 * (F8-T15) los desafíos del segundo paso vencidos (la vigilancia de cada hora del worker, spec F7
 * §4.2). Devuelve cuántos borró de cada uno.
 */
export async function purgeExpiredAuth(
  deps: {
    sessions: Pick<SessionRepository, "deleteExpired">;
    oauthStates: Pick<OAuthStateRepository, "deleteExpired">;
    loginChallenges: Pick<LoginChallengeRepository, "deleteExpired">;
  },
  now: Date,
): Promise<{ sessions: number; oauthStates: number; loginChallenges: number }> {
  const sessions = await deps.sessions.deleteExpired({
    now,
    idleBefore: new Date(now.getTime() - SESSION_IDLE_MS),
  });
  return {
    sessions,
    oauthStates: await deps.oauthStates.deleteExpired(now),
    loginChallenges: await deps.loginChallenges.deleteExpired(now),
  };
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
