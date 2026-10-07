import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { MercadoLibreAuth, MercadoLibreRefresh } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { createInMemoryPlatformAccountRepository } from "../testing/index.js";
import { ensureAccessToken } from "./ensure-access-token.js";

const NOW = new Date("2026-10-07T12:00:00Z");
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const OLD = { accessToken: "APP_USR-viejo-8035443", refreshToken: "TG-viejo-8035443" };
const NEW = { accessToken: "APP_USR-nuevo-8035443", refreshToken: "TG-nuevo-8035443" };

/** La `meta` que deja conectar (F4-T06), con el vencimiento del `access_token` pedido. */
const meta = (accessTokenExpiresAt: Date | null) => ({
  userId: "8035443",
  nickname: "CORREDORA_PRUEBA",
  siteId: "MLC",
  userType: "normal",
  scopes: ["offline_access", "read", "write"],
  testUser: false,
  connectedAt: new Date(NOW.getTime() - DAY).toISOString(),
  tokenRefreshedAt: null,
  ...(accessTokenExpiresAt === null
    ? {}
    : { accessTokenExpiresAt: accessTokenExpiresAt.toISOString() }),
  tokenExpiryEstimated: true,
});

type FakeOptions = { error?: AppError; userId?: string | null; wait?: Promise<void> };

/** Mercado Libre falso: cuenta los refrescos y entrega el par nuevo (o el error pedido). */
function fakeMercadoLibre(options: FakeOptions = {}) {
  const calls: string[] = [];
  const mercadoLibre: Pick<MercadoLibreAuth, "refresh"> = {
    async refresh(refreshToken): Promise<MercadoLibreRefresh> {
      calls.push(refreshToken);
      await options.wait;
      if (options.error) throw options.error;
      return {
        ...NEW,
        accessTokenExpiresAt: new Date(NOW.getTime() + 6 * 60 * MINUTE),
        scopes: ["offline_access", "read", "write"],
        userId: options.userId === undefined ? "8035443" : options.userId,
      };
    },
  };
  return { mercadoLibre, calls };
}

async function setup(
  options: {
    expiresIn?: number | null;
    credentials?: { accessToken: string; refreshToken?: string };
    platform?: "portal_inmobiliario" | "instagram";
  } & FakeOptions = {},
) {
  const repository = createInMemoryPlatformAccountRepository();
  const expiresIn = options.expiresIn === undefined ? 10 * MINUTE : options.expiresIn;
  const account = await repository.upsertConnected({
    brokerId: "broker-1",
    platform: options.platform ?? "portal_inmobiliario",
    externalAccountId: "8035443",
    displayName: "CORREDORA_PRUEBA",
    tokenExpiresAt: new Date(NOW.getTime() + 150 * DAY),
    meta: meta(expiresIn === null ? null : new Date(NOW.getTime() + expiresIn)),
    credentials: options.credentials ?? OLD,
  });
  const fake = fakeMercadoLibre(options);
  let locks = 0;
  const platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  > = {
    get: (id) => repository.get(id),
    getCredentials: (id) => repository.getCredentials(id),
    changeStatus: (id, from, to) => repository.changeStatus(id, from, to),
    withCredentialsLock: (id, fn) => {
      locks += 1;
      return repository.withCredentialsLock(id, fn);
    },
  };
  const deps = { platformAccounts, mercadoLibre: fake.mercadoLibre, now: () => NOW };
  return { account, repository, deps, calls: fake.calls, locks: () => locks };
}

const textOf = (error: unknown) =>
  JSON.stringify({ message: (error as Error).message, details: (error as AppError).details });

