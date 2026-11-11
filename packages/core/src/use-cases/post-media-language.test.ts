import { describe, expect, it } from "vitest";
import type { Language, PostPlatform } from "../enums.js";
import { postSubject } from "../subject.js";
import { createPostPublicationScenario } from "../testing/index.js";
import { planPostPublications } from "./open-publications.js";
import { setPostMediaLanguage } from "./post-media-language.js";

// ADR-0042: marcar el idioma de una foto de un post, y lo que eso cambia al abrir sus publicaciones.

const ADMIN = { id: "admin-1", role: "admin" as const, brokerId: null };
const otherBroker = { id: "u-otro", role: "broker" as const, brokerId: "otro-corredor" };

/** Un post de imagen con dos fotos, sin textos (sin publicaciones) y con X e Instagram conectadas. */
async function setup(texts: { platform: PostPlatform; language: Language }[] = []) {
  const t = await createPostPublicationScenario({
    kind: "image",
    images: 2,
    texts,
    accounts: [{ platform: "x" }, { platform: "instagram" }],
  });
  const originals = await t.media.listOriginals(postSubject(t.post.id));
  const [first, second] = originals;
  if (first === undefined || second === undefined) throw new Error("faltan las fotos");
  const deps = { posts: t.posts, postLock: t.postLock };
  return { t, deps, first, second };
}

describe("setPostMediaLanguage", () => {
  it("marca y desmarca el idioma de una foto del post", async () => {
    const { t, deps, first } = await setup();
    const marked = await setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, "en");
    expect(marked.language).toBe("en");
    const cleared = await setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, null);
    expect(cleared.language).toBeNull();
  });

  it("lo ajeno es 404, un medio de otro post es MEDIA_NOT_FOUND y un post archivado se niega", async () => {
    const { t, deps, first } = await setup();
    await expect(
      setPostMediaLanguage(deps, otherBroker, t.post.id, first.id, "en"),
    ).rejects.toMatchObject({ code: "POST_NOT_FOUND" });
    await expect(
      setPostMediaLanguage(deps, ADMIN, t.post.id, "no-existe", "en"),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    await t.posts.update(t.post.id, { status: "archived" });
    await expect(
      setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, "en"),
    ).rejects.toMatchObject({ code: "POST_ARCHIVED" });
  });

  it("con una publicación aprobada (medios ya fijados) se niega, salvo que no cambie nada", async () => {
    const { t, deps, first } = await setup([{ platform: "x", language: "es" }]);
    expect(t.approved).toHaveLength(1);
    await expect(
      setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, "en"),
    ).rejects.toMatchObject({ code: "POST_MEDIA_IN_USE" });
    expect((await setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, null)).language).toBe(
      null,
    );
  });

  it("al abrir las publicaciones: X lleva la imagen de su idioma; Instagram, las dos", async () => {
    const { t, deps, first, second } = await setup();
    await setPostMediaLanguage(deps, ADMIN, t.post.id, first.id, "es");
    await setPostMediaLanguage(deps, ADMIN, t.post.id, second.id, "en");
    const run = await t.repos.contentRuns.create({ postId: t.post.id, texts: true });
    await t.repos.contentRuns.markRunning(run.id);
    await t.repos.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: (
        [
          ["x", "es"],
          ["x", "en"],
          ["instagram", "en"],
        ] as const
      ).map(([platform, language]) => ({
        platform,
        language,
        title: null,
        body: `Texto ${language}`,
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-v1",
        rawOutput: null,
      })),
    });
    const current = await t.contents.listCurrent(postSubject(t.post.id));
    const opened = async (platform: PostPlatform, language: Language) => {
      const content = current.find(
        (item) => item.platform === platform && item.language === language,
      );
      if (content === undefined) throw new Error(`sin texto ${platform}/${language}`);
      const { toCreate } = await planPostPublications(t.repos, { post: t.post, content });
      return toCreate.map((item) => item.mediaIds);
    };
    const [es, en] = t.images.map((item) => item.id);
    expect(await opened("x", "es")).toEqual([[es]]);
    expect(await opened("x", "en")).toEqual([[en]]);
    expect(await opened("instagram", "en")).toEqual([[en, es]]);
  });
});
