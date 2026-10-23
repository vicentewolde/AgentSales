import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { PublishedRef } from "../ports/publisher.js";
import {
  createPostPublicationScenario,
  POST_SCENARIO_TOKEN,
} from "../testing/post-publication-scenario.js";
import {
  REMOTE_DELETE_PLATFORMS,
  type RetireRemovalDeps,
  retirePublication,
} from "./retire-publication.js";

// F9-T19: retirar un post de LinkedIn borrándolo por la API (`deleteRemote`), solo con la cuenta en
// modo `api` y la API en `live`; en simulación nunca se llama. El `remove` es un doble.

const POST_URN = "urn:li:share:7380000000000000001";
const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return isAppError(error) ? error.code : error;
};

async function setup(
  options: { mode?: "api" | "manual"; dryRun?: boolean; externalId?: string | null } = {},
) {
  const t = await createPostPublicationScenario({
    texts: [{ platform: "linkedin", language: "es" }],
    accounts: [
      {
        platform: "linkedin",
        meta: { memberId: "miembro-123", mode: options.mode ?? "api" },
        tokenExpiresAt: new Date("2026-12-19T12:00:00Z"),
      },
    ],
  });
  const started = await t.toPublishing(t.publicationOf("linkedin"), {
    dryRun: options.dryRun ?? false,
  });
  const publication = await t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: options.externalId === undefined ? POST_URN : options.externalId,
        externalUrl:
          options.externalId === null
            ? null
            : "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000001/",
        publishedAt: new Date("2026-10-20T12:00:00Z"),
      },
    },
    { actor: "system", payload: { mode: options.dryRun ? "dry-run" : "live" } },
  );
  const calls: Array<{ ref: PublishedRef; token: string }> = [];
  let failWith: AppError | null = null;
  const removal = (apiMode: "live" | "dry-run" = "live"): RetireRemovalDeps => ({
    apiMode,
    platformAccounts: t.platformAccounts,
    operationsFor: (platform) =>
      platform === "linkedin"
        ? {
            async remove(ref, ctx) {
              calls.push({ ref, token: await ctx.accessToken() });
              if (failWith !== null) throw failWith;
            },
          }
        : undefined,
  });
  const retire = (
    extra: { deleteRemote?: boolean; removedByHand?: boolean } = { deleteRemote: true },
    apiMode: "live" | "dry-run" = "live",
  ) =>
    retirePublication(
      { ...t.subjectDeps, removal: removal(apiMode) },
      { publicationId: publication.id, actor: "operator", ...extra },
    );
  const fail = (error: AppError | null) => {
    failWith = error;
  };
  return { t, publication, calls, retire, fail };
}

