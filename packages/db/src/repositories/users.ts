import {
  AppError,
  type InvitationRepository,
  invitationSchema,
  type NewInvitation,
  type OAuthStateRepository,
  type SessionRepository,
  sessionSchema,
  type User,
  type UserRepository,
  userSchema,
} from "@agentsales/core";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { invitations, oauthStatesUsed, sessions, users } from "../schema.js";

// Usuarios, sesiones, invitaciones y `state` usados (spec F7 §4.12, ADR-0021). Los hashes de la
// contraseña y de los tokens nunca salen de aquí en las entidades.

const EMAIL_UNIQUE = "users_email_unique";
const OPEN_INVITATION_UNIQUE = "invitations_one_open_per_user";

type UserRow = typeof users.$inferSelect;

function toUser(row: UserRow): User {
  const parsed = userSchema.safeParse({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    brokerId: row.brokerId,
    hasPassword: row.passwordHash !== null,
    failedLogins: row.failedLogins,
    lockedUntil: row.lockedUntil,
    disabledAt: row.disabledAt,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) {
    throw new AppError("USER_ROW_INVALID", "Un usuario tiene datos inválidos", {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const notFound = (id: string) => new AppError("USER_NOT_FOUND", `No existe el usuario ${id}`);

/** `UserRepository` sobre Drizzle. */
export function createUserRepository(db: SchemaDatabase): UserRepository {
  /** Un `UPDATE … RETURNING` de un usuario; `USER_NOT_FOUND` si no existe. */
  const updateOne = (id: string, set: Partial<typeof users.$inferInsert>) =>
    withDbErrors(async () => {
      const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
      if (row === undefined) throw notFound(id);
      return toUser(row);
    });

  return {
    async create(user) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db.insert(users).values(user).returning();
          if (row === undefined) throw new AppError("USER_WRITE_FAILED", "No se creó el usuario");
          return toUser(row);
        });
      } catch (error) {
        if (isUniqueViolation(error, EMAIL_UNIQUE)) {
          throw new AppError("USER_EMAIL_TAKEN", "Ya existe un usuario con ese correo", {
            cause: error,
          });
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(users).where(eq(users.id, id));
        return row === undefined ? null : toUser(row);
      });
    },

    findByEmail(email) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(users).where(eq(users.email, email));
        return row === undefined ? null : toUser(row);
      });
    },

    findCredentials(email) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(users).where(eq(users.email, email));
        return row === undefined ? null : { user: toUser(row), passwordHash: row.passwordHash };
      });
    },

    list(filter = {}) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(users)
          .where(filter.brokerId === undefined ? undefined : eq(users.brokerId, filter.brokerId))
          // Por bytes ("C"), como el doble, sea cual sea la collation de la base.
          .orderBy(sql`${users.email} collate "C"`);
        return rows.map(toUser);
      });
    },

    setPassword(id, passwordHash) {
      return updateOne(id, { passwordHash, failedLogins: 0, lockedUntil: null });
    },

    recordLoginFailure(id, { now, lockAfter, lockForMs }) {
      // Atómico en una sola sentencia: dos intentos a la vez suman los dos.
      const next = sql`${users.failedLogins} + 1`;
      const lockUntil = new Date(now.getTime() + lockForMs).toISOString();
      return withDbErrors(async () => {
        const [row] = await db
          .update(users)
          .set({
            failedLogins: sql`CASE WHEN ${next} >= ${lockAfter} THEN 0 ELSE ${next} END`,
            lockedUntil: sql`CASE WHEN ${next} >= ${lockAfter} THEN ${lockUntil}::timestamptz ELSE ${users.lockedUntil} END`,
          })
          .where(eq(users.id, id))
          .returning();
        if (row === undefined) throw notFound(id);
        return toUser(row);
      });
    },

    recordLoginSuccess(id, now) {
      return updateOne(id, { failedLogins: 0, lockedUntil: null, lastLoginAt: now });
    },

    clearLock(id) {
      return updateOne(id, { failedLogins: 0, lockedUntil: null });
    },

    setDisabled(id, at) {
      return updateOne(id, { disabledAt: at });
    },
  };
}

