import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { linkedinAccountMetaSchema } from "../linkedin.js";
import type { LinkedInAuth, LinkedInMember } from "../ports/linkedin-auth.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "../testing/index.js";
import { connectLinkedInAccount, setAccountMode } from "./connect-linkedin-account.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const CODE = "AQT-codigo-de-prueba";
const ACCESS = "AQV-acceso-de-prueba-linkedin";

type FakeOptions = {
  scopes?: string[] | null;
  member?: Partial<LinkedInMember>;
  error?: AppError;
};

/** LinkedIn falso: canjea el código y responde `/v2/userinfo`, y registra las llamadas. */
function fakeLinkedIn(options: FakeOptions = {}) {
  const calls: string[] = [];
  const linkedin: Pick<LinkedInAuth, "exchangeCode" | "me"> = {
    async exchangeCode(code) {
      calls.push(`exchange:${code}`);
      if (options.error) throw options.error;
      return {
        accessToken: ACCESS,
        expiresAt: new Date(NOW.getTime() + 60 * DAY),
        scopes:
          options.scopes === undefined ? ["openid", "profile", "w_member_social"] : options.scopes,
      };
    },
    async me(accessToken) {
      calls.push(`me:${accessToken}`);
      return { memberId: "abc-DEF_123", name: "Vicente Wolde", ...options.member };
    },
  };
  return { linkedin, calls };
}

function setup(options: FakeOptions = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { linkedin, calls } = fakeLinkedIn(options);
  const deps = { brokers, platformAccounts, linkedin, now: () => NOW };
  return { broker, platformAccounts, calls, deps };
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error as AppError).code,
  );

describe("connectLinkedInAccount", () => {
  it("conecta en modo manual: el token cifrado, el miembro como cuenta externa y 60 días", async () => {
    const { broker, platformAccounts, calls, deps } = setup();

    const account = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });

    expect(calls).toEqual([`exchange:${CODE}`, `me:${ACCESS}`]);
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "linkedin",
      externalAccountId: "abc-DEF_123",
      displayName: "Vicente Wolde",
      status: "connected",
      tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
      hasCredentials: true,
    });
    expect(linkedinAccountMetaSchema.parse(account.meta)).toEqual({
      mode: "manual",
      scopes: ["openid", "profile", "w_member_social"],
      connectedAt: NOW.toISOString(),
    });
    expect(await platformAccounts.getCredentials(account.id)).toEqual({ accessToken: ACCESS });
  });

  it("sin w_member_social en los permisos informados: LINKEDIN_PERMISSION_DENIED sin guardar", async () => {
    const { broker, platformAccounts, calls, deps } = setup({ scopes: ["openid", "profile"] });
    expect(await codeOf(connectLinkedInAccount(deps, { broker: broker.slug, code: CODE }))).toBe(
      "LINKEDIN_PERMISSION_DENIED",
    );
    expect(calls).toEqual([`exchange:${CODE}`]);
    expect(await platformAccounts.listByBroker(broker.id)).toEqual([]);
  });

  it("sin permisos informados (null) conecta igual: el permiso lo prueba la primera publicación", async () => {
    const { broker, deps } = setup({ scopes: null });
    const account = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });
    expect(account.meta).toMatchObject({ mode: "manual", scopes: null });
  });

  it("un miembro sin forma de id es LINKEDIN_UNEXPECTED_RESPONSE", async () => {
    const { broker, deps } = setup({ member: { memberId: "a b/c" } });
    expect(await codeOf(connectLinkedInAccount(deps, { broker: broker.slug, code: CODE }))).toBe(
      "LINKEDIN_UNEXPECTED_RESPONSE",
    );
  });

  it("un corredor que no existe es BROKER_NOT_FOUND sin llamar a LinkedIn", async () => {
    const { calls, deps } = setup();
    expect(await codeOf(connectLinkedInAccount(deps, { broker: "otro", code: CODE }))).toBe(
      "BROKER_NOT_FOUND",
    );
    expect(calls).toEqual([]);
  });

  it("los errores de LinkedIn pasan tal cual, sin el código ni el token", async () => {
    const { broker, deps } = setup({
      error: new AppError("LINKEDIN_AUTH_INVALID", "LinkedIn no aceptó el código"),
    });
    const error = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE }).catch(
      (caught: unknown) => caught as AppError,
    );
    expect(error).toMatchObject({ code: "LINKEDIN_AUTH_INVALID" });
    expect(
      JSON.stringify({ m: (error as AppError).message, d: (error as AppError).details }),
    ).not.toMatch(/AQT-|AQV-/);
  });

  it("reconectar el mismo perfil que el administrador pasó a api conserva api; otro perfil vuelve a manual", async () => {
    const { broker, platformAccounts, deps } = setup();
    const first = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });
    await setAccountMode({ platformAccounts }, { accountId: first.id, mode: "api" });

    const again = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });
    expect(again.id).toBe(first.id);
    expect(again.meta.mode).toBe("api");

    const other = setup({ member: { memberId: "otro-miembro" } });
    const otherDeps = { ...other.deps, brokers: deps.brokers, platformAccounts };
    const replaced = await connectLinkedInAccount(otherDeps, { broker: broker.slug, code: CODE });
    expect(replaced.meta.mode).toBe("manual");
    expect((await platformAccounts.get(first.id))?.status).toBe("revoked");
  });

  it("un perfil desconectado que se reconecta vuelve a manual", async () => {
    const { broker, platformAccounts, deps } = setup();
    const first = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });
    await setAccountMode({ platformAccounts }, { accountId: first.id, mode: "api" });
    await platformAccounts.disconnect(first.id);
    const again = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });
    expect(again.meta.mode).toBe("manual");
  });
});

describe("setAccountMode", () => {
  it("cambia el modo de una cuenta de LinkedIn y dice si cambió", async () => {
    const { broker, platformAccounts, deps } = setup();
    const account = await connectLinkedInAccount(deps, { broker: broker.slug, code: CODE });

    const same = await setAccountMode(
      { platformAccounts },
      { accountId: account.id, mode: "manual" },
    );
    expect(same.changed).toBe(false);

    const api = await setAccountMode({ platformAccounts }, { accountId: account.id, mode: "api" });
    expect(api).toMatchObject({ changed: true, account: { meta: { mode: "api" } } });
    // El resto de la meta queda igual.
    expect(api.account.meta).toMatchObject({ connectedAt: NOW.toISOString() });
  });

  it("una cuenta que no existe es ACCOUNT_NOT_FOUND; una de Instagram, ACCOUNT_MODE_NOT_SUPPORTED", async () => {
    const { broker, platformAccounts } = setup();
    expect(
      await codeOf(setAccountMode({ platformAccounts }, { accountId: "nada", mode: "api" })),
    ).toBe("ACCOUNT_NOT_FOUND");
    const instagram = await platformAccounts.upsertConnected(
      {
        brokerId: broker.id,
        platform: "instagram",
        externalAccountId: "1",
        displayName: "@x",
        tokenExpiresAt: null,
        meta: {},
        credentials: { accessToken: "token-de-prueba" },
      },
      { revokeOthers: true },
    );
    expect(
      await codeOf(
        setAccountMode({ platformAccounts }, { accountId: instagram.id, mode: "manual" }),
      ),
    ).toBe("ACCOUNT_MODE_NOT_SUPPORTED");
  });
});