describe("retirar borrando por la API (F9-T19)", () => {
  it("en vivo, con la cuenta en modo api: borra con el token guardado y queda unpublished", async () => {
    const { t, publication, calls, retire } = await setup();

    await expect(retire()).resolves.toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
    expect(calls).toEqual([
      { ref: { externalId: POST_URN, progress: null }, token: POST_SCENARIO_TOKEN },
    ]);
    const event = (await t.publications.listEvents(publication.id)).at(-1);
    expect(event?.payload).toEqual({ mode: "live", removedByHand: false, removedByApi: true });
  });

  it("con la API en simulación no llama: PUBLISH_MODE_MISMATCH, sin cambiar nada", async () => {
    const { t, publication, calls, retire } = await setup();

    expect(await codeOf(retire({ deleteRemote: true }, "dry-run"))).toBe("PUBLISH_MODE_MISMATCH");
    expect(calls).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("published");
  });

  it("una publicación simulada se retira sin llamar (no hay nada que borrar)", async () => {
    const { t, publication, calls, retire } = await setup({ dryRun: true });

    await expect(retire()).resolves.toMatchObject({ publication: { status: "unpublished" } });
    expect(calls).toEqual([]);
    expect((await t.publications.listEvents(publication.id)).at(-1)?.payload).toEqual({
      mode: "dry-run",
      removedByHand: false,
    });
  });

  it("con la cuenta a mano: RETIRE_DELETE_UNSUPPORTED sin llamar; a mano sigue sirviendo", async () => {
    const { t, publication, calls, retire } = await setup({ mode: "manual" });

    expect(await codeOf(retire())).toBe("RETIRE_DELETE_UNSUPPORTED");
    expect(calls).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("published");
    // Sin `deleteRemote`, en vivo sigue pidiendo la confirmación de que se borró a mano.
    expect(await codeOf(retire({}))).toBe("REMOVAL_NOT_CONFIRMED");
    await expect(retire({ removedByHand: true })).resolves.toMatchObject({
      publication: { status: "unpublished" },
    });
  });

  it("confirmada a mano sin enlace (sin id en la red): no se borra por la API, se retira a mano", async () => {
    const { t, publication, calls, retire } = await setup({ externalId: null });

    const error = await caught(retire());
    expect(error).toMatchObject({
      code: "RETIRE_DELETE_UNSUPPORTED",
      message: expect.stringContaining("La publicación no tiene su id en la red"),
    });
    expect(calls).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("published");
    await expect(retire({ removedByHand: true })).resolves.toMatchObject({
      publication: { status: "unpublished" },
    });
  });

  it("las dos opciones juntas se rechazan, y una red sin remove también", async () => {
    const { calls, retire } = await setup();
    expect(await codeOf(retire({ deleteRemote: true, removedByHand: true }))).toBe(
      "RETIRE_OPTIONS_INVALID",
    );

    const discord = await createPostPublicationScenario();
    const started = await discord.toPublishing(discord.publicationOf("discord"));
    const published = await discord.publications.transition(
      started.id,
      { from: "publishing", to: "published", changes: { externalId: "123" } },
      { actor: "system", payload: { mode: "live" } },
    );
    expect(
      await codeOf(
        retirePublication(
          {
            ...discord.subjectDeps,
            removal: {
              apiMode: "live",
              platformAccounts: discord.platformAccounts,
              operationsFor: () => undefined,
            },
          },
          { publicationId: published.id, actor: "operator", deleteRemote: true },
        ),
      ),
    ).toBe("RETIRE_DELETE_UNSUPPORTED");
    expect(calls).toEqual([]);
    expect(discord.current(published.id)?.status).toBe("published");
  });

  it("un acceso rechazado deja la cuenta vencida y la publicación publicada", async () => {
    const { t, publication, retire, fail } = await setup();
    fail(new AppError("LINKEDIN_AUTH_INVALID", "LinkedIn no acepta el acceso"));

    expect(await codeOf(retire())).toBe("LINKEDIN_AUTH_INVALID");
    expect(t.current(publication.id)?.status).toBe("published");
    const account = await t.platformAccounts.get(publication.platformAccountId);
    expect(account?.status).toBe("expired");
  });

  it("si la red borró pero algo falla después, retirar de nuevo vuelve a borrar sin error", async () => {
    const { t, publication, calls, retire, fail } = await setup();
    fail(new AppError("LINKEDIN_UNAVAILABLE", "LinkedIn no respondió", { retriable: true }));
    expect(await codeOf(retire())).toBe("LINKEDIN_UNAVAILABLE");
    expect(t.current(publication.id)?.status).toBe("published");

    fail(null);
    await expect(retire()).resolves.toMatchObject({ publication: { status: "unpublished" } });
    expect(calls).toHaveLength(2);
  });
});

