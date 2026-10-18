import type {
  BrokerRepository,
  InvitationRepository,
  LoginChallengeRepository,
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
  loginChallenges: LoginChallengeRepository;
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

    // F8-T15 (spec F8 §4.8 y §4.12): el doble factor, el segundo paso y cerrar las demás sesiones.
    it("el doble factor: empezar no lo activa; activar guarda el paso y los códigos; quitarlo borra todo", async () => {
      const user = await admin();
      expect(user.totpEnabledAt).toBeNull();
      expect(await repos.users.findTotp(user.id)).toEqual({
        secretEncrypted: null,
        enabledAt: null,
        lastStep: null,
      });

      const started = await repos.users.startTotp(user.id, "sellado-1");
      expect(started?.totpEnabledAt).toBeNull();
      expect(started).not.toHaveProperty("totpSecretEncrypted");
      await repos.users.startTotp(user.id, "sellado-2");

      // Con una clave que ya no es la guardada (otro `setup` a la vez), no activa nada.
      const codes = { at: NOW, step: 100, recoveryCodeHashes: ["h1", "h2", "h3"] };
      expect(
        await repos.users.enableTotp(user.id, { ...codes, secretEncrypted: "sellado-1" }),
      ).toBeNull();
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(0);

      const enabled = await repos.users.enableTotp(user.id, {
        ...codes,
        secretEncrypted: "sellado-2",
      });
      expect(enabled?.totpEnabledAt).toEqual(NOW);
      expect(await repos.users.get(user.id)).toEqual(enabled);
      expect(await repos.users.findTotp(user.id)).toEqual({
        secretEncrypted: "sellado-2",
        enabledAt: NOW,
        lastStep: 100,
      });
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(3);
      // Ya activo: ni empezar de nuevo pisa la clave, ni activar otra vez reemplaza los códigos.
      expect(await repos.users.startTotp(user.id, "sellado-3")).toBeNull();
      expect(
        await repos.users.enableTotp(user.id, {
          secretEncrypted: "sellado-2",
          at: NOW,
          step: 101,
          recoveryCodeHashes: ["x"],
        }),
      ).toBeNull();
      expect((await repos.users.findTotp(user.id))?.secretEncrypted).toBe("sellado-2");
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(3);
      await expect(
        repos.users.startTotp("00000000-0000-4000-8000-000000000999", "x"),
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });

      const cleared = await repos.users.clearTotp(user.id);
      expect(cleared.totpEnabledAt).toBeNull();
      expect(await repos.users.findTotp(user.id)).toEqual({
        secretEncrypted: null,
        enabledAt: null,
        lastStep: null,
      });
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(0);
      await expect(
        repos.users.clearTotp("00000000-0000-4000-8000-000000000999"),
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    });

    it("un paso solo avanza: el mismo código o uno anterior no sirven otra vez", async () => {
      const user = await admin();
      await repos.users.startTotp(user.id, "sellado");
      await repos.users.enableTotp(user.id, {
        secretEncrypted: "sellado",
        at: NOW,
        step: 10,
        recoveryCodeHashes: [],
      });

      expect(await repos.users.advanceTotpStep(user.id, 10)).toBe(false);
      expect(await repos.users.advanceTotpStep(user.id, 9)).toBe(false);
      expect(await repos.users.advanceTotpStep(user.id, 11)).toBe(true);
      expect(await repos.users.advanceTotpStep(user.id, 11)).toBe(false);
      expect((await repos.users.findTotp(user.id))?.lastStep).toBe(11);
    });

    it("un código de recuperación sirve una vez, y activar de nuevo reemplaza los anteriores", async () => {
      const user = await admin();
      await repos.users.startTotp(user.id, "sellado");
      await repos.users.enableTotp(user.id, {
        secretEncrypted: "sellado",
        at: NOW,
        step: 1,
        recoveryCodeHashes: ["a", "b"],
      });

      expect(await repos.users.consumeRecoveryCode(user.id, "a", NOW)).toBe(true);
      expect(await repos.users.consumeRecoveryCode(user.id, "a", NOW)).toBe(false);
      expect(await repos.users.consumeRecoveryCode(user.id, "zzz", NOW)).toBe(false);
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(1);
      // El código de otro usuario no sirve.
      const other = await admin();
      expect(await repos.users.consumeRecoveryCode(other.id, "b", NOW)).toBe(false);

      await repos.users.clearTotp(user.id);
      await repos.users.startTotp(user.id, "sellado-nuevo");
      await repos.users.enableTotp(user.id, {
        secretEncrypted: "sellado-nuevo",
        at: NOW,
        step: 2,
        recoveryCodeHashes: ["c"],
      });
      expect(await repos.users.consumeRecoveryCode(user.id, "b", NOW)).toBe(false);
      expect(await repos.users.countRecoveryCodes(user.id)).toBe(1);
    });

    it("cierra las demás sesiones de un usuario y deja la suya", async () => {
      const user = await admin();
      const other = await admin();
      const open = (userId: string, hash: string) =>
        repos.sessions.create({
          userId,
          tokenHash: hash,
          client: "panel",
          expiresAt: later(HOUR),
          now: NOW,
        });
      const mine = await open(user.id, unique("propia"));
      const second = unique("otra");
      await open(user.id, second);
      const foreign = unique("ajena");
      await open(other.id, foreign);

      expect(await repos.sessions.deleteForUserExcept(user.id, mine.id)).toBe(1);
      expect(await repos.sessions.findByTokenHash(second)).toBeNull();
      expect(await repos.sessions.findByTokenHash(foreign)).not.toBeNull();
    });

    it("el segundo paso de entrar sirve una vez y los vencidos se borran", async () => {
      const user = await admin();
      const hash = unique("desafio");
      const created = await repos.loginChallenges.create({
        userId: user.id,
        tokenHash: hash,
        expiresAt: later(5 * 60_000),
      });
      expect(created).toMatchObject({ userId: user.id, usedAt: null });
      expect(created).not.toHaveProperty("tokenHash");
      expect(await repos.loginChallenges.findByTokenHash(hash)).toEqual(created);
      expect(await repos.loginChallenges.consume(created.id, NOW)).toBe(true);
      expect(await repos.loginChallenges.consume(created.id, NOW)).toBe(false);
      expect((await repos.loginChallenges.findByTokenHash(hash))?.usedAt).toEqual(NOW);

      const old = unique("desafio");
      await repos.loginChallenges.create({
        userId: user.id,
        tokenHash: old,
        expiresAt: later(-HOUR),
      });
      expect(await repos.loginChallenges.deleteExpired(NOW)).toBeGreaterThanOrEqual(1);
      expect(await repos.loginChallenges.findByTokenHash(old)).toBeNull();
      expect(await repos.loginChallenges.findByTokenHash(hash)).not.toBeNull();
    });
  });
}
