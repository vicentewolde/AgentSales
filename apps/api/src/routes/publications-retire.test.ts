import type { PublishedRef, PublishMode } from "@agentsales/core";
import { createPostPublicationScenario, POST_SCENARIO_TOKEN } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { errorBodySchema, publicationRetireResponseSchema } from "../contracts/index.js";
import { adminApp, testDeps } from "../testing/index.js";

// F9-T19: `POST /publications/:id/retire` con `deleteRemote` borra un post de LinkedIn por la API
// (cuenta en modo `api`, API en `live`) antes de marcarlo retirado. LinkedIn es un doble.

const POST_URN = "urn:li:share:7380000000000000001";

async function setup(options: { publishMode?: PublishMode; mode?: "api" | "manual" } = {}) {
  const t = await createPostPublicationScenario({
    texts: [{ platform: "linkedin", language: "es" }],
    accounts: [
      { platform: "linkedin", meta: { memberId: "miembro-123", mode: options.mode ?? "api" } },
    ],
  });
  const started = await t.toPublishing(t.publicationOf("linkedin"));
  const publication = await t.publications.transition(
    started.id,
    { from: "publishing", to: "published", changes: { externalId: POST_URN } },
    { actor: "system", payload: { mode: "live" } },
  );
  const removed: Array<{ ref: PublishedRef; token: string }> = [];
  const app = adminApp(
    testDeps({
      brokers: t.repos.brokers,
      posts: t.posts,
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      lock: t.lock,
      postLock: t.postLock,
      publishMode: options.publishMode ?? "live",
      operationsFor: (platform) =>
        platform === "linkedin"
          ? {
              async remove(ref, ctx) {
                removed.push({ ref, token: await ctx.accessToken() });
              },
            }
          : undefined,
    }),
  );
  const retire = (body: unknown) =>
    app.request(`/publications/${publication.id}/retire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { t, publication, removed, retire };
}

const codeOf = async (response: Response) =>
  errorBodySchema.parse(await response.json()).error.code;

describe("POST /publications/:id/retire con deleteRemote (F9-T19)", () => {
  it("en vivo y con la cuenta en modo api, borra en LinkedIn y la deja retirada", async () => {
    const { publication, removed, retire } = await setup();

    const response = await retire({ deleteRemote: true });

    expect(response.status).toBe(200);
    expect(publicationRetireResponseSchema.parse(await response.json())).toMatchObject({
      publication: { id: publication.id, status: "unpublished" },
      listingBackToReady: false,
    });
    expect(removed).toEqual([
      { ref: { externalId: POST_URN, progress: null }, token: POST_SCENARIO_TOKEN },
    ]);
  });

  it("con la API en simulación es 409 PUBLISH_MODE_MISMATCH sin llamar", async () => {
    const { removed, retire } = await setup({ publishMode: "dry-run" });

    const response = await retire({ deleteRemote: true });

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("PUBLISH_MODE_MISMATCH");
    expect(removed).toEqual([]);
  });

  it("con la cuenta a mano es 409 RETIRE_DELETE_UNSUPPORTED; las dos opciones juntas, 400", async () => {
    const { removed, retire } = await setup({ mode: "manual" });

    const manual = await retire({ deleteRemote: true });
    expect(manual.status).toBe(409);
    expect(await codeOf(manual)).toBe("RETIRE_DELETE_UNSUPPORTED");
    expect((await retire({ deleteRemote: true, removedByHand: true })).status).toBe(400);
    expect(removed).toEqual([]);
  });
});
