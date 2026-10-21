import { describe, expect, it } from "vitest";
import {
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPostRepository,
} from "../testing/index.js";
import { processPostMedia } from "./process-post-media.js";

// F9-T10 (spec F9 §4.5): las variantes de los medios de un post con el procesador falso: de una
// foto, `thumb` e `ig_4x5`; de un video, `thumb`, el reel sin texto y el video para X. Las claves
// van bajo `posts/{postId}/`, y una segunda vuelta no repite nada.

const encode = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const sha = (n: number) => n.toString(16).padStart(64, "0");

async function setup(options: { videoDurationS?: number } = {}) {
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const processor = createInMemoryMediaProcessor({
    version: "7",
    measure: (_input, kind) =>
      kind === "image"
        ? { width: 2000, height: 1500, durationS: null }
        : { width: 1920, height: 1080, durationS: options.videoDurationS ?? 30 },
  });
  const post = await posts.create({ brokerId: "brand-1", topic: "Bastidores", kind: "video" });
  const original = async (n: number, kind: "image" | "video", body: string) => {
    const ext = kind === "image" ? "jpg" : "mp4";
    const storagePath = `posts/${post.id}/original/${sha(n)}.${ext}`;
    await storage.put(storagePath, encode(body), kind === "image" ? "image/jpeg" : "video/mp4");
    return media.create({
      listingId: null,
      postId: post.id,
      brokerId: "brand-1",
      kind,
      storagePath,
      mime: kind === "image" ? "image/jpeg" : "video/mp4",
      bytes: body.length,
      checksum: sha(n),
      sortOrder: n,
      isCover: false,
    });
  };
  return {
    deps: { posts, media, storage, processor },
    posts,
    media,
    storage,
    processor,
    post,
    original,
  };
}

describe("processPostMedia", () => {
  it("foto: thumb e ig_4x5; video: thumb, reel sin texto y x_video; todo bajo posts/{postId}/", async () => {
    const s = await setup();
    const photo = await s.original(1, "image", "foto");
    const video = await s.original(2, "video", "video");
    const result = await processPostMedia(s.deps, { postId: s.post.id });
    expect(result).toEqual({
      outcome: "processed",
      media: { processed: 2, existing: 0, failed: 0 },
      failedMediaIds: [],
    });
    // Sin pi_4x3 (un post no va a Portal) y el reel sin el PNG del texto.
    expect(s.processor.calls).toEqual([
      { kind: "image", mime: "image/jpeg", variants: ["thumb", "ig_4x5"], inputBytes: 4 },
      { kind: "video", reel: true, xVideo: true, inputBytes: 5 },
    ]);

    const all = await s.media.listBySubject({ kind: "post", id: s.post.id });
    const derived = all
      .filter((item) => item.role === "processed")
      .map((item) => [item.parentMediaId, item.variant, item.kind, item.storagePath]);
    const root = `posts/${s.post.id}/processed`;
    expect(derived).toEqual(
      expect.arrayContaining([
        [photo.id, "thumb", "image", `${root}/thumb/${sha(1)}-v7.jpg`],
        [photo.id, "ig_4x5", "image", `${root}/ig_4x5/${sha(1)}-v7.jpg`],
        [video.id, "thumb", "image", `${root}/thumb/${sha(2)}-v7.jpg`],
        [video.id, "ig_reel", "video", `${root}/ig_reel/${sha(2)}-v7.mp4`],
        [video.id, "x_video", "video", `${root}/x_video/${sha(2)}-v7.mp4`],
      ]),
    );
    expect(derived).toHaveLength(5);
    expect(all.every((item) => item.postId === s.post.id && item.listingId === null)).toBe(true);
    expect(
      [...s.storage.objects.keys()].every((path) => path.startsWith(`posts/${s.post.id}/`)),
    ).toBe(true);
    // Las medidas del original quedan guardadas.
    expect(all.find((item) => item.id === video.id)).toMatchObject({ width: 1920, durationS: 30 });

    // Una segunda vuelta (el job reintentado o encolado otra vez) no repite nada.
    const again = await processPostMedia(s.deps, { postId: s.post.id });
    expect(again).toMatchObject({ media: { processed: 0, existing: 2, failed: 0 } });
    expect(s.processor.calls).toHaveLength(2);
  });

  it("solo arma lo que falta: sin el video para X, se pide solo ese (sin reel)", async () => {
    const s = await setup();
    const video = await s.original(1, "video", "video");
    await processPostMedia(s.deps, { postId: s.post.id });
    const x = (await s.media.listBySubject({ kind: "post", id: s.post.id })).find(
      (item) => item.variant === "x_video",
    );
    await s.media.deleteDerivative(x?.id ?? "");
    await processPostMedia(s.deps, { postId: s.post.id });
    expect(s.processor.calls.at(-1)).toEqual({
      kind: "video",
      reel: false,
      xVideo: true,
      inputBytes: 5,
    });
    const variants = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
      .filter((item) => item.parentMediaId === video.id)
      .map((item) => item.variant)
      .sort();
    expect(variants).toEqual(["ig_reel", "thumb", "x_video"]);
  });

  it("un video de menos de 3 s no da reel, pero sí thumb y video para X", async () => {
    const s = await setup({ videoDurationS: 2 });
    await s.original(1, "video", "corto");
    await processPostMedia(s.deps, { postId: s.post.id });
    const variants = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
      .filter((item) => item.role === "processed")
      .map((item) => item.variant)
      .sort();
    expect(variants).toEqual(["thumb", "x_video"]);
    // Ya medido: la segunda vuelta no lo vuelve a leer.
    expect(await processPostMedia(s.deps, { postId: s.post.id })).toMatchObject({
      media: { existing: 1 },
    });
    expect(s.processor.calls).toHaveLength(1);
  });

  it("un original ilegible es un fallo de ese medio y los demás siguen; un post archivado o que no existe se salta", async () => {
    const s = await setup();
    const broken = await s.original(1, "image", "CORRUPTO-foto");
    await s.original(2, "image", "foto-buena");
    expect(await processPostMedia(s.deps, { postId: s.post.id })).toEqual({
      outcome: "processed",
      media: { processed: 1, existing: 0, failed: 1 },
      failedMediaIds: [broken.id],
    });
    expect(
      await processPostMedia(s.deps, { postId: "00000000-0000-4000-8000-0000000000ff" }),
    ).toEqual({ outcome: "skipped", reason: "not_found" });
    await s.posts.archive(s.post.id);
    expect(await processPostMedia(s.deps, { postId: s.post.id })).toEqual({
      outcome: "skipped",
      reason: "archived",
    });
  });

  it("cortado por el apagado: MEDIA_ABORTED reintentable", async () => {
    const s = await setup();
    await s.original(1, "image", "foto");
    // Core no carga los tipos del DOM ni de Node: una señal ya cortada, a mano.
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    await expect(processPostMedia(s.deps, { postId: s.post.id, signal })).rejects.toMatchObject({
      code: "MEDIA_ABORTED",
      retriable: true,
    });
  });
});
