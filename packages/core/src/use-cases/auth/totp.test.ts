import { describe, expect, it } from "vitest";
import {
  createFakePasswordHasher,
  createFakeSecretBox,
  createFakeSecretTokens,
  createFakeTotpProvider,
  createInMemoryUserRepositories,
  fakeTotpCode,
  fakeTotpStep,
} from "../../testing/index.js";
import type { User } from "../../user.js";
import {
  LOGIN_CHALLENGE_TTL_MS,
  LOGIN_MAX_FAILURES,
  login,
  loginWithTotp,
  purgeExpiredAuth,
} from "./sessions.js";
import {
  confirmTotpSetup,
  disableTotp,
  otpauthUrl,
  RECOVERY_CODE_COUNT,
  startTotpSetup,
  totpStatus,
} from "./totp.js";
import { acceptInvitation, ensureAdmin, resetUserAccess } from "./users.js";

// F8-T15 (spec F8 §4.8, ADR-0026): el doble factor, el segundo paso de entrar y los códigos de
// recuperación, con dobles en memoria.

const START = new Date("2026-10-18T12:00:00Z");
const PASSWORD = "una-clave-larga-1";
const EMAIL = "vinny@ejemplo.cl";
const credentials = { email: EMAIL, password: PASSWORD, client: "panel" as const };

