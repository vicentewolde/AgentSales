import { describe, expect, it } from "vitest";
import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { InstagramAccountMeta } from "../platform-account.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import { createInMemoryPlatformAccountRepository } from "../testing/index.js";
import {
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

type AccountSetup = {
  token?: string;
  expiresAt?: Date | null;
  meta?: Partial<InstagramAccountMeta> | Record<string, unknown>;
  externalAccountId?: string;
  platform?: "instagram" | "portal_inmobiliario";
};

function setup(options: { error?: AppError } = {}) {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { instagram, calls } = fakeInstagram(options);
  const warnings: { accountId: string; code: string }[] = [];
  const deps: RefreshAccountTokensDeps = {
    platformAccounts,
    instagram,
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
  return { platformAccounts, calls, warnings, deps, add };
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

  it("token del panel (tokenRefreshedAt null): cuenta las 24 h desde connectedAt y obtiene el vencimiento real", async () => {
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
    // Sin force, igual queda fuera por los 59 días: el lote no lo toma hasta que falten 30.
    expect((await refreshAccountToken(deps, { accountId: day.id })).outcome).toBe("skipped");
    const result = await refreshAccountToken(deps, { accountId: day.id, force: true });
    expect(result.outcome).toBe("refreshed");
    expect(result.account.meta).toMatchObject({
      tokenRefreshedAt: NOW.toISOString(),
      tokenExpiryEstimated: false,
      permissions: null,
    });
    expect(calls).toEqual(["IGAA-panel"]);
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

  it("una meta ilegible se refresca con un aviso", async () => {
    const { warnings, deps, add } = setup();
    const account = await add({ meta: { connectedAt: "ayer", tokenRefreshedAt: ago(HOUR) } });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result.outcome).toBe("refreshed");
    expect(warnings).toEqual([{ accountId: account.id, code: "ACCOUNT_META_INVALID" }]);
  });

  it("otra plataforma no se refresca (unsupported)", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ platform: "portal_inmobiliario" });

    expect(await refreshAccountToken(deps, { accountId: account.id })).toMatchObject({
      outcome: "skipped",
      reason: "unsupported",
      refreshableAt: null,
    });
    expect(calls).toEqual([]);
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
    expect(warnings).toEqual([{ accountId: account.id, code: "ACCOUNT_STATUS_NOT_SAVED" }]);
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
});
