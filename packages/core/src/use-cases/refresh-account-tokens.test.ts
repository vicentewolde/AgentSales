import { describe, expect, it } from "vitest";
import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { InstagramAccountMeta } from "../platform-account.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import type { MercadoLibreAuth, MercadoLibreRefresh } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { createInMemoryPlatformAccountRepository } from "../testing/index.js";
import {
  MERCADOLIBRE_REFRESH_AGE_MS,
  type RefreshAccountTokensDeps,
  refreshAccountToken,
  refreshAccountTokens,
} from "./refresh-account-tokens.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const fromNow = (ms: number) => new Date(NOW.getTime() + ms);

/** Instagram falso: el token nuevo dura 60 días desde `NOW`; un token `malo-*` es el 190. */
function fakeInstagram(options: { error?: AppError } = {}) {
  const calls: string[] = [];
  const instagram: Pick<InstagramAuth, "refresh"> = {
    async refresh(accessToken) {
      calls.push(accessToken);
      if (options.error) throw options.error;
      if (accessToken.startsWith("malo")) {
        throw new AppError("IG_AUTH_INVALID", "El acceso a Instagram venció o ya no es válido");
      }
      return { accessToken: `${accessToken}-nuevo`, expiresAt: fromNow(60 * DAY) };
    },
  };
  return { instagram, calls };
}

/** El `refresh_token` guardado de una cuenta de Mercado Libre decide el caso (`TG-vencido…`, `TG-caido…`). */
const ML_OLD = { accessToken: "APP_USR-viejo-8035443", refreshToken: "TG-viejo-8035443" };

/**
 * Mercado Libre falso: registra el `refresh_token` de cada refresco y entrega un par nuevo que lo
 * lleva (`APP_USR-nuevo-<n>`, `TG-nuevo-<n>`). `TG-vencido…` es el `invalid_grant` y `TG-caido…`,
 * un corte de red.
 */
function fakeMercadoLibre() {
  const calls: string[] = [];
  const mercadoLibre: Pick<MercadoLibreAuth, "refresh"> = {
    async refresh(refreshToken): Promise<MercadoLibreRefresh> {
      calls.push(refreshToken);
      if (refreshToken.startsWith("TG-vencido")) {
        throw new AppError("ML_AUTH_INVALID", "Mercado Libre ya no acepta el acceso", {
          details: { httpStatus: 400, error: "invalid_grant", causes: [] },
        });
      }
      if (refreshToken.startsWith("TG-caido")) {
        throw new AppError("ML_UNAVAILABLE", "No hubo conexión con Mercado Libre", {
          retriable: true,
        });
      }
      return {
        accessToken: `APP_USR-nuevo-${calls.length}`,
        refreshToken: `TG-nuevo-${calls.length}`,
        accessTokenExpiresAt: fromNow(6 * HOUR),
        scopes: ["offline_access", "read", "write"],
        // Sin `user_id`: el núcleo no descarta el par por eso (el otro usuario lo prueba F4-T07).
        userId: null,
      };
    },
  };
  return { mercadoLibre, mlCalls: calls };
}

type AccountSetup = {
  token?: string;
  expiresAt?: Date | null;
  meta?: Partial<InstagramAccountMeta> | Record<string, unknown>;
  externalAccountId?: string;
  platform?: "instagram" | "portal_inmobiliario" | "fb_marketplace";
};

