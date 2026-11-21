import { describe, expect, it } from "vitest";
import type { Language, PostPlatform } from "../enums.js";
import { postSubject } from "../subject.js";
import { createPostPublicationScenario } from "../testing/index.js";
import { removePostMedia } from "./remove-post-media.js";

// Quitar una foto o un video de un post (2026-11-21).

const ADMIN = { id: "admin-1", role: "admin" as const, brokerId: null };
const otherBroker = { id: "u-otro", role: "broker" as const, brokerId: "otro-corredor" };

/** Un carrusel con tres fotos y X conectada; con `texts`, sus publicaciones aprobadas. */
async function setup(texts: { platform: PostPlatform; language: Language }[] = []) {
  const t = await createPostPublicationScenario({
    kind: "carousel",
    images: 3,
    texts,
    accounts: [{ platform: "x" }],
  });
  const originals = await t.media.listOriginals(postSubject(t.post.id));
  const [first, second] = originals;
  if (first === undefined || second === undefined) throw new Error("faltan las fotos");
  const deleted: string[] = [];
  const storage = {
    async delete(path: string) {
      deleted.push(path);
    },
  };
  const deps = { posts: t.posts, postLock: t.postLock, storage };
  return { t, deps, first, second, deleted };
}

describe("removePostMedia", () => {
  it("quita el original con sus variantes y borra sus archivos", async () => {
    const { t, deps, first, deleted } = await setup();
    const result = await removePostMedia(deps, ADMIN, t.post.id, first.id);
    expect(result).toEqual({ mediaId: first.id, updatedPublicationIds: [], leftover: 0 });
    const left = await t.media.listBySubject(postSubject(t.post.id));
    expect(left.some((item) => item.id === first.id || item.parentMediaId === first.id)).toBe(
      false,
    );
    expect(left.filter((item) => item.role === "original")).toHaveLength(2);
    expect(deleted).toEqual(
      expect.arrayContaining([first.storagePath, expect.stringContaining("/ig_4x5/")]),
    );
  });

  it("cuenta los archivos que no se pudieron borrar sin deshacer el cambio", async () => {
    const { t, deps, first } = await setup();
    const failing = {
      ...deps,
      storage: {
        async delete() {
          throw new Error("R2 no responde");
        },
      },
    };
    const result = await removePostMedia(failing, ADMIN, t.post.id, first.id);
    expect(result.leftover).toBeGreaterThan(0);
    expect(
      (await t.media.listOriginals(postSubject(t.post.id))).some((item) => item.id === first.id),
    ).toBe(false);
  });

  it("lo ajeno es 404, un id que no es original es MEDIA_NOT_FOUND y un post archivado se niega", async () => {
    const { t, deps, first } = await setup();
    await expect(removePostMedia(deps, otherBroker, t.post.id, first.id)).rejects.toMatchObject({
      code: "POST_NOT_FOUND",
    });
    await expect(removePostMedia(deps, ADMIN, t.post.id, "no-existe")).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
    });
    const variant = (await t.media.listBySubject(postSubject(t.post.id))).find(
      (item) => item.parentMediaId === first.id,
    );
    await expect(
      removePostMedia(deps, ADMIN, t.post.id, variant?.id ?? "sin-variante"),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    await t.posts.update(t.post.id, { status: "archived" });
    await expect(removePostMedia(deps, ADMIN, t.post.id, first.id)).rejects.toMatchObject({
      code: "POST_ARCHIVED",
    });
  });

  it("a una publicación aprobada que lo usa se le quita de sus medios, con su evento", async () => {
    const { t, deps, first } = await setup([{ platform: "x", language: "es" }]);
    const publication = t.publicationOf("x");
    expect(publication.mediaIds).toHaveLength(3);
    const result = await removePostMedia(deps, ADMIN, t.post.id, first.id);
    expect(result.updatedPublicationIds).toEqual([publication.id]);
    const updated = await t.publications.get(publication.id);
    expect(updated?.status).toBe("approved");
    expect(updated?.mediaIds).toHaveLength(2);
    expect((await t.publications.listEvents(publication.id)).at(-1)).toMatchObject({
      type: "manual_edit",
      payload: { mediaRemoved: [expect.any(String)] },
    });
  });

  it.each([
    ["scheduled", "desprográmala"],
    ["published", "retírala primero"],
    ["outcome_unknown", "resolver"],
    ["awaiting_manual_confirm", "no publicada"],
  ] as const)(
    "con una publicación %s que lo usa se niega y dice qué hacer",
    async (status, hint) => {
      const { t, deps, first } = await setup([{ platform: "x", language: "es" }]);
      const publication = t.publicationOf("x");
      if (status === "scheduled") {
        await t.publications.transition(
          publication.id,
          {
            from: "approved",
            to: "scheduled",
            changes: { dryRun: true, scheduledAt: new Date("2026-12-01T13:00:00Z") },
          },
          { actor: "operator" },
        );
      } else {
        await t.toPublishing(publication, { dryRun: true });
        await t.publications.transition(
          publication.id,
          { from: "publishing", to: status },
          { actor: "system" },
        );
      }
      const error = await removePostMedia(deps, ADMIN, t.post.id, first.id).catch((e) => e);
      expect(error).toMatchObject({
        code: "POST_MEDIA_IN_USE",
        details: { publicationId: publication.id, status },
      });
      expect(error.message).toContain("X en español");
      expect(error.message).toContain(hint);
      // No se borró nada.
      expect(
        (await t.media.listOriginals(postSubject(t.post.id))).some((item) => item.id === first.id),
      ).toBe(true);
    },
  );

  it("una publicación descartada no lo impide ni cambia", async () => {
    const { t, deps, first } = await setup([{ platform: "x", language: "es" }]);
    const publication = t.publicationOf("x");
    await t.publications.transition(
      publication.id,
      { from: "approved", to: "cancelled" },
      { actor: "operator" },
    );
    const result = await removePostMedia(deps, ADMIN, t.post.id, first.id);
    expect(result.updatedPublicationIds).toEqual([]);
    expect((await t.publications.get(publication.id))?.mediaIds).toHaveLength(3);
  });
});
