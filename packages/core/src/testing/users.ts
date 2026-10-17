import { AppError } from "../errors.js";
import type {
  InvitationRepository,
  NewUser,
  OAuthStateRepository,
  SessionRepository,
  UserRepository,
} from "../ports/user-repository.js";
import type { Invitation, Session, User } from "../user.js";
import { structuredCopy } from "./copy.js";

// Dobles en memoria de usuarios, sesiones, invitaciones y `state` usados (spec F7 §4.12): se
// comportan como Postgres en lo que prueba la suite de contrato.

type StoredUser = User & { passwordHash: string | null };

export type InMemoryUserRepositories = {
  /**
   * Siembra sincrónica para los arneses (la API, la CLI y el panel arman sus dependencias sin
   * `await`): un usuario con su contraseña ya hasheada y una sesión con el hash de su token.
   */
  seed: {
    user(input: NewUser & { id?: string; passwordHash?: string | null }): User;
    session(input: {
      userId: string;
      tokenHash: string;
      client?: Session["client"];
      expiresAt?: Date;
    }): Session;
  };
  users: UserRepository & { all(): User[] };
  sessions: SessionRepository & { all(): Session[] };
  invitations: InvitationRepository & { all(): Invitation[] };
  oauthStates: OAuthStateRepository;
};

