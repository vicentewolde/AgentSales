import { AppError } from "../../errors.js";
import { assertCan } from "../../permissions.js";
import type { PasswordHasher, SecretTokens } from "../../ports/auth.js";
import type { BrokerRepository } from "../../ports/broker-repository.js";
import type {
  InvitationRepository,
  SessionRepository,
  UserRepository,
} from "../../ports/user-repository.js";
import {
  type InvitationPurpose,
  isValidEmail,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type SessionClient,
  type User,
  type UserRole,
} from "../../user.js";
import { type OpenedSession, openSession } from "./sessions.js";

// Invitar, aceptar, restablecer y desactivar usuarios (spec F7 §4.2, ADR-0021). Sin correo
// saliente: quien llama arma el enlace con el token y el administrador lo copia.

/** Un enlace vence a las 72 h y sirve una vez. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

const NAME_MAX_LENGTH = 120;

export type UserAdminDeps = {
  users: UserRepository;
  sessions: SessionRepository;
  invitations: InvitationRepository;
  brokers: Pick<BrokerRepository, "findById">;
  tokens: SecretTokens;
  now?: () => Date;
};

/** Un usuario con el token de su enlace (se muestra una vez). */
export type IssuedLink = { user: User; token: string; expiresAt: Date };

const invalidUser = (message: string) => new AppError("USER_INVALID", message);

async function issueLink(
  deps: Pick<UserAdminDeps, "invitations" | "tokens">,
  user: User,
  purpose: InvitationPurpose,
  createdBy: string | null,
  now: Date,
): Promise<IssuedLink> {
  const token = deps.tokens.generate();
  const invitation = await deps.invitations.issue({
    userId: user.id,
    tokenHash: deps.tokens.hash(token),
    purpose,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    createdBy,
  });
  return { user, token, expiresAt: invitation.expiresAt };
}

/**
 * Crea un usuario y su enlace de invitación. Solo el administrador (`FORBIDDEN`). Un corredor
 * necesita un corredor que exista (`BROKER_NOT_FOUND`); un administrador, ninguno.
 * `USER_INVALID` (400) con un correo o un nombre inválidos; `USER_EMAIL_TAKEN` (409) si el correo
 * ya existe.
 */
export async function inviteUser(
  deps: UserAdminDeps,
  input: {
    actor: User;
    email: string;
    name: string;
    role: UserRole;
    brokerId: string | null;
  },
): Promise<IssuedLink> {
  assertCan(input.actor, "users.manage");
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw invalidUser(`El correo "${input.email}" no es válido`);
  const name = input.name.trim();
  if (name === "" || name.length > NAME_MAX_LENGTH) {
    throw invalidUser(`El nombre es obligatorio y de hasta ${NAME_MAX_LENGTH} caracteres`);
  }
  if (input.role === "admin" && input.brokerId !== null) {
    throw invalidUser("Un administrador no pertenece a un corredor");
  }
  if (input.role === "broker") {
    if (input.brokerId === null) throw invalidUser("Un usuario de corredor necesita su corredor");
    if ((await deps.brokers.findById(input.brokerId)) === null) {
      throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${input.brokerId}`);
    }
  }
  const user = await deps.users.create({
    email,
    name,
    role: input.role,
    brokerId: input.role === "admin" ? null : input.brokerId,
  });
  return issueLink(deps, user, "invite", input.actor.id, now);
}

/** `PASSWORD_TOO_SHORT` o `PASSWORD_TOO_LONG` (400) si no cumple el largo. */
export function checkPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      "PASSWORD_TOO_SHORT",
      `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      "PASSWORD_TOO_LONG",
      `La contraseña puede tener hasta ${PASSWORD_MAX_LENGTH} caracteres`,
    );
  }
}

const invalidInvitation = () =>
  new AppError(
    "INVITATION_INVALID",
    "El enlace venció, ya se usó o no es válido: pide uno nuevo al administrador",
  );

/**
 * Aceptar un enlace: fija la contraseña, cierra las otras sesiones del usuario y abre una nueva.
 * `INVITATION_INVALID` (410) si el enlace no existe, venció, ya se usó o el usuario está
 * desactivado.
 */
export async function acceptInvitation(
  deps: UserAdminDeps & { hasher: PasswordHasher },
  input: { token: string; password: string; client: SessionClient },
): Promise<OpenedSession> {
  checkPassword(input.password);
  const now = deps.now?.() ?? new Date();
  if (input.token === "" || input.token.length > 256) throw invalidInvitation();
  const invitation = await deps.invitations.findByTokenHash(deps.tokens.hash(input.token));
  if (invitation === null || invitation.usedAt !== null || invitation.expiresAt <= now) {
    throw invalidInvitation();
  }
  const user = await deps.users.get(invitation.userId);
  if (user === null || user.disabledAt !== null) throw invalidInvitation();
  // El hash (lento) antes de gastar el enlace: si algo falla aquí, el enlace sigue sirviendo.
  const passwordHash = await deps.hasher.hash(input.password);
  if (!(await deps.invitations.consume(invitation.id, now))) throw invalidInvitation();
  await deps.users.setPassword(user.id, passwordHash);
  await deps.sessions.deleteForUser(user.id);
  const updated = await deps.users.recordLoginSuccess(user.id, now);
  return openSession(deps, updated, input.client, now);
}

async function mustGetUser(users: UserRepository, id: string): Promise<User> {
  const user = await users.get(id);
  if (user === null) throw new AppError("USER_NOT_FOUND", `No existe el usuario ${id}`);
  return user;
}

/**
 * Restablecer: un enlace nuevo (reemplaza el anterior), cierra todas las sesiones del usuario y
 * quita su bloqueo. Solo el administrador.
 */
export async function resetUserAccess(
  deps: UserAdminDeps,
  input: { actor: User; userId: string },
): Promise<IssuedLink> {
  assertCan(input.actor, "users.manage");
  const now = deps.now?.() ?? new Date();
  const user = await mustGetUser(deps.users, input.userId);
  await deps.sessions.deleteForUser(user.id);
  const cleared = await deps.users.clearLock(user.id);
  return issueLink(deps, cleared, "reset", input.actor.id, now);
}

/**
 * Desactivar (y cerrar sus sesiones) o reactivar un usuario. Solo el administrador; nadie se
 * desactiva a sí mismo (`USER_SELF_DISABLE`, 409): así el operador no se deja fuera.
 */
export async function setUserDisabled(
  deps: UserAdminDeps,
  input: { actor: User; userId: string; disabled: boolean },
): Promise<User> {
  assertCan(input.actor, "users.manage");
  if (input.disabled && input.actor.id === input.userId) {
    throw new AppError("USER_SELF_DISABLE", "No puedes desactivar tu propio usuario");
  }
  const now = deps.now?.() ?? new Date();
  await mustGetUser(deps.users, input.userId);
  const user = await deps.users.setDisabled(input.userId, input.disabled ? now : null);
  if (input.disabled) await deps.sessions.deleteForUser(user.id);
  return user;
}
