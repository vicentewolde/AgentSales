import type { ListingLock, LockedRepositories } from "@agentsales/core";
import { createInMemoryPublicationRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { withEventUser } from "./request-context.js";
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
});
