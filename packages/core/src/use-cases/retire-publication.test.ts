import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { PublishedRef } from "../ports/publisher.js";
import {
  createPostPublicationScenario,
  POST_SCENARIO_TOKEN,
} from "../testing/post-publication-scenario.js";
import { type RetireRemovalDeps, retirePublication } from "./retire-publication.js";

// F9-T19: retirar un post de LinkedIn borrándolo por la API (`deleteRemote`), solo con la cuenta en
// modo `api` y la API en `live`; en simulación nunca se llama. El `remove` es un doble.

const POST_URN = "urn:li:share:7380000000000000001";
const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return isAppError(error) ? error.code : error;
};

async function setup(
  options: { mode?: "api" | "manual"; dryRun?: boolean; externalId?: string } = {},
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
        externalId: options.externalId ?? POST_URN,
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000001/",
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