// F9.5-T09: X borra con el token que asegura `ensureRotatingAccessToken` (renovado bajo el candado
// de credenciales si está por vencer); TikTok no tiene cómo borrar por la API (D9).
describe("retirar borrando en X y TikTok (F9.5-T09)", () => {
  const NOW = new Date("2026-10-22T12:00:00Z");
  const SOON = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  const LATER = new Date(NOW.getTime() + 2 * 3600_000).toISOString();
  const X_POST_ID = "1850000000000000001";

  async function xSetup(options: { accessTokenExpiresAt?: string; dryRun?: boolean } = {}) {
    const t = await createPostPublicationScenario({
      texts: [{ platform: "x", language: "es" }],
      accounts: [
        {
          platform: "x",
          meta: { accessTokenExpiresAt: options.accessTokenExpiresAt ?? LATER, mode: "api" },
        },
      ],
    });
    const started = await t.toPublishing(t.publicationOf("x"), {
      dryRun: options.dryRun ?? false,
    });
    const publication = await t.publications.transition(
      started.id,
      { from: "publishing", to: "published", changes: { externalId: X_POST_ID } },
      { actor: "system", payload: { mode: options.dryRun ? "dry-run" : "live" } },
    );
    const removed: Array<{ ref: PublishedRef; token: string }> = [];
    const refreshed: string[] = [];
    let locks = 0;
    const platformAccounts = {
      get: t.platformAccounts.get,
      getCredentials: t.platformAccounts.getCredentials,
      changeStatus: t.platformAccounts.changeStatus,
      withCredentialsLock: ((
        ...args: Parameters<typeof t.platformAccounts.withCredentialsLock>
      ) => {
        locks += 1;
        return t.platformAccounts.withCredentialsLock(...args);
      }) as typeof t.platformAccounts.withCredentialsLock,
    };
    const refresher = {
      async refresh(refreshToken: string) {
        refreshed.push(refreshToken);
        return {
          accessToken: "token-x-nuevo",
          refreshToken: "refresh-x-nuevo",
          accessTokenExpiresAt: new Date(NOW.getTime() + 2 * 3600_000),
          refreshTokenExpiresAt: null,
        };
      },
      isRejected: () => false,
    };
    const retire = (
      extra: { apiMode?: "live" | "dry-run"; withRefresher?: boolean } = {},
    ): Promise<unknown> =>
      retirePublication(
        {
          ...t.subjectDeps,
          removal: {
            apiMode: extra.apiMode ?? "live",
            platformAccounts,
            now: () => NOW,
            ...(extra.withRefresher === false ? {} : { refreshers: { x: refresher } }),
            operationsFor: (platform) =>
              platform === "x"
                ? {
                    async remove(ref, ctx) {
                      removed.push({ ref, token: await ctx.accessToken() });
                    },
                  }
                : undefined,
          },
        },
        { publicationId: publication.id, actor: "operator", deleteRemote: true },
      );
    return { t, publication, removed, refreshed, locks: () => locks, retire };
  }

  it("en vivo, con el token vigente: borra en X sin renovar y queda unpublished", async () => {
    const { t, publication, removed, refreshed, retire } = await xSetup();

    await expect(retire()).resolves.toMatchObject({ publication: { status: "unpublished" } });
    expect(removed).toEqual([
      { ref: { externalId: X_POST_ID, progress: null }, token: POST_SCENARIO_TOKEN },
    ]);
    expect(refreshed).toEqual([]);
    expect((await t.publications.listEvents(publication.id)).at(-1)?.payload).toEqual({
      mode: "live",
      removedByHand: false,
      removedByApi: true,
    });
  });

  it("con el token por vencer: lo renueva una vez bajo el candado, guarda el par y borra con el nuevo", async () => {
    const { t, publication, removed, refreshed, locks, retire } = await xSetup({
      accessTokenExpiresAt: SOON,
    });

    await expect(retire()).resolves.toMatchObject({ publication: { status: "unpublished" } });
    expect(refreshed).toEqual(["refresh-post-prueba"]);
    expect(locks()).toBe(1);
    expect(removed.map((call) => call.token)).toEqual(["token-x-nuevo"]);
    expect(await t.platformAccounts.getCredentials(publication.platformAccountId)).toEqual({
      accessToken: "token-x-nuevo",
      refreshToken: "refresh-x-nuevo",
    });
  });

  it("sin la renovación de X y el token por vencer: TOKEN_REFRESH_NOT_CONFIGURED, sin borrar", async () => {
    const { t, publication, removed, retire } = await xSetup({ accessTokenExpiresAt: SOON });

    expect(await codeOf(retire({ withRefresher: false }))).toBe("TOKEN_REFRESH_NOT_CONFIGURED");
    expect(removed).toEqual([]);
    expect(t.current(publication.id)?.status).toBe("published");
  });

  it("solo en vivo: con la API en simulación no renueva ni borra; una simulada se retira sin llamar", async () => {
    const live = await xSetup({ accessTokenExpiresAt: SOON });
    expect(await codeOf(live.retire({ apiMode: "dry-run" }))).toBe("PUBLISH_MODE_MISMATCH");
    expect(live.removed).toEqual([]);
    expect(live.refreshed).toEqual([]);
    expect(live.t.current(live.publication.id)?.status).toBe("published");

    const simulated = await xSetup({ dryRun: true });
    await expect(simulated.retire()).resolves.toMatchObject({
      publication: { status: "unpublished" },
    });
    expect(simulated.removed).toEqual([]);
  });

  it("TikTok: TIKTOK_DELETE_UNSUPPORTED con el mensaje de borrarlo a mano en la app, sin llamar", async () => {
    // TikTok publica solo videos.
    const t = await createPostPublicationScenario({
      kind: "video",
      images: 0,
      video: true,
      texts: [{ platform: "tiktok", language: "es" }],
    });
    const started = await t.toPublishing(t.publicationOf("tiktok"));
    const published = await t.publications.transition(
      started.id,
      { from: "publishing", to: "published", changes: { externalId: "7430000000000000001" } },
      { actor: "system", payload: { mode: "live" } },
    );
    const calls: PublishedRef[] = [];
    const error = await caught(
      retirePublication(
        {
          ...t.subjectDeps,
          removal: {
            apiMode: "live",
            platformAccounts: t.platformAccounts,
            // Aunque la red tuviera `remove`, TikTok no se borra por la API.
            operationsFor: () => ({
              async remove(ref) {
                calls.push(ref);
              },
            }),
          },
        },
        { publicationId: published.id, actor: "operator", deleteRemote: true },
      ),
    );
    expect(isAppError(error) && error.code).toBe("TIKTOK_DELETE_UNSUPPORTED");
    expect(isAppError(error) && error.message).toContain("bórralo a mano en la app de TikTok");
    expect(isAppError(error) && error.details).toEqual({
      publicationId: published.id,
      platform: "tiktok",
    });
    expect(calls).toEqual([]);
    expect(t.current(published.id)?.status).toBe("published");
  });
});

describe("REMOTE_DELETE_PLATFORMS (F9.5-T09)", () => {
  it("LinkedIn y X se borran por la API; TikTok no (D9)", () => {
    expect([...REMOTE_DELETE_PLATFORMS].sort()).toEqual(["linkedin", "x"]);
    expect(REMOTE_DELETE_PLATFORMS.has("tiktok")).toBe(false);
  });
});
