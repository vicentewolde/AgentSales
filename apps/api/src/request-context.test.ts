import type {
  ListingLock,
  LockedRepositories,
  PostLock,
  PostLockedRepositories,
} from "@agentsales/core";
import { createInMemoryPublicationRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { withEventUser, withPostEventUser } from "./request-context.js";
import { createRequestContext } from "./request-context-node.js";

// F7-T10 (spec F7 §4.3): la persona de cada evento sale del pedido, también con pedidos a la vez.

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("el usuario del pedido en la bitácora", () => {
  it("dos pedidos concurrentes no se cruzan, y fuera de un pedido no hay usuario", async () => {
    const publications = createInMemoryPublicationRepository();
    // Un candado que tarda: los dos pedidos quedan intercalados.
    const lock: ListingLock = {
      run: async (_listingId, fn) => {
        await delay(5);
        return fn({ publications } as unknown as LockedRepositories);
      },
    };
    const context = createRequestContext();
    const wrapped = withEventUser(lock, context);
    const create = (format: "post" | "reel") =>
      wrapped.run("listing-1", async (repos) => {
        await delay(format === "post" ? 10 : 1);
        return repos.publications.create(
          {
            listingId: "listing-1",
            platformAccountId: "account-1",
            platform: "instagram",
            format,
            contentId: "content-1",
            mediaIds: [],
            listingSourceHash: "hash",
          },
          { actor: "operator" },
        );
      });

    const [first, second] = await Promise.all([
      context.run("usuario-a", () => create("post")),
      context.run("usuario-b", () => create("reel")),
    ]);
    const userOf = async (id: string) => (await publications.listEvents(id))[0]?.userId;
    expect(await userOf(first.id)).toBe("usuario-a");
    expect(await userOf(second.id)).toBe("usuario-b");

    // Fuera de un pedido (el worker), sin usuario; un `userId` explícito no se pisa.
    expect(context.currentUserId()).toBeNull();
    const system = await withEventUser(lock, context).run("listing-2", (repos) =>
      repos.publications.create(
        {
          listingId: "listing-2",
          platformAccountId: "account-1",
          platform: "instagram",
          format: "post",
          contentId: "content-1",
          mediaIds: [],
          listingSourceHash: "hash",
        },
        { actor: "system" },
      ),
    );
    expect(await userOf(system.id)).toBeNull();
  });

  it("con el candado de un post (F9) también firma cada evento con el usuario del pedido", async () => {
    const publications = createInMemoryPublicationRepository();
    const lock: PostLock = {
      run: async (_postId, fn) => {
        await delay(5);
        return fn({ publications } as unknown as PostLockedRepositories);
      },
    };
    const context = createRequestContext();
    const wrapped = withPostEventUser(lock, context);
    const create = (language: "es" | "en") =>
      wrapped.run("post-1", async (repos) => {
        await delay(language === "es" ? 10 : 1);
        return repos.publications.create(
          {
            postId: "post-1",
            platformAccountId: "account-1",
            platform: "instagram",
            format: "post",
            language,
            contentId: `content-${language}`,
            mediaIds: [],
          },
          { actor: "operator" },
        );
      });
    const [spanish, english] = await Promise.all([
      context.run("usuario-a", () => create("es")),
      context.run("usuario-b", () => create("en")),
    ]);
    const events = async (id: string) => publications.listEvents(id);
    expect((await events(spanish.id))[0]?.userId).toBe("usuario-a");
    expect((await events(english.id))[0]?.userId).toBe("usuario-b");
    // También las transiciones dentro del candado.
    await context.run("usuario-c", () =>
      wrapped.run("post-1", (repos) =>
        repos.publications.transition(
          spanish.id,
          { from: "approved", to: "cancelled" },
          { actor: "operator" },
        ),
      ),
    );
    expect((await events(spanish.id)).map((event) => event.userId)).toEqual([
      "usuario-a",
      "usuario-c",
    ]);
  });
});
