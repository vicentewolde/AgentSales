import { describe, expect, it } from "vitest";
import {
  createFakePasswordHasher,
  createFakeSecretTokens,
  createInMemoryBrokerRepository,
  createInMemoryUserRepositories,
} from "../../testing/index.js";
import type { User } from "../../user.js";
import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  login,
  logout,
  resolveSession,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
} from "./sessions.js";
import {
  acceptInvitation,
  INVITATION_TTL_MS,
  inviteUser,
  resetUserAccess,
  setUserDisabled,
} from "./users.js";

// F7-T03 (spec F7 §4.2): entrar, la sesión, invitar, aceptar, restablecer y desactivar.

const START = new Date("2026-10-17T12:00:00Z");
const PASSWORD = "una-clave-larga-1";

async function setup() {
  let now = START;
  const clock = () => now;
  const repos = createInMemoryUserRepositories({ now: clock });
  const brokers = createInMemoryBrokerRepository();
  const broker = await brokers.create({
    slug: "corredor",
    name: "Corredor",
    brandName: "Corredor",
    primaryColor: "#112233",
    secondaryColor: "#112233",
    whatsapp: null,
    email: null,
    instagramHandle: null,
    website: null,
    tone: null,
    fixedHashtags: [],
  });
  const hasher = createFakePasswordHasher();
  const tokens = createFakeSecretTokens();
  const deps = { ...repos, brokers, hasher, tokens, now: clock };
  // El primer administrador, con contraseña.
  const admin = await repos.users.create({
    email: "vinny@ejemplo.cl",
    name: "Vinny",
    role: "admin",
    brokerId: null,
  });
  await repos.users.setPassword(admin.id, await hasher.hash(PASSWORD));
  return {
    ...deps,
    admin: (await repos.users.get(admin.id)) as User,
    broker,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("entrar", () => {
  it("con correo y contraseña abre una sesión; el correo no distingue mayúsculas", async () => {
    const s = await setup();
    const opened = await login(s, {
      email: " VINNY@ejemplo.cl ",
      password: PASSWORD,
      client: "cli",
    });
    expect(opened.user).toMatchObject({ id: s.admin.id, lastLoginAt: START, failedLogins: 0 });
    expect(opened.token).toBe("token-1");
    expect(opened.session).toMatchObject({
      client: "cli",
      expiresAt: new Date(START.getTime() + SESSION_TTL_MS),
    });
    expect(s.sessions.all()).toHaveLength(1);
  });

  it("mal: el mismo error con un correo inexistente (y el mismo trabajo de hash)", async () => {
    const s = await setup();
    await expect(
      login(s, { email: "vinny@ejemplo.cl", password: "otra-clave-larga", client: "panel" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
    const before = s.hasher.dummyVerifications();
    await expect(
      login(s, { email: "nadie@ejemplo.cl", password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({
      code: "AUTH_INVALID",
      message: "El correo o la contraseña no son correctos",
    });
    expect(s.hasher.dummyVerifications()).toBe(before + 1);
    expect((await s.users.get(s.admin.id))?.failedLogins).toBe(1);
    expect(s.sessions.all()).toHaveLength(0);
  });

  it("se bloquea a los 10 fallos seguidos y se desbloquea a los 15 minutos", async () => {
    const s = await setup();
    const wrong = { email: s.admin.email, password: "equivocada-larga", client: "panel" as const };
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      await expect(login(s, wrong)).rejects.toMatchObject({ code: "AUTH_INVALID" });
    }
    // Bloqueado: ni la contraseña correcta entra.
    await expect(login(s, { ...wrong, password: PASSWORD })).rejects.toMatchObject({
      code: "AUTH_LOCKED",
    });
    s.advance(LOGIN_LOCK_MS);
    const opened = await login(s, { ...wrong, password: PASSWORD });
    expect(opened.user).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it("un usuario desactivado o sin contraseña no entra, con el mismo error", async () => {
    const s = await setup();
    await s.users.setDisabled(s.admin.id, START);
    await expect(
      login(s, { email: s.admin.email, password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });

    const invited = await inviteUser(s, {
      actor: (await s.users.get(s.admin.id)) as User,
      email: "nueva@ejemplo.cl",
      name: "Nueva",
      role: "broker",
      brokerId: s.broker.id,
    });
    await expect(
      login(s, { email: invited.user.email, password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
  });

  it("una contraseña desmedida no se hashea y responde igual", async () => {
    const s = await setup();
    await expect(
      login(s, { email: s.admin.email, password: "x".repeat(10_000), client: "panel" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
  });
});

describe("la sesión de cada pedido", () => {
  it("vale con su token; anota el uso a lo más una vez por minuto", async () => {
    const s = await setup();
    const { token, session } = await login(s, {
      email: s.admin.email,
      password: PASSWORD,
      client: "panel",
    });
    s.advance(SESSION_TOUCH_MS - 1);
    expect((await resolveSession(s, token))?.session.lastSeenAt).toEqual(START);
    s.advance(1);
    const touched = await resolveSession(s, token);
    expect(touched?.session.lastSeenAt).toEqual(new Date(START.getTime() + SESSION_TOUCH_MS));
    expect(touched?.user.id).toBe(s.admin.id);
    expect(s.sessions.all()[0]?.lastSeenAt).toEqual(touched?.session.lastSeenAt);
    expect(session.id).toBe(touched?.session.id);
  });

  it("un token desconocido, vacío o desmedido no es sesión", async () => {
    const s = await setup();
    expect(await resolveSession(s, "token-99")).toBeNull();
    expect(await resolveSession(s, "")).toBeNull();
    expect(await resolveSession(s, "x".repeat(1000))).toBeNull();
  });

  it("vence a los 30 días aunque se use, y tras 7 días sin uso; las dos se borran", async () => {
    const s = await setup();
    const credentials = { email: s.admin.email, password: PASSWORD, client: "panel" as const };
    const first = await login(s, credentials);
    for (let day = 0; day < 30; day += 6) {
      s.advance(6 * 24 * 60 * 60 * 1000);
      await resolveSession(s, first.token);
    }
    expect(await resolveSession(s, first.token)).toBeNull();

    const idle = await login(s, credentials);
    s.advance(SESSION_IDLE_MS);
    expect(await resolveSession(s, idle.token)).toBeNull();
    expect(s.sessions.all()).toHaveLength(0);
  });

  it("la de un usuario desactivado ya no vale", async () => {
    const s = await setup();
    const { token } = await login(s, {
      email: s.admin.email,
      password: PASSWORD,
      client: "panel",
    });
    await s.users.setDisabled(s.admin.id, START);
    expect(await resolveSession(s, token)).toBeNull();
  });

  it("salir la borra; salir con un token desconocido no hace nada", async () => {
    const s = await setup();
    const { token } = await login(s, {
      email: s.admin.email,
      password: PASSWORD,
      client: "panel",
    });
    await logout(s, "token-99");
    expect(s.sessions.all()).toHaveLength(1);
    await logout(s, token);
    expect(await resolveSession(s, token)).toBeNull();
  });
});

describe("invitar y aceptar", () => {
  it("el administrador invita a un corredor; el enlace fija la contraseña y abre la sesión", async () => {
    const s = await setup();
    const issued = await inviteUser(s, {
      actor: s.admin,
      email: " Corredora@Ejemplo.cl",
      name: "  Corredora ",
      role: "broker",
      brokerId: s.broker.id,
    });
    expect(issued.user).toMatchObject({
      email: "corredora@ejemplo.cl",
      name: "Corredora",
      role: "broker",
      brokerId: s.broker.id,
      hasPassword: false,
    });
    expect(issued.expiresAt).toEqual(new Date(START.getTime() + INVITATION_TTL_MS));
    expect(s.invitations.all()[0]).toMatchObject({ purpose: "invite", createdBy: s.admin.id });

    const opened = await acceptInvitation(s, {
      token: issued.token,
      password: PASSWORD,
      client: "panel",
    });
    expect(opened.user).toMatchObject({ id: issued.user.id, hasPassword: true });
    await expect(
      login(s, { email: issued.user.email, password: PASSWORD, client: "cli" }),
    ).resolves.toMatchObject({ user: { id: issued.user.id } });
  });

  it("el enlace sirve una vez y vence a las 72 h; uno nuevo reemplaza al anterior", async () => {
    const s = await setup();
    const input = {
      actor: s.admin,
      email: "dos@ejemplo.cl",
      name: "Dos",
      role: "broker" as const,
      brokerId: s.broker.id,
    };
    const issued = await inviteUser(s, input);
    await acceptInvitation(s, { token: issued.token, password: PASSWORD, client: "panel" });
    await expect(
      acceptInvitation(s, { token: issued.token, password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });

    const reset = await resetUserAccess(s, { actor: s.admin, userId: issued.user.id });
    s.advance(INVITATION_TTL_MS);
    await expect(
      acceptInvitation(s, { token: reset.token, password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });

    const old = await resetUserAccess(s, { actor: s.admin, userId: issued.user.id });
    const fresh = await resetUserAccess(s, { actor: s.admin, userId: issued.user.id });
    await expect(
      acceptInvitation(s, { token: old.token, password: PASSWORD, client: "panel" }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await expect(
      acceptInvitation(s, { token: fresh.token, password: PASSWORD, client: "panel" }),
    ).resolves.toBeDefined();
  });

  it("una contraseña corta o desmedida no gasta el enlace", async () => {
    const s = await setup();
    const issued = await inviteUser(s, {
      actor: s.admin,
      email: "tres@ejemplo.cl",
      name: "Tres",
      role: "admin",
      brokerId: null,
    });
    await expect(
      acceptInvitation(s, { token: issued.token, password: "corta", client: "panel" }),
    ).rejects.toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    await expect(
      acceptInvitation(s, { token: issued.token, password: "x".repeat(129), client: "panel" }),
    ).rejects.toMatchObject({ code: "PASSWORD_TOO_LONG" });
    await expect(
      acceptInvitation(s, { token: issued.token, password: PASSWORD, client: "panel" }),
    ).resolves.toBeDefined();
  });

  it("valida el correo, el nombre y el corredor según el rol", async () => {
    const s = await setup();
    const base = { actor: s.admin, email: "x@ejemplo.cl", name: "X" };
    await expect(
      inviteUser(s, { ...base, email: "sin-arroba", role: "admin", brokerId: null }),
    ).rejects.toMatchObject({ code: "USER_INVALID" });
    await expect(
      inviteUser(s, { ...base, name: "  ", role: "admin", brokerId: null }),
    ).rejects.toMatchObject({ code: "USER_INVALID" });
    await expect(
      inviteUser(s, { ...base, role: "admin", brokerId: s.broker.id }),
    ).rejects.toMatchObject({ code: "USER_INVALID" });
    await expect(inviteUser(s, { ...base, role: "broker", brokerId: null })).rejects.toMatchObject({
      code: "USER_INVALID",
    });
    await expect(
      inviteUser(s, { ...base, role: "broker", brokerId: "no-existe" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    await expect(
      inviteUser(s, { ...base, email: s.admin.email, role: "admin", brokerId: null }),
    ).rejects.toMatchObject({ code: "USER_EMAIL_TAKEN" });
  });

  it("solo el administrador invita, restablece y desactiva (FORBIDDEN)", async () => {
    const s = await setup();
    const issued = await inviteUser(s, {
      actor: s.admin,
      email: "corredor@ejemplo.cl",
      name: "Corredor",
      role: "broker",
      brokerId: s.broker.id,
    });
    const broker = issued.user;
    await expect(
      inviteUser(s, {
        actor: broker,
        email: "otro@ejemplo.cl",
        name: "Otro",
        role: "broker",
        brokerId: s.broker.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resetUserAccess(s, { actor: broker, userId: s.admin.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      setUserDisabled(s, { actor: broker, userId: s.admin.id, disabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("restablecer y desactivar", () => {
  it("restablecer cierra las sesiones y quita el bloqueo", async () => {
    const s = await setup();
    const { token } = await login(s, {
      email: s.admin.email,
      password: PASSWORD,
      client: "panel",
    });
    const other = await inviteUser(s, {
      actor: s.admin,
      email: "bloqueado@ejemplo.cl",
      name: "B",
      role: "admin",
      brokerId: null,
    });
    await s.users.recordLoginFailure(other.user.id, { now: START, lockAfter: 1, lockForMs: 1000 });
    const reset = await resetUserAccess(s, { actor: s.admin, userId: other.user.id });
    expect(reset.user).toMatchObject({ lockedUntil: null, failedLogins: 0 });
    expect(s.invitations.all().at(-1)).toMatchObject({ purpose: "reset" });
    // Restablecer cierra todas las sesiones del usuario, también si es uno mismo.
    const resetSelf = await resetUserAccess(s, { actor: s.admin, userId: s.admin.id });
    expect(resetSelf.user.id).toBe(s.admin.id);
    expect(await resolveSession(s, token)).toBeNull();
    await expect(resetUserAccess(s, { actor: s.admin, userId: "no-existe" })).rejects.toMatchObject(
      { code: "USER_NOT_FOUND" },
    );
  });

  it("desactivar cierra sus sesiones y reactivar lo deja entrar; nadie se desactiva a sí mismo", async () => {
    const s = await setup();
    const issued = await inviteUser(s, {
      actor: s.admin,
      email: "cuatro@ejemplo.cl",
      name: "Cuatro",
      role: "broker",
      brokerId: s.broker.id,
    });
    const { token } = await acceptInvitation(s, {
      token: issued.token,
      password: PASSWORD,
      client: "cli",
    });
    const disabled = await setUserDisabled(s, {
      actor: s.admin,
      userId: issued.user.id,
      disabled: true,
    });
    expect(disabled.disabledAt).toEqual(START);
    expect(await resolveSession(s, token)).toBeNull();
    await setUserDisabled(s, { actor: s.admin, userId: issued.user.id, disabled: false });
    await expect(
      login(s, { email: issued.user.email, password: PASSWORD, client: "cli" }),
    ).resolves.toBeDefined();
    await expect(
      setUserDisabled(s, { actor: s.admin, userId: s.admin.id, disabled: true }),
    ).rejects.toMatchObject({ code: "USER_SELF_DISABLE" });
  });
});