function setup(options: { error?: AppError } = {}) {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { instagram, calls } = fakeInstagram(options);
  const { mercadoLibre, mlCalls } = fakeMercadoLibre();
  const warnings: { accountId: string; code: string }[] = [];
  const deps: RefreshAccountTokensDeps = {
    platformAccounts,
    instagram,
    mercadoLibre,
    now: () => NOW,
    onWarning: (warning) => warnings.push(warning),
  };
  const add = ({
    token = "IGAA-token",
    expiresAt = fromNow(20 * DAY),
    meta = {},
    externalAccountId = "17841400000000001",
    platform = "instagram",
  }: AccountSetup = {}) =>
    platformAccounts.upsertConnected({
      brokerId: "broker-1",
      platform,
      externalAccountId,
      displayName: "@corredora",
      tokenExpiresAt: expiresAt,
      meta: {
        accountType: "BUSINESS",
        permissions: null,
        connectedAt: ago(40 * DAY).toISOString(),
        tokenRefreshedAt: ago(40 * DAY).toISOString(),
        tokenExpiryEstimated: false,
        ...meta,
      },
      credentials: { accessToken: token },
    });
  /** Una cuenta de Mercado Libre como la deja conectar (F4-T06), refrescada hace `refreshedAgo`. */
  const addMl = ({
    refreshedAgo = 8 * DAY,
    credentials = ML_OLD,
    externalAccountId = "8035443",
    meta = {},
    expiresAt = fromNow(150 * DAY),
  }: {
    refreshedAgo?: number | null;
    credentials?: { accessToken: string; refreshToken?: string };
    externalAccountId?: string;
    meta?: Record<string, unknown>;
    expiresAt?: Date;
  } = {}) =>
    platformAccounts.upsertConnected({
      brokerId: "broker-1",
      platform: "portal_inmobiliario",
      externalAccountId,
      displayName: "CORREDORA_PRUEBA",
      tokenExpiresAt: expiresAt,
      meta: {
        userId: externalAccountId,
        nickname: "CORREDORA_PRUEBA",
        siteId: "MLC",
        userType: "normal",
        scopes: ["offline_access", "read", "write"],
        testUser: false,
        connectedAt: ago(60 * DAY).toISOString(),
        tokenRefreshedAt: refreshedAgo === null ? null : ago(refreshedAgo).toISOString(),
        accessTokenExpiresAt: ago(HOUR).toISOString(),
        tokenExpiryEstimated: true,
        ...meta,
      },
      credentials,
    });
  return { platformAccounts, calls, mlCalls, warnings, deps, add, addMl };
}

describe("refreshAccountToken · ventana", () => {
  it("con menos de 30 días de vigencia y más de 24 h: refresca, guarda el token, el vencimiento y meta", async () => {
    const { platformAccounts, calls, deps, add } = setup();
    const account = await add({
      meta: { permissions: null, tokenRefreshedAt: ago(30 * DAY).toISOString() },
    });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toEqual(["IGAA-token"]);
    expect(result.account).toMatchObject({
      status: "connected",
      tokenExpiresAt: fromNow(60 * DAY),
      meta: {
        accountType: "BUSINESS",
        permissions: null,
        tokenRefreshedAt: NOW.toISOString(),
        tokenExpiryEstimated: false,
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "IGAA-token-nuevo",
    });
    expect(JSON.stringify(result)).not.toContain("IGAA-token");
  });

  it("con menos de 24 h desde el último refresco no llama a Instagram (too_recent), tampoco con force", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ meta: { tokenRefreshedAt: ago(23 * HOUR).toISOString() } });

    for (const force of [false, true]) {
      const result = await refreshAccountToken(deps, { accountId: account.id, force });
      expect(result).toMatchObject({
        outcome: "skipped",
        reason: "too_recent",
        refreshableAt: fromNow(HOUR),
      });
    }
    expect(calls).toEqual([]);
  });

  it("justo a las 24 h ya refresca", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ meta: { tokenRefreshedAt: ago(24 * HOUR).toISOString() } });

    expect((await refreshAccountToken(deps, { accountId: account.id })).outcome).toBe("refreshed");
    expect(calls).toHaveLength(1);
  });

  it("con más de 30 días de vigencia no refresca (not_due); force salta ese tope", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ expiresAt: fromNow(31 * DAY) });

    expect(await refreshAccountToken(deps, { accountId: account.id })).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: fromNow(DAY),
    });
    expect(calls).toEqual([]);

    expect((await refreshAccountToken(deps, { accountId: account.id, force: true })).outcome).toBe(
      "refreshed",
    );
    expect(calls).toHaveLength(1);
  });

  it("justo en el borde: con un poco más de 30 días no refresca, con 30 sí", async () => {
    const { deps, add } = setup();
    const later = await add({ expiresAt: fromNow(30 * DAY + 1) });
    const border = await add({ externalAccountId: "2", expiresAt: fromNow(30 * DAY) });

    expect((await refreshAccountToken(deps, { accountId: later.id })).outcome).toBe("skipped");
    expect((await refreshAccountToken(deps, { accountId: border.id })).outcome).toBe("refreshed");
  });

  it("token del panel (tokenRefreshedAt null): a las 24 h desde connectedAt refresca sin esperar los 30 días de la estimación", async () => {
    const { calls, deps, add } = setup();
    const fresh = await add({
      expiresAt: fromNow(60 * DAY - 23 * HOUR),
      meta: {
        connectedAt: ago(23 * HOUR).toISOString(),
        tokenRefreshedAt: null,
        tokenExpiryEstimated: true,
      },
    });
    // Recién conectada: las 24 h corren desde `connectedAt`, así que ni con force se refresca.
    expect(await refreshAccountToken(deps, { accountId: fresh.id, force: true })).toMatchObject({
      outcome: "skipped",
      reason: "too_recent",
      refreshableAt: fromNow(HOUR),
    });

    const day = await add({
      externalAccountId: "17841400000000002",
      token: "IGAA-panel",
      expiresAt: fromNow(59 * DAY),
      meta: {
        connectedAt: ago(25 * HOUR).toISOString(),
        tokenRefreshedAt: null,
        tokenExpiryEstimated: true,
      },
    });
    // Sin force: los 59 días son una estimación (el token pudo generarse antes de conectarlo).
    const result = await refreshAccountToken(deps, { accountId: day.id });
    expect(result.outcome).toBe("refreshed");
    expect(result.account.tokenExpiresAt).toEqual(fromNow(60 * DAY));
    expect(result.account.meta).toMatchObject({
      tokenRefreshedAt: NOW.toISOString(),
      tokenExpiryEstimated: false,
      permissions: null,
    });
    expect(calls).toEqual(["IGAA-panel"]);

    // Ya con el vencimiento real, vuelve la ventana de 30 días.
    expect(await refreshAccountToken(deps, { accountId: day.id })).toMatchObject({
      outcome: "skipped",
      reason: "too_recent",
    });
  });

  it("el lote refresca el token del panel a las 24 h, con un vencimiento estimado lejano", async () => {
    const { deps, add } = setup();
    const account = await add({
      expiresAt: fromNow(59 * DAY),
      meta: {
        connectedAt: ago(24 * HOUR).toISOString(),
        tokenRefreshedAt: null,
        tokenExpiryEstimated: true,
      },
    });

    expect(await refreshAccountTokens(deps)).toMatchObject({ refreshed: [account.id] });
  });

  it("sin vencimiento guardado, refresca para conocerlo", async () => {
    const { deps, add } = setup();
    const account = await add({ expiresAt: null });

    const result = await refreshAccountToken(deps, { accountId: account.id });
    expect(result.outcome).toBe("refreshed");
    expect(result.account.tokenExpiresAt).toEqual(fromNow(60 * DAY));
  });
});

