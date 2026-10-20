import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import {
  createInMemoryEditorialProfileRepository,
  createPostPublicationScenario,
} from "../testing/index.js";
import { getPostContent, postContentId } from "./get-post-content.js";

// F9-T12 (spec F9 §4.10): los textos de un post con su revisión, su corrida y sus publicaciones,
// y el texto vigente de una red e idioma, con el alcance de siempre (lo ajeno no existe).

const ADMIN = { id: "admin", role: "admin" as const, brokerId: null };
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (isAppError(error) ? error.code : error),
  );

async function setup() {
  const t = await createPostPublicationScenario({
    texts: [
      { platform: "x", language: "en" },
      { platform: "discord", language: "es" },
      { platform: "x", language: "es" },
    ],
  });
  const deps = {
    ...t.repos,
    editorialProfiles: createInMemoryEditorialProfileRepository(),
  };
  return { t, deps };
}

describe("getPostContent", () => {
  it("los textos en el orden de las redes y los idiomas, con su revisión y las publicaciones", async () => {
    const { t, deps } = await setup();
    const result = await getPostContent(deps, ADMIN, t.post.id);
    expect(result.post.id).toBe(t.post.id);
    expect(result.contents.map(({ content }) => `${content.platform}/${content.language}`)).toEqual(
      ["x/es", "x/en", "discord/es"],
    );
    expect(result.contents.every(({ checks }) => Array.isArray(checks))).toBe(true);
    expect(result.latestRun?.status).toBe("succeeded");
    expect(result.publications.map((p) => p.id).sort()).toEqual(t.approved.map((p) => p.id).sort());
  });

  it("un corredor de otra marca no lo ve (POST_NOT_FOUND)", async () => {
    const { t, deps } = await setup();
    const other = { id: "u", role: "broker" as const, brokerId: "otra-marca" };
    expect(await codeOf(getPostContent(deps, other, t.post.id))).toBe("POST_NOT_FOUND");
    const own = { id: "u", role: "broker" as const, brokerId: t.broker.id };
    await expect(getPostContent(deps, own, t.post.id)).resolves.toMatchObject({
      post: { id: t.post.id },
    });
  });
});

describe("postContentId", () => {
  it("el texto vigente de la red y el idioma; sin él, CONTENT_NOT_FOUND", async () => {
    const { t, deps } = await setup();
    const id = await postContentId(deps, ADMIN, {
      postId: t.post.id,
      platform: "x",
      language: "en",
    });
    const content = await t.contents.get(id);
    expect(content).toMatchObject({ platform: "x", language: "en" });
    expect(
      await codeOf(
        postContentId(deps, ADMIN, { postId: t.post.id, platform: "linkedin", language: "es" }),
      ),
    ).toBe("CONTENT_NOT_FOUND");
  });
});
