import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { mercadoLibreAccountMetaSchema } from "../platform-account.js";
import type { MercadoLibreAuth, MercadoLibreUser } from "../ports/mercadolibre-auth.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "../testing/index.js";
import { connectMercadoLibreAccount } from "./connect-mercadolibre-account.js";

const NOW = new Date("2026-10-07T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CODE = "TG-codigo-de-prueba-8035443";
const ACCESS = "APP_USR-acceso-de-prueba-8035443";
const REFRESH = "TG-refresh-de-prueba-8035443";

type FakeOptions = {
  scopes?: string[];
  refreshToken?: string | null;
  exchangeUserId?: string;
  user?: Partial<MercadoLibreUser>;
  error?: AppError;
};

/** Mercado Libre falso: canjea el código y responde `/users/me`, y registra las llamadas. */
function fakeMercadoLibre(options: FakeOptions = {}) {
  const calls: string[] = [];
  const mercadoLibre: Pick<MercadoLibreAuth, "exchangeCode" | "me"> = {
    async exchangeCode(code) {
      calls.push(`exchange:${code}`);
      if (options.error) throw options.error;
      return {
        accessToken: ACCESS,
        refreshToken: options.refreshToken === undefined ? REFRESH : options.refreshToken,
        accessTokenExpiresAt: new Date(NOW.getTime() + 6 * HOUR),
        scopes: options.scopes ?? ["offline_access", "read", "write"],
        userId: options.exchangeUserId ?? "8035443",
      };
    },
    async me(accessToken) {
      calls.push(`me:${accessToken}`);
      return {
        userId: "8035443",
        nickname: "CORREDORA_PRUEBA",
        siteId: "MLC",
        userType: "normal",
        tags: ["normal"],
        ...options.user,
      };
    },
  };
  return { mercadoLibre, calls };
}

function setup(options: FakeOptions = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { mercadoLibre, calls } = fakeMercadoLibre(options);
  const deps = { brokers, platformAccounts, mercadoLibre, now: () => NOW };
  return { broker, platformAccounts, calls, deps };
}

const textOf = (error: unknown) =>
  JSON.stringify({
    message: (error as Error).message,
    details: (error as AppError).details,
  });

describe("connectMercadoLibreAccount", () => {
  it("conecta: el par cifrado, la meta de Mercado Libre y el horizonte de 6 meses (estimado)", async () => {
    const { broker, platformAccounts, calls, deps } = setup();

    const account = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE });

    expect(calls).toEqual([`exchange:${CODE}`, `me:${ACCESS}`]);
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "portal_inmobiliario",
      externalAccountId: "8035443",
      displayName: "CORREDORA_PRUEBA",
      status: "connected",
      tokenExpiresAt: new Date(NOW.getTime() + 180 * DAY),
    });
    expect(mercadoLibreAccountMetaSchema.parse(account.meta)).toEqual({
      userId: "8035443",
      nickname: "CORREDORA_PRUEBA",
      siteId: "MLC",
      userType: "normal",
      scopes: ["offline_access", "read", "write"],
      testUser: false,
      connectedAt: NOW.toISOString(),
      tokenRefreshedAt: null,
      accessTokenExpiresAt: new Date(NOW.getTime() + 6 * HOUR).toISOString(),
      tokenExpiryEstimated: true,
    });
    await expect(platformAccounts.getCredentials(account.id)).resolves.toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(JSON.stringify(account)).not.toMatch(/APP_USR|TG-/);
  });

  it("un usuario de prueba de Mercado Libre queda marcado (tags con test_user)", async () => {
    const { broker, deps } = setup({ user: { tags: ["test_user", "normal"] } });

    const account = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE });

    expect(mercadoLibreAccountMetaSchema.parse(account.meta).testUser).toBe(true);
  });

  it("un corredor que no existe es BROKER_NOT_FOUND, sin llamar a Mercado Libre", async () => {
    const { calls, deps } = setup();

    await expect(
      connectMercadoLibreAccount(deps, { broker: "no-existe", code: CODE }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it.each([
    [["read", "write"], ["offline_access"]],
    [["offline_access", "read"], ["write"]],
    [[], ["offline_access", "write"]],
  ])(
    "sin todos los permisos (%o) es ML_PERMISSION_DENIED y no guarda nada",
    async (scopes, missing) => {
      const { broker, platformAccounts, calls, deps } = setup({ scopes });

      const error = await connectMercadoLibreAccount(deps, {
        broker: broker.slug,
        code: CODE,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "ML_PERMISSION_DENIED", details: { missing } });
      expect(calls).toEqual([`exchange:${CODE}`]);
      await expect(platformAccounts.list()).resolves.toEqual([]);
    },
  );

  it("un canje sin refresh_token es ML_UNEXPECTED_RESPONSE, sin el valor en el error", async () => {
    const { broker, platformAccounts, deps } = setup({ refreshToken: null });

    const error = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { reason: "refresh_token_missing" },
    });
    expect(textOf(error)).not.toMatch(/APP_USR|TG-/);
    await expect(platformAccounts.list()).resolves.toEqual([]);
  });

  it("un user_id del canje distinto del de /users/me es ML_UNEXPECTED_RESPONSE", async () => {
    const { broker, platformAccounts, deps } = setup({ exchangeUserId: "999" });

    await expect(
      connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE }),
    ).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { reason: "user_mismatch" },
    });
    await expect(platformAccounts.list()).resolves.toEqual([]);
  });

  it("una cuenta de otro sitio es ML_SITE_MISMATCH y no se guarda", async () => {
    const { broker, platformAccounts, deps } = setup({ user: { siteId: "MLA" } });

    const error = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "ML_SITE_MISMATCH", details: { siteId: "MLA" } });
    expect((error as Error).message).toContain("Mercado Libre Chile");
    await expect(platformAccounts.list()).resolves.toEqual([]);
  });

  it("los errores de Mercado Libre pasan tal cual (un código vencido es ML_AUTH_INVALID)", async () => {
    const rejected = new AppError("ML_AUTH_INVALID", "Mercado Libre no aceptó el código");
    const { broker, deps } = setup({ error: rejected });

    await expect(
      connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE }),
    ).rejects.toBe(rejected);
  });

  it("reconectar la misma cuenta actualiza su fila; otra cuenta desconecta la anterior", async () => {
    const { broker, platformAccounts, deps } = setup();
    const first = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE });
    const again = await connectMercadoLibreAccount(deps, { broker: broker.slug, code: CODE });

    expect(again.id).toBe(first.id);

    const other = fakeMercadoLibre({
      exchangeUserId: "777",
      user: { userId: "777", nickname: "OTRA" },
    });
    const second = await connectMercadoLibreAccount(
      { ...deps, mercadoLibre: other.mercadoLibre },
      { broker: broker.slug, code: CODE },
    );

    const accounts = await platformAccounts.list();
    expect(accounts.find((account) => account.id === first.id)?.status).toBe("revoked");
    expect(accounts.find((account) => account.id === second.id)?.status).toBe("connected");
    expect(accounts.filter((account) => account.status === "connected")).toHaveLength(1);
  });
});