/** `SessionRepository` sobre Drizzle. */
export function createSessionRepository(db: SchemaDatabase): SessionRepository {
  const toSession = (row: typeof sessions.$inferSelect) =>
    sessionSchema.parse({
      id: row.id,
      userId: row.userId,
      client: row.client,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
    });

  return {
    create({ userId, tokenHash, client, expiresAt, now }) {
      return withDbErrors(async () => {
        const [row] = await db
          .insert(sessions)
          .values({ userId, tokenHash, client, expiresAt, lastSeenAt: now, createdAt: now })
          .returning();
        if (row === undefined) throw new AppError("SESSION_WRITE_FAILED", "No se creó la sesión");
        return toSession(row);
      });
    },

    findByTokenHash(tokenHash) {
      return withDbErrors(async () => {
        const [row] = await db
          .select({ session: sessions, user: users })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(eq(sessions.tokenHash, tokenHash));
        return row === undefined
          ? null
          : { session: toSession(row.session), user: toUser(row.user) };
      });
    },

    touch(id, now) {
      return withDbErrors(async () => {
        await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
      });
    },

    delete(id) {
      return withDbErrors(async () => {
        await db.delete(sessions).where(eq(sessions.id, id));
      });
    },

    deleteForUser(userId) {
      return withDbErrors(async () => {
        const rows = await db
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .returning({ id: sessions.id });
        return rows.length;
      });
    },

    deleteExpired({ now, idleBefore }) {
      return withDbErrors(async () => {
        const rows = await db
          .delete(sessions)
          .where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleBefore)))
          .returning({ id: sessions.id });
        return rows.length;
      });
    },
  };
}

/** `InvitationRepository` sobre Drizzle. */
export function createInvitationRepository(db: SchemaDatabase): InvitationRepository {
  const toInvitation = (row: typeof invitations.$inferSelect) =>
    invitationSchema.parse({
      id: row.id,
      userId: row.userId,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    });

  /** Borra el enlace sin usar del usuario e inserta el nuevo, en una transacción. */
  const issueOnce = (invitation: NewInvitation) =>
    withDbErrors(() =>
      db.transaction(async (tx) => {
        await tx
          .delete(invitations)
          .where(and(eq(invitations.userId, invitation.userId), isNull(invitations.usedAt)));
        const [row] = await tx.insert(invitations).values(invitation).returning();
        if (row === undefined) {
          throw new AppError("INVITATION_WRITE_FAILED", "No se creó el enlace");
        }
        return toInvitation(row);
      }),
    );

  return {
    async issue(invitation) {
      // Dos `issue` a la vez del mismo usuario: el segundo choca con el único parcial; se repite
      // una vez (entonces borra el del primero) y, si vuelve a chocar, es `INVITATION_CONFLICT`.
      for (let attempt = 1; ; attempt++) {
        try {
          return await issueOnce(invitation);
        } catch (error) {
          if (!isUniqueViolation(error, OPEN_INVITATION_UNIQUE)) throw error;
          if (attempt >= 2) {
            throw new AppError(
              "INVITATION_CONFLICT",
              "Otro enlace se estaba generando: vuelve a intentarlo",
              { retriable: true, cause: error },
            );
          }
        }
      }
    },

    findByTokenHash(tokenHash) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, tokenHash));
        return row === undefined ? null : toInvitation(row);
      });
    },

    consume(id, now) {
      return withDbErrors(async () => {
        const rows = await db
          .update(invitations)
          .set({ usedAt: now })
          .where(and(eq(invitations.id, id), isNull(invitations.usedAt)))
          .returning({ id: invitations.id });
        return rows.length === 1;
      });
    },
  };
}

/** `OAuthStateRepository` sobre Drizzle. */
export function createOAuthStateRepository(db: SchemaDatabase): OAuthStateRepository {
  return {
    markUsed(nonceHash, expiresAt) {
      return withDbErrors(async () => {
        const rows = await db
          .insert(oauthStatesUsed)
          .values({ nonceHash, expiresAt })
          .onConflictDoNothing()
          .returning({ nonceHash: oauthStatesUsed.nonceHash });
        return rows.length === 1;
      });
    },

    deleteExpired(now) {
      return withDbErrors(async () => {
        const rows = await db
          .delete(oauthStatesUsed)
          .where(lt(oauthStatesUsed.expiresAt, now))
          .returning({ nonceHash: oauthStatesUsed.nonceHash });
        return rows.length;
      });
    },
  };
}