async function setup() {
  let now = START;
  const clock = () => now;
  const repos = createInMemoryUserRepositories({ now: clock });
  const hasher = createFakePasswordHasher();
  const tokens = createFakeSecretTokens();
  const deps = {
    ...repos,
    hasher,
    tokens,
    totp: createFakeTotpProvider(),
    totpBox: createFakeSecretBox(),
    now: clock,
  };
  const created = await repos.users.create({
    email: EMAIL,
    name: "Vinny",
    role: "admin",
    brokerId: null,
  });
  await repos.users.setPassword(created.id, await hasher.hash(PASSWORD));
  const session = await repos.sessions.create({
    userId: created.id,
    tokenHash: "sha:propia",
    client: "panel",
    expiresAt: new Date(START.getTime() + 3_600_000),
    now: START,
  });
  const user = async () => (await repos.users.get(created.id)) as User;
  /** El código de la app ahora (o `offset` pasos de 30 s después). */
  const code = (offset = 0) => fakeTotpCode(fakeTotpStep(now) + offset);
  /** Activa el doble factor con el código de ahora y devuelve los códigos de recuperación. */
  const enable = async () => {
    await startTotpSetup(deps, { user: await user() });
    return (
      await confirmTotpSetup(deps, { user: await user(), code: code(), keepSessionId: session.id })
    ).recoveryCodes;
  };
  return {
    deps,
    repos,
    session,
    user,
    code,
    enable,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("no falló");
};

describe("activar el doble factor", () => {
  it("la clave y el enlace otpauth; la clave se guarda cifrada y todavía no está activo", async () => {
    const s = await setup();
    const setupResult = await startTotpSetup(s.deps, { user: await s.user() });

    expect(setupResult.secret).toBe("CLAVEA");
    expect(setupResult.otpauthUrl).toBe(
      "otpauth://totp/AgentSales%3Avinny%40ejemplo.cl?secret=CLAVEA&issuer=AgentSales&algorithm=SHA1&digits=6&period=30",
    );
    const stored = await s.repos.users.findTotp((await s.user()).id);
    expect(stored?.secretEncrypted).not.toBe("CLAVEA");
    expect(stored?.secretEncrypted).toContain("totp:");
    expect((await s.user()).totpEnabledAt).toBeNull();
  });

  it("confirmar con un código lo activa, entrega 10 códigos una vez y cierra las demás sesiones", async () => {
    const s = await setup();
    const other = await s.repos.sessions.create({
      userId: s.session.userId,
      tokenHash: "sha:otra",
      client: "cli",
      expiresAt: new Date(START.getTime() + 3_600_000),
      now: START,
    });

    const codes = await s.enable();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect((await s.user()).totpEnabledAt).toEqual(START);
    // Solo los hashes, nunca el código.
    const stored = s.repos.recoveryCodes(s.session.userId);
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    expect(JSON.stringify(stored)).not.toContain(codes[0]);
    const ids = s.repos.sessions.all().map((session) => session.id);
    expect(ids).toContain(s.session.id);
    expect(ids).not.toContain(other.id);
    expect(await totpStatus(s.deps, { user: await s.user() })).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
  });

  it("un código equivocado no lo activa; sin empezar o ya activo, se rechaza", async () => {
    const s = await setup();
    expect(
      await caught(
        confirmTotpSetup(s.deps, { user: await s.user(), code: s.code(), keepSessionId: "x" }),
      ),
    ).toMatchObject({ code: "TOTP_NOT_STARTED" });
    await startTotpSetup(s.deps, { user: await s.user() });
    expect(
      await caught(
        confirmTotpSetup(s.deps, { user: await s.user(), code: s.code(5), keepSessionId: "x" }),
      ),
    ).toMatchObject({ code: "TOTP_CODE_INVALID" });
    expect((await s.user()).totpEnabledAt).toBeNull();

    await confirmTotpSetup(s.deps, { user: await s.user(), code: s.code(), keepSessionId: "x" });
    expect(await caught(startTotpSetup(s.deps, { user: await s.user() }))).toMatchObject({
      code: "TOTP_ALREADY_ENABLED",
    });
  });
});

describe("entrar en dos pasos", () => {
  it("con el doble factor, la contraseña da un desafío; el código abre la sesión", async () => {
    const s = await setup();
    await s.enable();
    s.advance(60_000);

    const first = await login(s.deps, credentials);
    expect(first).toEqual({
      kind: "totp_required",
      challenge: expect.any(String),
      expiresAt: new Date(START.getTime() + 60_000 + LOGIN_CHALLENGE_TTL_MS),
    });
    if (first.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
    // La base guarda solo el hash del desafío.
    expect(JSON.stringify(s.repos.loginChallenges.all())).not.toContain(first.challenge);

    const opened = await loginWithTotp(s.deps, {
      challenge: first.challenge,
      code: s.code(),
      client: "panel",
    });
    expect(opened.user.id).toBe(s.session.userId);
    expect(opened.user.lastLoginAt).toEqual(new Date(START.getTime() + 60_000));
  });

  it("acepta ±30 s; un código repetido o anterior se rechaza", async () => {
    const s = await setup();
    await s.enable();
    s.advance(60_000);
    const enter = async (code: string) => {
      const step = await login(s.deps, credentials);
      if (step.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
      return loginWithTotp(s.deps, { challenge: step.challenge, code, client: "cli" });
    };

    const previous = s.code(-1);
    await expect(enter(previous)).resolves.toMatchObject({ user: { email: EMAIL } });
    expect(await caught(enter(previous))).toMatchObject({ code: "TOTP_CODE_INVALID" });
    await expect(enter(s.code(1))).resolves.toMatchObject({ user: { email: EMAIL } });
    expect(await caught(enter(s.code()))).toMatchObject({ code: "TOTP_CODE_INVALID" });
    expect(await caught(enter(s.code(3)))).toMatchObject({ code: "TOTP_CODE_INVALID" });
  });

  it("el desafío vencido, usado o inventado no sirve", async () => {
    const s = await setup();
    await s.enable();
    s.advance(60_000);
    const step = await login(s.deps, credentials);
    if (step.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
    await loginWithTotp(s.deps, { challenge: step.challenge, code: s.code(), client: "cli" });

    expect(
      await caught(
        loginWithTotp(s.deps, { challenge: step.challenge, code: s.code(1), client: "cli" }),
      ),
    ).toMatchObject({ code: "LOGIN_CHALLENGE_INVALID" });
    expect(
      await caught(
        loginWithTotp(s.deps, { challenge: "inventado", code: s.code(), client: "cli" }),
      ),
    ).toMatchObject({ code: "LOGIN_CHALLENGE_INVALID" });

    const late = await login(s.deps, credentials);
    if (late.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
    s.advance(LOGIN_CHALLENGE_TTL_MS);
    expect(
      await caught(
        loginWithTotp(s.deps, { challenge: late.challenge, code: s.code(), client: "cli" }),
      ),
    ).toMatchObject({ code: "LOGIN_CHALLENGE_INVALID" });
    // La vigilancia borra los vencidos.
    s.advance(1);
    expect(
      (
        await purgeExpiredAuth(
          s.repos,
          new Date(START.getTime() + 60_000 + LOGIN_CHALLENGE_TTL_MS + 1),
        )
      ).loginChallenges,
    ).toBeGreaterThanOrEqual(1);
  });

  it("un código mal escrito se corrige con el mismo desafío, y cada fallo cuenta para el bloqueo", async () => {
    const s = await setup();
    await s.enable();
    s.advance(60_000);
    const step = await login(s.deps, credentials);
    if (step.kind !== "totp_required") throw new Error("se esperaba el segundo paso");

    for (let attempt = 1; attempt < LOGIN_MAX_FAILURES; attempt += 1) {
      expect(
        await caught(
          loginWithTotp(s.deps, { challenge: step.challenge, code: "000000", client: "cli" }),
        ),
      ).toMatchObject({ code: "TOTP_CODE_INVALID" });
    }
    expect((await s.user()).failedLogins).toBe(LOGIN_MAX_FAILURES - 1);
    await caught(
      loginWithTotp(s.deps, { challenge: step.challenge, code: "000000", client: "cli" }),
    );
    expect((await s.user()).lockedUntil).not.toBeNull();
    // Bloqueado: ni el código bueno entra.
    expect(
      await caught(
        loginWithTotp(s.deps, { challenge: step.challenge, code: s.code(), client: "cli" }),
      ),
    ).toMatchObject({ code: "AUTH_LOCKED" });
  });

  it("un código de recuperación sirve una vez, con o sin guiones", async () => {
    const s = await setup();
    const codes = await s.enable();
    const recovery = codes[0] ?? "";
    const enter = async (code: string) => {
      const step = await login(s.deps, credentials);
      if (step.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
      return loginWithTotp(s.deps, { challenge: step.challenge, code, client: "panel" });
    };

    await expect(enter(recovery.toLowerCase().replaceAll("-", " "))).resolves.toMatchObject({
      user: { email: EMAIL },
    });
    expect(await caught(enter(recovery))).toMatchObject({ code: "TOTP_CODE_INVALID" });
    expect(await totpStatus(s.deps, { user: await s.user() })).toEqual({
      enabled: true,
      recoveryCodesLeft: 9,
    });
  });

  it("la clave nunca sale en un error (tampoco si no se puede abrir)", async () => {
    const s = await setup();
    await s.enable();
    const step = await login(s.deps, credentials);
    if (step.kind !== "totp_required") throw new Error("se esperaba el segundo paso");
    // Otra clave de cifrado: la guardada no se abre.
    const broken = {
      ...s.deps,
      totpBox: {
        ...createFakeSecretBox(),
        decrypt: () => {
          throw new Error("CLAVEA no se pudo abrir");
        },
      },
    };
    const error = await caught(
      loginWithTotp(broken, { challenge: step.challenge, code: s.code(), client: "cli" }),
    );
    expect(error).toMatchObject({ code: "TOTP_UNREADABLE" });
    expect(JSON.stringify(error)).not.toContain("CLAVEA");
    expect(String((error as Error).message)).not.toContain("CLAVEA");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("desactivar y restablecer", () => {
  it("desactivar pide un código (de la app o de recuperación) y cierra las demás sesiones", async () => {
    const s = await setup();
    const codes = await s.enable();
    expect(
      await caught(
        disableTotp(s.deps, { user: await s.user(), code: "000000", keepSessionId: s.session.id }),
      ),
    ).toMatchObject({ code: "TOTP_CODE_INVALID" });

    const user = await disableTotp(s.deps, {
      user: await s.user(),
      code: codes[1] ?? "",
      keepSessionId: s.session.id,
    });
    expect(user.totpEnabledAt).toBeNull();
    expect(s.repos.recoveryCodes(user.id)).toEqual([]);
    expect(
      await caught(disableTotp(s.deps, { user, code: s.code(), keepSessionId: s.session.id })),
    ).toMatchObject({ code: "TOTP_NOT_ENABLED" });
    // Sin doble factor, la contraseña vuelve a abrir la sesión directo.
    expect((await login(s.deps, credentials)).kind).toBe("session");
  });

  it("pnpm auth:admin (ensureAdmin) le quita el doble factor al usar el enlace, no antes", async () => {
    const s = await setup();
    await s.enable();

    const link = await ensureAdmin(s.deps, { email: EMAIL });
    // Mientras el enlace no se usa, la contraseña sola no entra.
    expect((await s.user()).totpEnabledAt).not.toBeNull();
    expect((await login(s.deps, credentials)).kind).toBe("totp_required");

    await acceptInvitation(
      { ...s.deps, brokers: { findById: async () => null } },
      {
        token: link.token,
        password: "otra-clave-larga-2",
        client: "panel",
      },
    );
    expect((await s.user()).totpEnabledAt).toBeNull();
    expect(s.repos.recoveryCodes(s.session.userId)).toEqual([]);
  });

  it("restablecer a un usuario también le quita el doble factor, al usar el enlace", async () => {
    const s = await setup();
    await s.enable();
    const actor = await s.user();
    const deps = { ...s.deps, brokers: { findById: async () => null } };

    const link = await resetUserAccess(deps, { actor, userId: actor.id });
    expect((await s.user()).totpEnabledAt).not.toBeNull();

    await acceptInvitation(deps, {
      token: link.token,
      password: "otra-clave-larga-2",
      client: "cli",
    });
    expect((await s.user()).totpEnabledAt).toBeNull();
    expect(s.repos.recoveryCodes(actor.id)).toEqual([]);
  });

  it("desactivar con un código malo cuenta para el bloqueo; bloqueado, ni el bueno sirve", async () => {
    const s = await setup();
    await s.enable();
    s.advance(60_000);
    const attempt = async (code: string) =>
      caught(disableTotp(s.deps, { user: await s.user(), code, keepSessionId: s.session.id }));

    for (let n = 0; n < LOGIN_MAX_FAILURES; n += 1) {
      expect(await attempt("000000")).toMatchObject({ code: "TOTP_CODE_INVALID" });
    }
    expect((await s.user()).lockedUntil).not.toBeNull();
    expect(await attempt(s.code())).toMatchObject({ code: "AUTH_LOCKED" });
    expect((await s.user()).totpEnabledAt).not.toBeNull();
  });

  it("si otro setup cambió la clave mientras se confirmaba, la confirmación no la activa", async () => {
    const s = await setup();
    await startTotpSetup(s.deps, { user: await s.user() });
    const stale = { ...s.deps.users };
    // Entre leer la clave y activarla, otro pedido pidió una clave nueva.
    const users = {
      ...stale,
      findTotp: async (id: string) => {
        const found = await s.repos.users.findTotp(id);
        await startTotpSetup(s.deps, { user: await s.user() });
        return found;
      },
    };
    expect(
      await caught(
        confirmTotpSetup(
          { ...s.deps, users },
          { user: await s.user(), code: s.code(), keepSessionId: s.session.id },
        ),
      ),
    ).toMatchObject({ code: "TOTP_NOT_STARTED" });
    expect((await s.user()).totpEnabledAt).toBeNull();
  });

  it("otpauthUrl escapa el correo y el emisor", () => {
    expect(otpauthUrl("a+b@x.cl", "ABC")).toBe(
      "otpauth://totp/AgentSales%3Aa%2Bb%40x.cl?secret=ABC&issuer=AgentSales&algorithm=SHA1&digits=6&period=30",
    );
  });
});
