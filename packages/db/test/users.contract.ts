import type {
  BrokerRepository,
  InvitationRepository,
  OAuthStateRepository,
  SessionRepository,
  UserRepository,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";
import { brokerData } from "./import-repositories.contract.js";

/**
 * Suite de contrato de usuarios, sesiones, invitaciones y `state` usados (F7-T01): corre igual
 * contra los dobles en memoria y contra Drizzle sobre PGlite. Cada caso usa su propio correo: la
 * base se comparte.
 */
export type UserRepositories = {
  brokers: BrokerRepository;
  users: UserRepository;
  sessions: SessionRepository;
  invitations: InvitationRepository;
  oauthStates: OAuthStateRepository;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;
const email = () => `${unique("usuario")}@ejemplo.cl`;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-17T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

export function userRepositoryContract(name: string, make: () => Promise<UserRepositories>) {
  describe(`${name} · usuarios, sesiones e invitaciones`, () => {
    let repos: UserRepositories;
    let brokerId: string;
    beforeAll(async () => {
      repos = await make();
      brokerId = (await repos.brokers.create(brokerData(unique("usuarios")))).id;
    });

    const admin = () =>
      repos.users.create({ email: email(), name: "Vinny", role: "admin", brokerId: null });

    it("crea un usuario sin contraseña y lo encuentra por correo", async () => {
      const user = await repos.users.create({
        email: email(),
        name: "Corredora",
        role: "broker",
        brokerId,
      });
      expect(user).toMatchObject({
        role: "broker",
        brokerId,
        hasPassword: false,
        failedLogins: 0,
        lockedUntil: null,
        disabledAt: null,
      });
      expect(await repos.users.findByEmail(user.email)).toEqual(user);
      expect(await repos.users.findCredentials(user.email)).toEqual({ user, passwordHash: null });
      expect(user).not.toHaveProperty("passwordHash");
    });

    it("el correo es único: el segundo es USER_EMAIL_TAKEN", async () => {
      const first = await admin();
      await expect(
        repos.users.create({ email: first.email, name: "Otro", role: "admin", brokerId: null }),
      ).rejects.toMatchObject({ code: "USER_EMAIL_TAKEN" });
    });

    it("la base exige el correo en minúsculas y el corredor según el rol", async () => {
      await expect(
        repos.users.create({ email: "Mayus@Ejemplo.cl", name: "x", role: "admin", brokerId: null }),
      ).rejects.toThrow();
      await expect(
        repos.users.create({ email: email(), name: "x", role: "broker", brokerId: null }),
      ).rejects.toThrow();
      await expect(
        repos.users.create({ email: email(), name: "x", role: "admin", brokerId }),
      ).rejects.toThrow();
    });

    it("lista por correo y filtra por corredor", async () => {
      const mine = await repos.users.create({
        email: email(),
        name: "Del corredor",
        role: "broker",
        brokerId,
      });
      const listed = await repos.users.list({ brokerId });
      expect(listed.map((user) => user.id)).toContain(mine.id);
      expect(listed.every((user) => user.brokerId === brokerId)).toBe(true);
      const all = await repos.users.list();
      expect(all.map((user) => user.email)).toEqual([...all.map((user) => user.email)].sort());
    });

    it("los fallos suman y bloquean al llegar al tope; entrar y restablecer los limpian", async () => {
      const user = await admin();
      const policy = { now: NOW, lockAfter: 3, lockForMs: 15 * 60 * 1000 };
      expect((await repos.users.recordLoginFailure(user.id, policy)).failedLogins).toBe(1);
      expect((await repos.users.recordLoginFailure(user.id, policy)).failedLogins).toBe(2);
      const locked = await repos.users.recordLoginFailure(user.id, policy);
      expect(locked).toMatchObject({ failedLogins: 0, lockedUntil: later(15 * 60 * 1000) });
      expect(await repos.users.clearLock(user.id)).toMatchObject({
        failedLogins: 0,
        lockedUntil: null,
      });
      await repos.users.recordLoginFailure(user.id, policy);
      expect(await repos.users.recordLoginSuccess(user.id, NOW)).toMatchObject({
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: NOW,
      });
    });

    it("fijar la contraseña la deja guardada y quita el bloqueo", async () => {
      const user = await admin();
      await repos.users.recordLoginFailure(user.id, { now: NOW, lockAfter: 1, lockForMs: HOUR });
      const updated = await repos.users.setPassword(user.id, "scrypt$hash");
      expect(updated).toMatchObject({ hasPassword: true, lockedUntil: null, failedLogins: 0 });
      expect((await repos.users.findCredentials(user.email))?.passwordHash).toBe("scrypt$hash");
    });

    it("desactiva y reactiva; un id que no existe es USER_NOT_FOUND", async () => {
      const user = await admin();
      expect((await repos.users.setDisabled(user.id, NOW)).disabledAt).toEqual(NOW);
      expect((await repos.users.setDisabled(user.id, null)).disabledAt).toBeNull();
      const missing = "00000000-0000-0000-0000-000000000000";
      await expect(repos.users.setDisabled(missing, NOW)).rejects.toMatchObject({
        code: "USER_NOT_FOUND",
      });
    });

    it("la sesión se encuentra por el hash de su token, con su usuario", async () => {
      const user = await admin();
      const tokenHash = unique("hash");
      const session = await repos.sessions.create({
        userId: user.id,
        tokenHash,
        client: "panel",
        expiresAt: later(30 * 24 * HOUR),
        now: NOW,
      });
      expect(session).toMatchObject({ userId: user.id, client: "panel", lastSeenAt: NOW });
      expect(session).not.toHaveProperty("tokenHash");
      const found = await repos.sessions.findByTokenHash(tokenHash);
      expect(found).toEqual({ session, user });
      expect(await repos.sessions.findByTokenHash(unique("otro"))).toBeNull();

      await repos.sessions.touch(session.id, later(HOUR));
      expect((await repos.sessions.findByTokenHash(tokenHash))?.session.lastSeenAt).toEqual(
        later(HOUR),
      );
      await repos.sessions.delete(session.id);
      expect(await repos.sessions.findByTokenHash(tokenHash)).toBeNull();
    });

    it("cierra todas las sesiones de un usuario y borra las vencidas o sin uso", async () => {
      const user = await admin();
      const open = (hash: string, expiresAt: Date, now = NOW) =>
        repos.sessions.create({ userId: user.id, tokenHash: hash, client: "cli", expiresAt, now });
      await open(unique("a"), later(HOUR));
      await open(unique("b"), later(HOUR));
      expect(await repos.sessions.deleteForUser(user.id)).toBe(2);

      const expired = unique("vencida");
      const idle = unique("inactiva");
      const fresh = unique("vigente");
      await open(expired, later(-HOUR));
      await open(idle, later(HOUR), later(-10 * 24 * HOUR));
      await open(fresh, later(HOUR));
      await repos.sessions.deleteExpired({ now: NOW, idleBefore: later(-7 * 24 * HOUR) });
      expect(await repos.sessions.findByTokenHash(expired)).toBeNull();
      expect(await repos.sessions.findByTokenHash(idle)).toBeNull();
      expect(await repos.sessions.findByTokenHash(fresh)).not.toBeNull();
    });

    it("una invitación vigente por usuario, que se usa una sola vez", async () => {
      const user = await admin();
      const first = unique("inv");
      const issued = await repos.invitations.issue({
        userId: user.id,
        tokenHash: first,
        purpose: "invite",
        expiresAt: later(72 * HOUR),
        createdBy: null,
      });
      expect(issued).toMatchObject({ userId: user.id, purpose: "invite", usedAt: null });
      expect(await repos.invitations.findByTokenHash(first)).toEqual(issued);

      // La nueva reemplaza a la anterior sin usar.
      const second = unique("inv");
      const replacement = await repos.invitations.issue({
        userId: user.id,
        tokenHash: second,
        purpose: "reset",
        expiresAt: later(72 * HOUR),
        createdBy: user.id,
      });
      expect(await repos.invitations.findByTokenHash(first)).toBeNull();
      expect(replacement.createdBy).toBe(user.id);

      expect(await repos.invitations.consume(replacement.id, NOW)).toBe(true);
      expect(await repos.invitations.consume(replacement.id, NOW)).toBe(false);
      expect((await repos.invitations.findByTokenHash(second))?.usedAt).toEqual(NOW);

      // Una usada no impide emitir otra.
      await repos.invitations.issue({
        userId: user.id,
        tokenHash: unique("inv"),
        purpose: "reset",
        expiresAt: later(HOUR),
        createdBy: null,
      });
      expect((await repos.invitations.findByTokenHash(second))?.usedAt).toEqual(NOW);
    });

    it("un `state` sirve una vez y los vencidos se borran", async () => {
      const nonce = unique("nonce");
      expect(await repos.oauthStates.markUsed(nonce, later(HOUR))).toBe(true);
      expect(await repos.oauthStates.markUsed(nonce, later(HOUR))).toBe(false);
      const old = unique("nonce");
      await repos.oauthStates.markUsed(old, later(-HOUR));
      expect(await repos.oauthStates.deleteExpired(NOW)).toBeGreaterThanOrEqual(1);
      expect(await repos.oauthStates.markUsed(old, later(HOUR))).toBe(true);
      expect(await repos.oauthStates.markUsed(nonce, later(HOUR))).toBe(false);
    });
  });
}