describe("ensureAccessToken", () => {
  it("con más de 30 min de vida devuelve el token guardado, sin candado ni Mercado Libre", async () => {
    const { account, deps, calls, locks } = await setup({ expiresIn: 31 * MINUTE });

    await expect(ensureAccessToken(deps, account.id)).resolves.toBe(OLD.accessToken);
    expect(calls).toEqual([]);
    expect(locks()).toBe(0);
  });

  it("por vencer: refresca, guarda el par y los vencimientos antes de devolver el token nuevo", async () => {
    const { account, repository, deps, calls } = await setup({ expiresIn: 29 * MINUTE });

    await expect(ensureAccessToken(deps, account.id)).resolves.toBe(NEW.accessToken);

    expect(calls).toEqual([OLD.refreshToken]);
    expect(repository.storedCredentials(account.id)).toEqual(NEW);
    const saved = await repository.get(account.id);
    expect(saved).toMatchObject({
      status: "connected",
      tokenExpiresAt: new Date(NOW.getTime() + 180 * DAY),
    });
    expect(saved?.meta).toMatchObject({
      tokenRefreshedAt: NOW.toISOString(),
      accessTokenExpiresAt: new Date(NOW.getTime() + 6 * 60 * MINUTE).toISOString(),
      tokenExpiryEstimated: true,
      nickname: "CORREDORA_PRUEBA",
    });
  });

  it("una meta sin accessTokenExpiresAt (o con otra forma) se refresca igual", async () => {
    const { account, deps, calls } = await setup({ expiresIn: null });

    await expect(ensureAccessToken(deps, account.id)).resolves.toBe(NEW.accessToken);
    expect(calls).toHaveLength(1);
  });

  it("dos pedidos a la vez refrescan una sola vez: el segundo relee y usa el token nuevo", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { account, deps, calls } = await setup({ wait });

    const first = ensureAccessToken(deps, account.id);
    const second = ensureAccessToken(deps, account.id);
    // Unas vueltas de microtareas: los dos ya leyeron y el primero espera a Mercado Libre.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([NEW.accessToken, NEW.accessToken]);
    expect(calls).toEqual([OLD.refreshToken]);
  });

  it("force refresca un token que parecía vigente (un 401), y dos force a la vez refrescan una vez", async () => {
    const { account, deps, calls } = await setup({ expiresIn: 5 * 60 * MINUTE });

    const results = await Promise.all([
      ensureAccessToken(deps, account.id, { force: true }),
      ensureAccessToken(deps, account.id, { force: true }),
    ]);

    expect(results).toEqual([NEW.accessToken, NEW.accessToken]);
    expect(calls).toEqual([OLD.refreshToken]);
  });

  it("invalid_grant deja la cuenta expired y no cambia las credenciales", async () => {
    const rejected = new AppError("ML_AUTH_INVALID", "venció", {
      details: { httpStatus: 400, error: "invalid_grant" },
    });
    const { account, repository, deps } = await setup({ error: rejected });

    const error = await ensureAccessToken(deps, account.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ML_AUTH_INVALID",
      details: { reason: "refresh_rejected" },
    });
    expect((error as Error).message).toContain("reconéctala");
    expect((await repository.get(account.id))?.status).toBe("expired");
    expect(repository.storedCredentials(account.id)).toEqual(OLD);
  });

  it.each([
    ["sin red", new AppError("ML_UNAVAILABLE", "sin red", { retriable: true })],
    ["el par de la app", new AppError("ML_APP_CREDENTIALS_INVALID", "revisa .env")],
    ["un permiso", new AppError("ML_PERMISSION_DENIED", "bloqueada")],
  ])("%s: el error sube y la cuenta no cambia", async (_name, failure) => {
    const { account, repository, deps } = await setup({ error: failure });

    await expect(ensureAccessToken(deps, account.id)).rejects.toBe(failure);
    expect(await repository.get(account.id)).toMatchObject({ status: "connected" });
    expect(repository.storedCredentials(account.id)).toEqual(OLD);
  });

  it("sin el par de la app: MERCADOLIBRE_NOT_CONFIGURED sin llamar ni cambiar la cuenta (con un token vigente, sirve igual)", async () => {
    const expiring = await setup({ expiresIn: 5 * MINUTE });
    const noApp = { ...expiring.deps, mercadoLibre: null };

    await expect(ensureAccessToken(noApp, expiring.account.id)).rejects.toMatchObject({
      code: "MERCADOLIBRE_NOT_CONFIGURED",
    });
    expect(expiring.calls).toEqual([]);
    expect(expiring.locks()).toBe(0);
    expect(await expiring.repository.get(expiring.account.id)).toMatchObject({
      status: "connected",
    });

    const fresh = await setup({ expiresIn: 3 * 60 * MINUTE });
    await expect(
      ensureAccessToken({ ...fresh.deps, mercadoLibre: null }, fresh.account.id),
    ).resolves.toBe(OLD.accessToken);
  });

  it("si guardar el par nuevo falla, el token nuevo no se entrega y no queda nada a medias", async () => {
    const { account, repository, deps } = await setup();
    const saveFails = {
      ...deps,
      platformAccounts: {
        ...deps.platformAccounts,
        withCredentialsLock: <T>(
          id: string,
          fn: Parameters<PlatformAccountRepository["withCredentialsLock"]>[1],
        ) =>
          repository.withCredentialsLock(id, (locked) =>
            fn({
              ...locked,
              save: async () => {
                throw new AppError("DB_UNAVAILABLE", "La base de datos no responde", {
                  retriable: true,
                });
              },
            }),
          ) as Promise<T>,
      },
    };

    const result = await ensureAccessToken(saveFails, account.id).catch(
      (caught: unknown) => caught,
    );

    expect(result).toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(textOf(result)).not.toContain(NEW.accessToken);
    expect(repository.storedCredentials(account.id)).toEqual(OLD);
    expect(await repository.get(account.id)).toMatchObject({ status: "connected" });
  });

  it("credenciales sin refresh_token: CREDENTIALS_INVALID sin el valor, y la cuenta queda en error", async () => {
    const { account, repository, deps, calls } = await setup({
      credentials: { accessToken: OLD.accessToken },
    });

    const error = await ensureAccessToken(deps, account.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CREDENTIALS_INVALID",
      details: { reason: "refresh_token_missing" },
    });
    expect(textOf(error)).not.toMatch(/APP_USR|TG-/);
    expect(calls).toEqual([]);
    expect((await repository.get(account.id))?.status).toBe("error");
  });

  it("credenciales ilegibles: CREDENTIALS_UNREADABLE y la cuenta queda en error", async () => {
    const { account, repository, deps } = await setup();
    repository.corruptCredentials(account.id);

    await expect(ensureAccessToken(deps, account.id)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
    expect((await repository.get(account.id))?.status).toBe("error");
  });

  it("un refresco que responde por otro usuario: ML_UNEXPECTED_RESPONSE, sin guardar, y la cuenta en error", async () => {
    const { account, repository, deps } = await setup({ userId: "999" });

    await expect(ensureAccessToken(deps, account.id)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { reason: "user_mismatch" },
    });
    expect(repository.storedCredentials(account.id)).toEqual(OLD);
    expect((await repository.get(account.id))?.status).toBe("error");
  });

  it("un refresco sin user_id (opcional) se acepta", async () => {
    const { account, deps } = await setup({ userId: null });

    await expect(ensureAccessToken(deps, account.id)).resolves.toBe(NEW.accessToken);
  });

  it("una cuenta que no existe, de Instagram o desconectada no se toca", async () => {
    const { deps } = await setup();
    await expect(ensureAccessToken(deps, "no-existe")).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });

    const instagram = await setup({ platform: "instagram" });
    await expect(ensureAccessToken(instagram.deps, instagram.account.id)).rejects.toMatchObject({
      code: "ACCOUNT_REFRESH_UNSUPPORTED",
    });

    const other = await setup();
    await other.repository.disconnect(other.account.id);
    await expect(ensureAccessToken(other.deps, other.account.id)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_CONNECTED",
    });
  });
});
