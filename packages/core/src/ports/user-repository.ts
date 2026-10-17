import type {
  Invitation,
  InvitationPurpose,
  Session,
  SessionClient,
  User,
  UserRole,
} from "../user.js";

export type NewUser = {
  /** Ya normalizado (`normalizeEmail`): la base exige minúsculas. */
  email: string;
  name: string;
  role: UserRole;
  /** Obligatorio para `broker`; `null` para `admin`. */
  brokerId: string | null;
};

/**
 * Usuarios (`users`, spec F7 §4.12). Errores (`AppError`):
 * - `create` con un correo que ya existe → `USER_EMAIL_TAKEN`;
 * - cambiar un id que no existe → `USER_NOT_FOUND`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface UserRepository {
  create(user: NewUser): Promise<User>;
  get(id: string): Promise<User | null>;
  /** Por correo ya normalizado. */
  findByEmail(email: string): Promise<User | null>;
  /** El usuario y el hash de su contraseña (`null` si todavía no la eligió), para entrar. */
  findCredentials(email: string): Promise<{ user: User; passwordHash: string | null } | null>;
  /** Todos, por correo; con `brokerId`, solo los de ese corredor. */
  list(filter?: { brokerId?: string }): Promise<User[]>;
  /** Fija la contraseña y quita el bloqueo (`failed_logins = 0`, `locked_until = null`). */
  setPassword(id: string, passwordHash: string): Promise<User>;
  /**
   * Suma un fallo, de forma atómica. Al llegar a `lockAfter`, bloquea hasta `now + lockForMs` y
   * vuelve el contador a 0. Devuelve el usuario.
   */
  recordLoginFailure(
    id: string,
    policy: { now: Date; lockAfter: number; lockForMs: number },
  ): Promise<User>;
  /** Entró: contador en 0, sin bloqueo y `last_login_at = now`. */
  recordLoginSuccess(id: string, now: Date): Promise<User>;
  /** Quita el bloqueo y el contador (al restablecer). */
  clearLock(id: string): Promise<User>;
  /** `at` desactiva; `null` reactiva. */
  setDisabled(id: string, at: Date | null): Promise<User>;
}

export type NewSession = {
  userId: string;
  /** SHA-256 del token (`SecretTokens.hash`); el token nunca llega a la base. */
  tokenHash: string;
  client: SessionClient;
  expiresAt: Date;
  now: Date;
};

/** Sesiones (`sessions`, ADR-0021). `DB_UNAVAILABLE` si la base no responde. */
export interface SessionRepository {
  create(session: NewSession): Promise<Session>;
  /** La sesión de un token (por su hash) con su usuario; `null` si no existe. */
  findByTokenHash(tokenHash: string): Promise<{ session: Session; user: User } | null>;
  /** Marca el uso (`last_seen_at`). */
  touch(id: string, now: Date): Promise<void>;
  delete(id: string): Promise<void>;
  /** Cierra todas las sesiones de un usuario (restablecer, desactivar). Devuelve cuántas. */
  deleteForUser(userId: string): Promise<number>;
  /** Borra las vencidas o sin uso desde `idleBefore` (la vigilancia de cada hora). */
  deleteExpired(query: { now: Date; idleBefore: Date }): Promise<number>;
}

export type NewInvitation = {
  userId: string;
  tokenHash: string;
  purpose: InvitationPurpose;
  expiresAt: Date;
  createdBy: string | null;
};

/**
 * Enlaces de invitación y de restablecer (`invitations`). A lo más uno vigente (sin usar) por
 * usuario: `issue` borra el anterior sin usar en la misma transacción.
 */
export interface InvitationRepository {
  issue(invitation: NewInvitation): Promise<Invitation>;
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  /** Lo marca usado si todavía no lo estaba (condicional). `false` si ya se usó o no existe. */
  consume(id: string, now: Date): Promise<boolean>;
}

/**
 * `state` del OAuth ya usados (`oauth_states_used`, spec F7 §4.12): un `state` de Mercado Libre
 * sirve una vez.
 */
export interface OAuthStateRepository {
  /** `true` la primera vez que se marca ese nonce; `false` si ya estaba usado. */
  markUsed(nonceHash: string, expiresAt: Date): Promise<boolean>;
  /** Borra los vencidos. Devuelve cuántos. */
  deleteExpired(now: Date): Promise<number>;
}