describe("refreshAccountToken · vencimiento y errores", () => {
  it("un token vencido deja la cuenta en expired sin llamar a Instagram, también con force", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ expiresAt: NOW });

    const result = await refreshAccountToken(deps, { accountId: account.id, force: true });

    expect(result).toMatchObject({ outcome: "expired", reason: "token_expired" });
    expect(result.account.status).toBe("expired");
    expect(calls).toEqual([]);
  });

  it("un 190 al refrescar deja la cuenta en expired (token_rejected) y no cambia el token", async () => {
    const { platformAccounts, deps, add } = setup();
    const account = await add({ token: "malo-token" });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result).toMatchObject({ outcome: "expired", reason: "token_rejected" });
    expect((await platformAccounts.get(account.id))?.status).toBe("expired");
    expect(platformAccounts.storedCredentials(account.id)).toEqual({ accessToken: "malo-token" });
  });

  it("un error de red sube sin cambiar la cuenta", async () => {
    const unavailable = new AppError("IG_UNAVAILABLE", "Instagram no responde", {
      retriable: true,
    });
    const { platformAccounts, deps, add } = setup({ error: unavailable });
    const account = await add();
    const before = await platformAccounts.get(account.id);

    await expect(refreshAccountToken(deps, { accountId: account.id })).rejects.toBe(unavailable);

    const after = await platformAccounts.get(account.id);
    expect(after?.status).toBe("connected");
    expect(after?.tokenExpiresAt).toEqual(before?.tokenExpiresAt);
    expect(after?.meta).toEqual(before?.meta);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({ accessToken: "IGAA-token" });
  });

  it("credenciales ilegibles: la cuenta queda en error y el error sube, sin llamar a Instagram", async () => {
    const { platformAccounts, calls, deps, add } = setup();
    const account = await add();
    platformAccounts.corruptCredentials(account.id);

    await expect(refreshAccountToken(deps, { accountId: account.id })).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
    expect((await platformAccounts.get(account.id))?.status).toBe("error");
    expect(calls).toEqual([]);
  });

  it("una cuenta que no existe es ACCOUNT_NOT_FOUND; una desconectada, ACCOUNT_NOT_CONNECTED", async () => {
    const { platformAccounts, calls, deps, add } = setup();
    await expect(refreshAccountToken(deps, { accountId: "no-existe" })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
    const account = await add();
    await platformAccounts.disconnect(account.id);
    await expect(refreshAccountToken(deps, { accountId: account.id })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_CONNECTED",
      details: { accountStatus: "revoked" },
    });
    expect(calls).toEqual([]);
  });

  it("una meta que no calza con el esquema se refresca con un aviso, y respeta las 24 h después", async () => {
    const { calls, warnings, deps, add } = setup();
    // Una fila vieja sin `accountType` ni `tokenExpiryEstimated`, pero con su reloj.
    const account = await add({
      meta: { accountType: undefined, tokenExpiryEstimated: "no" },
    });

    const result = await refreshAccountToken(deps, { accountId: account.id });
    expect(result.outcome).toBe("refreshed");
    expect(warnings).toEqual([{ accountId: account.id, code: "ACCOUNT_META_UNREADABLE" }]);

    // El refresco escribió `tokenRefreshedAt`: un reintento inmediato (o force) ya no llama.
    expect(await refreshAccountToken(deps, { accountId: account.id, force: true })).toMatchObject({
      outcome: "skipped",
      reason: "too_recent",
      refreshableAt: fromNow(24 * HOUR),
    });
    expect(calls).toHaveLength(1);
  });

  it("una meta ilegible con un tokenRefreshedAt reciente igual respeta las 24 h", async () => {
    const { calls, deps, add } = setup();
    const account = await add({
      meta: { connectedAt: "ayer", tokenRefreshedAt: ago(HOUR).toISOString() },
    });

    expect(await refreshAccountToken(deps, { accountId: account.id })).toMatchObject({
      outcome: "skipped",
      reason: "too_recent",
    });
    expect(calls).toEqual([]);
  });

  it("una meta sin ninguna fecha legible se refresca (Instagram revisa las 24 h)", async () => {
    const { platformAccounts, warnings, deps } = setup();
    const account = await platformAccounts.upsertConnected({
      brokerId: "broker-1",
      platform: "instagram",
      externalAccountId: "17841400000000009",
      displayName: "@vieja",
      tokenExpiresAt: fromNow(10 * DAY),
      meta: { connectedAt: "ayer" },
      credentials: { accessToken: "IGAA-vieja" },
    });

    expect((await refreshAccountToken(deps, { accountId: account.id })).outcome).toBe("refreshed");
    expect(warnings).toEqual([{ accountId: account.id, code: "ACCOUNT_META_UNREADABLE" }]);
  });

  it("Marketplace no se refresca: ACCOUNT_REFRESH_UNSUPPORTED, y el lote ni la mira", async () => {
    const { calls, mlCalls, deps, add } = setup();
    const account = await add({ platform: "fb_marketplace" });

    await expect(
      refreshAccountToken(deps, { accountId: account.id, force: true }),
    ).rejects.toMatchObject({ code: "ACCOUNT_REFRESH_UNSUPPORTED" });
    expect(await refreshAccountTokens(deps)).toEqual({
      refreshed: [],
      expired: [],
      skipped: 0,
      failed: [],
    });
    expect(calls).toEqual([]);
    expect(mlCalls).toEqual([]);
  });

  it("si no se puede guardar el vencimiento, avisa y devuelve el resultado igual", async () => {
    const { platformAccounts, warnings, deps, add } = setup();
    const account = await add({ expiresAt: ago(DAY) });
    const failing: RefreshAccountTokensDeps = {
      ...deps,
      platformAccounts: {
        ...platformAccounts,
        changeStatus: async () => {
          throw new AppError("DB_UNAVAILABLE", "sin base", { retriable: true });
        },
      },
    };

    const result = await refreshAccountToken(failing, { accountId: account.id });

    expect(result).toMatchObject({ outcome: "expired", reason: "token_expired" });
    // La cuenta va como quedó en la base (no se pudo guardar): el aviso lo explica.
    expect(result.account.status).toBe("connected");
    expect(warnings).toEqual([{ accountId: account.id, code: "ACCOUNT_STATUS_NOT_SAVED" }]);
  });

  it("si la cuenta cambió en paralelo al marcarla vencida, devuelve cómo quedó", async () => {
    const { platformAccounts, deps, add } = setup();
    const account = await add({ token: "malo-token" });
    const racing: RefreshAccountTokensDeps = {
      ...deps,
      instagram: {
        async refresh() {
          await platformAccounts.disconnect(account.id);
          throw new AppError("IG_AUTH_INVALID", "El acceso a Instagram venció");
        },
      },
    };

    const result = await refreshAccountToken(racing, { accountId: account.id });

    expect(result).toMatchObject({ outcome: "expired", reason: "token_rejected" });
    expect(result.account.status).toBe("revoked");
  });

  it("si la cuenta se desconecta mientras se refresca, no la revive (ACCOUNT_NOT_CONNECTED)", async () => {
    const { platformAccounts, deps, add } = setup();
    const account = await add();
    const racing: RefreshAccountTokensDeps = {
      ...deps,
      instagram: {
        async refresh(accessToken) {
          await platformAccounts.disconnect(account.id);
          return { accessToken: `${accessToken}-nuevo`, expiresAt: fromNow(60 * DAY) };
        },
      },
    };

    await expect(refreshAccountToken(racing, { accountId: account.id })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_CONNECTED",
    });
    expect((await platformAccounts.get(account.id))?.status).toBe("revoked");
  });
});