export function createInMemoryUserRepositories(
  options: { now?: () => Date; nextId?: () => string } = {},
): InMemoryUserRepositories {
  const now = options.now ?? (() => new Date());
  let sequence = 0;
  const nextId = options.nextId ?? (() => `user-row-${++sequence}`);
  const users = new Map<string, StoredUser>();
  const sessions = new Map<string, Session & { tokenHash: string }>();
  const invitations = new Map<string, Invitation & { tokenHash: string }>();
  const states = new Map<string, Date>();

  const publicUser = ({ passwordHash, ...user }: StoredUser): User =>
    structuredCopy({ ...user, hasPassword: passwordHash !== null });
  const mustGet = (id: string) => {
    const user = users.get(id);
    if (user === undefined) throw new AppError("USER_NOT_FOUND", `No existe el usuario ${id}`);
    return user;
  };
  const update = (id: string, changes: Partial<StoredUser>) => {
    const updated = { ...mustGet(id), ...changes, updatedAt: now() };
    users.set(id, updated);
    return publicUser(updated);
  };

  const userRepository: InMemoryUserRepositories["users"] = {
    async create(input: NewUser) {
      if (input.email !== input.email.toLowerCase()) {
        throw new AppError("DB_QUERY_FAILED", "users_email_lowercase");
      }
      if ((input.role === "admin") !== (input.brokerId === null)) {
        throw new AppError("DB_QUERY_FAILED", "users_role_broker");
      }
      if ([...users.values()].some((user) => user.email === input.email)) {
        throw new AppError("USER_EMAIL_TAKEN", "Ya existe un usuario con ese correo");
      }
      const at = now();
      const stored: StoredUser = {
        ...input,
        id: nextId(),
        hasPassword: false,
        passwordHash: null,
        failedLogins: 0,
        lockedUntil: null,
        disabledAt: null,
        lastLoginAt: null,
        createdAt: at,
        updatedAt: at,
      };
      users.set(stored.id, stored);
      return publicUser(stored);
    },
    async get(id) {
      const user = users.get(id);
      return user === undefined ? null : publicUser(user);
    },
    async findByEmail(email) {
      const user = [...users.values()].find((candidate) => candidate.email === email);
      return user === undefined ? null : publicUser(user);
    },
    async findCredentials(email) {
      const user = [...users.values()].find((candidate) => candidate.email === email);
      return user === undefined
        ? null
        : { user: publicUser(user), passwordHash: user.passwordHash };
    },
    async list(filter = {}) {
      return [...users.values()]
        .filter((user) => filter.brokerId === undefined || user.brokerId === filter.brokerId)
        .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
        .map(publicUser);
    },
    async setPassword(id, passwordHash) {
      return update(id, { passwordHash, failedLogins: 0, lockedUntil: null });
    },
    async recordLoginFailure(id, { now: at, lockAfter, lockForMs }) {
      const next = mustGet(id).failedLogins + 1;
      return next >= lockAfter
        ? update(id, { failedLogins: 0, lockedUntil: new Date(at.getTime() + lockForMs) })
        : update(id, { failedLogins: next });
    },
    async recordLoginSuccess(id, at) {
      return update(id, { failedLogins: 0, lockedUntil: null, lastLoginAt: at });
    },
    async clearLock(id) {
      return update(id, { failedLogins: 0, lockedUntil: null });
    },
    async setDisabled(id, at) {
      return update(id, { disabledAt: at });
    },
    all: () => [...users.values()].map(publicUser),
  };

  const sessionRepository: InMemoryUserRepositories["sessions"] = {
    async create({ userId, tokenHash, client, expiresAt, now: at }) {
      mustGet(userId);
      if ([...sessions.values()].some((session) => session.tokenHash === tokenHash)) {
        throw new AppError("DB_QUERY_FAILED", "sessions_token_hash_unique");
      }
      const session = { id: nextId(), userId, client, expiresAt, lastSeenAt: at, createdAt: at };
      sessions.set(session.id, { ...session, tokenHash });
      return structuredCopy(session);
    },
    async findByTokenHash(tokenHash) {
      const found = [...sessions.values()].find((session) => session.tokenHash === tokenHash);
      if (found === undefined) return null;
      const { tokenHash: _hash, ...session } = found;
      return { session: structuredCopy(session), user: publicUser(mustGet(session.userId)) };
    },
    async touch(id, at) {
      const session = sessions.get(id);
      if (session !== undefined) sessions.set(id, { ...session, lastSeenAt: at });
    },
    async delete(id) {
      sessions.delete(id);
    },
    async deleteForUser(userId) {
      const ids = [...sessions.values()].filter((s) => s.userId === userId).map((s) => s.id);
      for (const id of ids) sessions.delete(id);
      return ids.length;
    },
    async deleteExpired({ now: at, idleBefore }) {
      const ids = [...sessions.values()]
        .filter((s) => s.expiresAt < at || s.lastSeenAt < idleBefore)
        .map((s) => s.id);
      for (const id of ids) sessions.delete(id);
      return ids.length;
    },
    all: () => [...sessions.values()].map(({ tokenHash: _hash, ...session }) => session),
  };

  const invitationRepository: InMemoryUserRepositories["invitations"] = {
    async issue({ userId, tokenHash, purpose, expiresAt, createdBy }) {
      mustGet(userId);
      for (const [id, open] of invitations) {
        if (open.userId === userId && open.usedAt === null) invitations.delete(id);
      }
      const invitation = {
        id: nextId(),
        userId,
        purpose,
        expiresAt,
        usedAt: null,
        createdBy,
        createdAt: now(),
      };
      invitations.set(invitation.id, { ...invitation, tokenHash });
      return structuredCopy(invitation);
    },
    async findByTokenHash(tokenHash) {
      const found = [...invitations.values()].find((i) => i.tokenHash === tokenHash);
      if (found === undefined) return null;
      const { tokenHash: _hash, ...invitation } = found;
      return structuredCopy(invitation);
    },
    async consume(id, at) {
      const found = invitations.get(id);
      if (found === undefined || found.usedAt !== null) return false;
      invitations.set(id, { ...found, usedAt: at });
      return true;
    },
    all: () => [...invitations.values()].map(({ tokenHash: _hash, ...invitation }) => invitation),
  };

  const oauthStates: OAuthStateRepository = {
    async markUsed(nonceHash, expiresAt) {
      if (states.has(nonceHash)) return false;
      states.set(nonceHash, expiresAt);
      return true;
    },
    async deleteExpired(at) {
      let deleted = 0;
      for (const [hash, expiresAt] of states) {
        if (expiresAt < at) {
          states.delete(hash);
          deleted++;
        }
      }
      return deleted;
    },
  };

  const seed: InMemoryUserRepositories["seed"] = {
    user({ id, passwordHash = null, ...input }) {
      const at = now();
      const stored: StoredUser = {
        ...input,
        id: id ?? nextId(),
        hasPassword: passwordHash !== null,
        passwordHash,
        failedLogins: 0,
        lockedUntil: null,
        disabledAt: null,
        lastLoginAt: null,
        createdAt: at,
        updatedAt: at,
      };
      users.set(stored.id, stored);
      return publicUser(stored);
    },
    session({ userId, tokenHash, client = "cli", expiresAt }) {
      const at = now();
      const session = {
        id: nextId(),
        userId,
        client,
        expiresAt: expiresAt ?? new Date(at.getTime() + 365 * 24 * 60 * 60 * 1000),
        lastSeenAt: at,
        createdAt: at,
      };
      sessions.set(session.id, { ...session, tokenHash });
      return structuredCopy(session);
    },
  };

  return {
    seed,
    users: userRepository,
    sessions: sessionRepository,
    invitations: invitationRepository,
    oauthStates,
  };
}