describe("refreshAccountToken · Mercado Libre", () => {
  it("sin force, con 7 días o más desde el último refresco: refresca y guarda el par completo, los vencimientos y meta", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl({ refreshedAgo: MERCADOLIBRE_REFRESH_AGE_MS });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result.outcome).toBe("refreshed");
    expect(mlCalls).toEqual([ML_OLD.refreshToken]);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "APP_USR-nuevo-1",
      refreshToken: "TG-nuevo-1",
    });
    expect(result.account).toMatchObject({
      status: "connected",
      tokenExpiresAt: fromNow(180 * DAY),
      meta: {
        nickname: "CORREDORA_PRUEBA",
        scopes: ["offline_access", "read", "write"],
        connectedAt: ago(60 * DAY).toISOString(),
        tokenRefreshedAt: NOW.toISOString(),
        accessTokenExpiresAt: fromNow(6 * HOUR).toISOString(),
        tokenExpiryEstimated: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/APP_USR|TG-/);
  });

  it("sin force, con menos de 7 días: no toma el candado ni llama (not_due, desde cuándo)", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl({ refreshedAgo: 7 * DAY - 1 });
    let locks = 0;
    const counting: RefreshAccountTokensDeps = {
      ...deps,
      platformAccounts: {
        ...platformAccounts,
        withCredentialsLock: (id, fn) => {
          locks += 1;
          return platformAccounts.withCredentialsLock(id, fn);
        },
      } as RefreshAccountTokensDeps["platformAccounts"],
    };

    const result = await refreshAccountToken(counting, { accountId: account.id });

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: new Date(NOW.getTime() + 1),
    });
    expect(mlCalls).toEqual([]);
    expect(locks).toBe(0);
    expect(platformAccounts.storedCredentials(account.id)).toEqual(ML_OLD);
  });

  it("sin refresco previo cuenta desde la conexión; sin ninguna fecha legible, refresca", async () => {
    const { mlCalls, deps, addMl } = setup();
    const fresh = await addMl({
      refreshedAgo: null,
      meta: { connectedAt: ago(2 * DAY).toISOString() },
    });
    expect(await refreshAccountToken(deps, { accountId: fresh.id })).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: fromNow(5 * DAY),
    });

    const old = await addMl({
      externalAccountId: "8035444",
      refreshedAgo: null,
      meta: { connectedAt: ago(7 * DAY).toISOString() },
    });
    expect((await refreshAccountToken(deps, { accountId: old.id })).outcome).toBe("refreshed");

    const unreadable = await addMl({
      externalAccountId: "8035445",
      meta: { connectedAt: "ayer", tokenRefreshedAt: 42 },
    });
    expect((await refreshAccountToken(deps, { accountId: unreadable.id })).outcome).toBe(
      "refreshed",
    );
    expect(mlCalls).toHaveLength(2);
  });

  it("force refresca siempre, sin mínimo: también recién refrescada", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl({ refreshedAgo: 0 });

    const first = await refreshAccountToken(deps, { accountId: account.id, force: true });
    const second = await refreshAccountToken(deps, { accountId: account.id, force: true });

    expect([first.outcome, second.outcome]).toEqual(["refreshed", "refreshed"]);
    expect(mlCalls).toEqual([ML_OLD.refreshToken, "TG-nuevo-1"]);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "APP_USR-nuevo-2",
      refreshToken: "TG-nuevo-2",
    });
  });

  it("la regla se revisa otra vez dentro del candado: si otro la refrescó mientras esperaba, no llama (skipped)", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl();
    // Otro proceso refresca justo antes de que esta llamada entre al candado.
    const racing: RefreshAccountTokensDeps = {
      ...deps,
      platformAccounts: {
        ...platformAccounts,
        withCredentialsLock: async (id, fn) => {
          await platformAccounts.updateToken(id, {
            credentials: { accessToken: "APP_USR-otro", refreshToken: "TG-otro" },
            tokenExpiresAt: fromNow(180 * DAY),
            meta: { tokenRefreshedAt: NOW.toISOString() },
          });
          return platformAccounts.withCredentialsLock(id, fn);
        },
      } as RefreshAccountTokensDeps["platformAccounts"],
    };

    const result = await refreshAccountToken(racing, { accountId: account.id });

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: fromNow(7 * DAY),
      account: { meta: { tokenRefreshedAt: NOW.toISOString() } },
    });
    expect(mlCalls).toEqual([]);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "APP_USR-otro",
      refreshToken: "TG-otro",
    });
  });

  it("dos refrescos sin force a la vez refrescan una sola vez (el segundo ve el par nuevo)", async () => {
    const { mlCalls, deps, addMl } = setup();
    const account = await addMl();

    const results = await Promise.all([
      refreshAccountToken(deps, { accountId: account.id }),
      refreshAccountToken(deps, { accountId: account.id }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["refreshed", "skipped"]);
    expect(mlCalls).toEqual([ML_OLD.refreshToken]);
  });

  it("un rechazo (invalid_grant) deja la cuenta expired y es un resultado (token_rejected), también con force", async () => {
    const { platformAccounts, deps, addMl } = setup();
    const credentials = { accessToken: "APP_USR-x", refreshToken: "TG-vencido-1" };
    const account = await addMl({ credentials });

    const result = await refreshAccountToken(deps, { accountId: account.id, force: true });

    expect(result).toMatchObject({
      outcome: "expired",
      reason: "token_rejected",
      account: { id: account.id, status: "expired" },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual(credentials);
  });

  it("un vencimiento estimado ya pasado no la deja expired sin preguntar: se intenta", async () => {
    const { mlCalls, deps, addMl } = setup();
    const account = await addMl({ expiresAt: ago(DAY) });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result).toMatchObject({ outcome: "refreshed", account: { status: "connected" } });
    expect(mlCalls).toHaveLength(1);
  });

  it("un corte de red sube sin cambiar la cuenta", async () => {
    const { platformAccounts, deps, addMl } = setup();
    const credentials = { accessToken: "APP_USR-x", refreshToken: "TG-caido-1" };
    const account = await addMl({ credentials });

    await expect(
      refreshAccountToken(deps, { accountId: account.id, force: true }),
    ).rejects.toMatchObject({ code: "ML_UNAVAILABLE", retriable: true });
    expect(await platformAccounts.get(account.id)).toMatchObject({
      status: "connected",
      meta: { tokenRefreshedAt: ago(8 * DAY).toISOString() },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual(credentials);
  });

  it("sin el par de la app: MERCADOLIBRE_NOT_CONFIGURED sin llamar ni cambiarla; si no toca, skipped igual", async () => {
    const { platformAccounts, deps, addMl } = setup();
    const unconfigured: RefreshAccountTokensDeps = { ...deps, mercadoLibre: null };
    const due = await addMl();
    const recent = await addMl({ externalAccountId: "8035444", refreshedAgo: DAY });

    await expect(
      refreshAccountToken(unconfigured, { accountId: due.id, force: true }),
    ).rejects.toMatchObject({ code: "MERCADOLIBRE_NOT_CONFIGURED", retriable: false });
    expect(await platformAccounts.get(due.id)).toMatchObject({ status: "connected" });
    expect(platformAccounts.storedCredentials(due.id)).toEqual(ML_OLD);
    expect((await refreshAccountToken(unconfigured, { accountId: recent.id })).outcome).toBe(
      "skipped",
    );
  });

  it("sin refreshToken guardado la cuenta queda en error (CREDENTIALS_INVALID) sin llamar", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl({ credentials: { accessToken: "APP_USR-solo" } });

    await expect(
      refreshAccountToken(deps, { accountId: account.id, force: true }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect((await platformAccounts.get(account.id))?.status).toBe("error");
    expect(mlCalls).toEqual([]);
  });

  it("el candado ocupado (ACCOUNT_LOCK_TIMEOUT) sube reintentable sin cambiar la cuenta", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl();
    const busy: RefreshAccountTokensDeps = {
      ...deps,
      platformAccounts: {
        ...platformAccounts,
        withCredentialsLock: async () => {
          throw new AppError("ACCOUNT_LOCK_TIMEOUT", "ocupado", { retriable: true });
        },
      } as RefreshAccountTokensDeps["platformAccounts"],
    };

    await expect(refreshAccountToken(busy, { accountId: account.id })).rejects.toMatchObject({
      code: "ACCOUNT_LOCK_TIMEOUT",
      retriable: true,
    });
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
    expect(mlCalls).toEqual([]);
  });

  it("una cuenta desconectada es ACCOUNT_NOT_CONNECTED sin llamar", async () => {
    const { platformAccounts, mlCalls, deps, addMl } = setup();
    const account = await addMl();
    await platformAccounts.disconnect(account.id);

    await expect(
      refreshAccountToken(deps, { accountId: account.id, force: true }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    expect(mlCalls).toEqual([]);
  });

  it("pasa la señal al refresco de Mercado Libre", async () => {
    const { deps, addMl } = setup();
    const account = await addMl();
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    };
    const seen: unknown[] = [];
    const mercadoLibre = deps.mercadoLibre;
    await refreshAccountToken(
      {
        ...deps,
        mercadoLibre: {
          async refresh(refreshToken, options) {
            seen.push(options?.signal);
            if (mercadoLibre === null) throw new Error("sin Mercado Libre");
            return mercadoLibre.refresh(refreshToken, options);
          },
        },
      },
      { accountId: account.id, signal },
    );
    expect(seen).toEqual([signal]);
  });
});

describe("refreshAccountTokens · lote", () => {
  it("refresca las que entran, salta las demás y una que falla no corta el lote", async () => {
    const unavailable = new AppError("IG_UNAVAILABLE", "Instagram no responde", {
      retriable: true,
    });
    const { platformAccounts, deps, add } = setup();
    const due = await add({ externalAccountId: "1" });
    const recent = await add({
      externalAccountId: "2",
      meta: { tokenRefreshedAt: ago(HOUR).toISOString() },
    });
    const notDue = await add({ externalAccountId: "3", expiresAt: fromNow(45 * DAY) });
    const expired = await add({ externalAccountId: "4", expiresAt: ago(HOUR) });
    const rejected = await add({ externalAccountId: "5", token: "malo-5" });
    const network = await add({ externalAccountId: "6", token: "IGAA-red" });
    const revoked = await add({ externalAccountId: "7" });
    await platformAccounts.disconnect(revoked.id);
    const corrupt = await add({ externalAccountId: "8" });
    platformAccounts.corruptCredentials(corrupt.id);
    const calls: string[] = [];
    const lote: RefreshAccountTokensDeps = {
      ...deps,
      instagram: {
        async refresh(accessToken, options) {
          calls.push(accessToken);
          if (accessToken === "IGAA-red") throw unavailable;
          return deps.instagram.refresh(accessToken, options);
        },
      },
    };

    const report = await refreshAccountTokens(lote);

    expect(report).toEqual({
      refreshed: [due.id],
      expired: [expired.id, rejected.id],
      skipped: 2,
      failed: [
        { accountId: network.id, code: "IG_UNAVAILABLE", retriable: true },
        { accountId: corrupt.id, code: "CREDENTIALS_UNREADABLE", retriable: false },
      ],
    });
    expect(calls).toEqual(["IGAA-token", "malo-5", "IGAA-red"]);
    expect((await platformAccounts.get(recent.id))?.status).toBe("connected");
    expect((await platformAccounts.get(notDue.id))?.status).toBe("connected");
    expect((await platformAccounts.get(network.id))?.status).toBe("connected");
    expect((await platformAccounts.get(corrupt.id))?.status).toBe("error");
    expect(JSON.stringify(report)).not.toContain("IGAA");
  });

  it("repetir el lote no refresca de nuevo lo que ya refrescó", async () => {
    const { calls, deps, add } = setup();
    await add();

    expect((await refreshAccountTokens(deps)).refreshed).toHaveLength(1);
    expect(await refreshAccountTokens(deps)).toEqual({
      refreshed: [],
      expired: [],
      skipped: 1,
      failed: [],
    });
    expect(calls).toHaveLength(1);
  });

  it("con la señal disparada no empieza otra cuenta", async () => {
    const { calls, deps, add } = setup();
    await add({ externalAccountId: "1" });
    await add({ externalAccountId: "2" });
    // Core no tiene los tipos de Node: una señal hecha a mano que se dispara tras el primer refresco.
    const signal: AbortSignalLike & { aborted: boolean } = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    };
    const aborting: RefreshAccountTokensDeps = {
      ...deps,
      instagram: {
        async refresh(accessToken, options) {
          const token = await deps.instagram.refresh(accessToken, options);
          signal.aborted = true;
          return token;
        },
      },
    };

    const report = await refreshAccountTokens(aborting, { signal });

    expect(report.refreshed).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("pasa la señal a Instagram", async () => {
    const { deps, add } = setup();
    await add();
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    };
    const seen: unknown[] = [];
    await refreshAccountTokens(
      {
        ...deps,
        instagram: {
          async refresh(accessToken, options) {
            seen.push(options?.signal);
            return deps.instagram.refresh(accessToken, options);
          },
        },
      },
      { signal },
    );
    expect(seen).toEqual([signal]);
  });

  it("con las dos plataformas: refresca a cada una según su política y una que falla no corta", async () => {
    const { platformAccounts, calls, mlCalls, deps, add, addMl } = setup();
    const instagram = await add({ externalAccountId: "1" });
    const instagramRecent = await add({
      externalAccountId: "2",
      meta: { tokenRefreshedAt: ago(HOUR).toISOString() },
    });
    const mlDue = await addMl({ externalAccountId: "11" });
    const mlRecent = await addMl({ externalAccountId: "12", refreshedAgo: 6 * DAY });
    const mlRejected = await addMl({
      externalAccountId: "13",
      credentials: { accessToken: "APP_USR-13", refreshToken: "TG-vencido-13" },
    });
    const mlDown = await addMl({
      externalAccountId: "14",
      credentials: { accessToken: "APP_USR-14", refreshToken: "TG-caido-14" },
    });

    const report = await refreshAccountTokens(deps);

    expect(report).toEqual({
      refreshed: [instagram.id, mlDue.id],
      expired: [mlRejected.id],
      skipped: 2,
      failed: [{ accountId: mlDown.id, code: "ML_UNAVAILABLE", retriable: true }],
    });
    expect(calls).toEqual(["IGAA-token"]);
    expect(mlCalls).toEqual([ML_OLD.refreshToken, "TG-vencido-13", "TG-caido-14"]);
    expect(platformAccounts.storedCredentials(mlDue.id)).toEqual({
      accessToken: "APP_USR-nuevo-1",
      refreshToken: "TG-nuevo-1",
    });
    expect((await platformAccounts.get(mlRecent.id))?.meta).toMatchObject({
      tokenRefreshedAt: ago(6 * DAY).toISOString(),
    });
    expect((await platformAccounts.get(instagramRecent.id))?.status).toBe("connected");
    expect((await platformAccounts.get(mlDown.id))?.status).toBe("connected");
    expect(JSON.stringify(report)).not.toMatch(/IGAA|APP_USR|TG-/);

    // Repetir el lote (el reintento del job) no refresca de nuevo lo hecho.
    expect(await refreshAccountTokens(deps)).toMatchObject({ refreshed: [], skipped: 4 });
    expect(mlCalls).toEqual([ML_OLD.refreshToken, "TG-vencido-13", "TG-caido-14", "TG-caido-14"]);
  });

  it("sin el par de Mercado Libre salta esas cuentas sin cambiarlas y sigue con Instagram", async () => {
    const { platformAccounts, calls, deps, add, addMl } = setup();
    const mlDue = await addMl({ externalAccountId: "11" });
    const mlRecent = await addMl({ externalAccountId: "12", refreshedAgo: DAY });
    const instagram = await add({ externalAccountId: "1" });
    const before = await platformAccounts.get(mlDue.id);

    const report = await refreshAccountTokens({ ...deps, mercadoLibre: null });

    expect(report).toEqual({
      refreshed: [instagram.id],
      expired: [],
      skipped: 1,
      failed: [{ accountId: mlDue.id, code: "MERCADOLIBRE_NOT_CONFIGURED", retriable: false }],
    });
    expect(calls).toEqual(["IGAA-token"]);
    expect(await platformAccounts.get(mlDue.id)).toEqual(before);
    expect(platformAccounts.storedCredentials(mlDue.id)).toEqual(ML_OLD);
    expect((await platformAccounts.get(mlRecent.id))?.status).toBe("connected");
  });
});
