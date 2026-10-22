import { describe, expect, it } from "vitest";
import type { PostPlatform } from "../enums.js";
import { DISCORD_VIDEO_MAX_BYTES } from "../media-checks.js";
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

async function setup(
  options: {
    videoDurationS?: number;
    platforms?: PostPlatform[] | null;
    discordVideoFails?: boolean;
    discordVideoThrows?: boolean;
    musicFails?: boolean;
  } = {},
) {
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const processor = createInMemoryMediaProcessor({
    version: "7",
    measure: (_input, kind) =>
      kind === "image"
        ? { width: 2000, height: 1500, durationS: null }
        : { width: 1920, height: 1080, durationS: options.videoDurationS ?? 30 },
    ...(options.discordVideoFails === undefined
      ? {}
      : { discordVideoFails: options.discordVideoFails }),
    ...(options.discordVideoThrows === undefined
      ? {}
      : { discordVideoThrows: options.discordVideoThrows }),
    ...(options.musicFails === undefined ? {} : { musicFails: options.musicFails }),
  });
  const post = await posts.create({
    brokerId: "brand-1",
    topic: "Bastidores",
    kind: "video",
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  });
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
      warnings: [],
    });
    // Sin pi_4x3 (un post no va a Portal) y el reel sin el PNG del texto.
    expect(s.processor.calls).toEqual([
      { kind: "image", mime: "image/jpeg", variants: ["thumb", "ig_4x5"], inputBytes: 4 },
      {
        kind: "video",
        reel: true,
        xVideo: true,
        discordMaxBytes: null,
        inputBytes: 5,
        music: null,
      },
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
      discordMaxBytes: null,
      inputBytes: 5,
      music: null,
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
      warnings: [],
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

  // F9.5-T10 (D8): con un límite por archivo chico (los bytes de prueba del procesador falso pesan
  // unos 30), el video más liviano "no cabe" en Discord y se pide aparte el video liviano, con el
  // tope de siempre (19 MiB: con 30 s, el bitrate queda sobre el mínimo).
  const smallLimits = { fileMaxBytes: 10, videoMaxBytes: DISCORD_VIDEO_MAX_BYTES };

  it("va a Discord y el video más liviano no cabe: arma discord_video aparte, con el tope", async () => {
    const s = await setup({ platforms: ["discord", "x"] });
    const video = await s.original(1, "video", "video");
    const result = await processPostMedia(
      { ...s.deps, discordLimits: smallLimits },
      { postId: s.post.id },
    );
    expect(result).toMatchObject({ media: { processed: 1, existing: 0, failed: 0 } });
    expect(s.processor.calls).toEqual([
      {
        kind: "video",
        reel: true,
        xVideo: true,
        discordMaxBytes: null,
        inputBytes: 5,
        music: null,
      },
      {
        kind: "video",
        reel: false,
        xVideo: false,
        discordMaxBytes: DISCORD_VIDEO_MAX_BYTES,
        inputBytes: 5,
        music: null,
      },
    ]);
    const discord = (await s.media.listBySubject({ kind: "post", id: s.post.id })).find(
      (item) => item.variant === "discord_video",
    );
    expect(discord).toMatchObject({
      parentMediaId: video.id,
      kind: "video",
      mime: "video/mp4",
      storagePath: `posts/${s.post.id}/processed/discord_video/${sha(1)}-v7.mp4`,
    });
    expect(s.storage.objects.has(discord?.storagePath ?? "")).toBe(true);

    // Ya está: la segunda vuelta no la repite.
    expect(
      await processPostMedia({ ...s.deps, discordLimits: smallLimits }, { postId: s.post.id }),
    ).toMatchObject({ media: { processed: 0, existing: 1 } });
    expect(s.processor.calls).toHaveLength(2);
  });

  it("con los demás ya armados, solo pide el de Discord (sin reel ni video para X)", async () => {
    const s = await setup({ platforms: null });
    await s.original(1, "video", "video");
    await processPostMedia(s.deps, { postId: s.post.id });
    expect(s.processor.calls).toHaveLength(1);
    await processPostMedia({ ...s.deps, discordLimits: smallLimits }, { postId: s.post.id });
    expect(s.processor.calls.at(-1)).toEqual({
      kind: "video",
      reel: false,
      xVideo: false,
      discordMaxBytes: DISCORD_VIDEO_MAX_BYTES,
      inputBytes: 5,
      music: null,
    });
  });

  it("sin Discord entre las redes del post, o si el video más liviano cabe, no se arma", async () => {
    const sinDiscord = await setup({ platforms: ["x", "linkedin"] });
    await sinDiscord.original(1, "video", "video");
    await processPostMedia(
      { ...sinDiscord.deps, discordLimits: smallLimits },
      { postId: sinDiscord.post.id },
    );
    // Con los topes de Discord (20 MiB), el video de prueba cabe.
    const cabe = await setup({ platforms: ["discord"] });
    await cabe.original(1, "video", "video");
    await processPostMedia(cabe.deps, { postId: cabe.post.id });
    for (const s of [sinDiscord, cabe]) {
      expect(s.processor.calls).toHaveLength(1);
      const variants = (await s.media.listBySubject({ kind: "post", id: s.post.id })).map(
        (item) => item.variant,
      );
      expect(variants).not.toContain("discord_video");
    }
  });

  it("si el video para Discord no se puede (bitrate bajo el mínimo), no queda variante y sigue", async () => {
    const s = await setup({ platforms: ["discord"], discordVideoFails: true });
    await s.original(1, "video", "video");
    expect(
      await processPostMedia({ ...s.deps, discordLimits: smallLimits }, { postId: s.post.id }),
    ).toMatchObject({ media: { processed: 1, failed: 0 }, failedMediaIds: [] });
    const variants = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
      .filter((item) => item.role === "processed")
      .map((item) => item.variant)
      .sort();
    expect(variants).toEqual(["ig_reel", "thumb", "x_video"]);
  });

  it("si la pasada de Discord falla, el original no queda ilegible: sin variante y con aviso", async () => {
    const s = await setup({ platforms: ["discord"], discordVideoThrows: true });
    const video = await s.original(1, "video", "video");
    const missing: unknown[][] = [];
    const result = await processPostMedia(
      {
        ...s.deps,
        discordLimits: smallLimits,
        onDiscordVideoMissing: (mediaId, reason, error) =>
          missing.push([mediaId, reason, (error as { code?: string } | undefined)?.code]),
      },
      { postId: s.post.id },
    );
    expect(result).toEqual({
      outcome: "processed",
      media: { processed: 1, existing: 0, failed: 0 },
      failedMediaIds: [],
      warnings: [],
    });
    expect(missing).toEqual([[video.id, "failed", "MEDIA_DECODE_FAILED"]]);
    const variants = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
      .filter((item) => item.role === "processed")
      .map((item) => item.variant)
      .sort();
    expect(variants).toEqual(["ig_reel", "thumb", "x_video"]);
  });

  it("un video demasiado largo para el mínimo legible no se vuelve a leer para Discord", async () => {
    // Una hora: con 19 MiB, el bitrate queda bajo el mínimo aun sin audio.
    const s = await setup({ platforms: ["discord"], videoDurationS: 3600 });
    const video = await s.original(1, "video", "video");
    const missing: unknown[][] = [];
    await processPostMedia(
      {
        ...s.deps,
        discordLimits: smallLimits,
        onDiscordVideoMissing: (mediaId, reason) => missing.push([mediaId, reason]),
      },
      { postId: s.post.id },
    );
    // Solo la pasada de siempre: la de Discord no se pidió.
    expect(s.processor.calls.map((call) => call.kind === "video" && call.discordMaxBytes)).toEqual([
      null,
    ]);
    expect(missing).toEqual([[video.id, "too_long"]]);
    // Ya medido, la siguiente vuelta tampoco lo lee.
    expect(
      await processPostMedia({ ...s.deps, discordLimits: smallLimits }, { postId: s.post.id }),
    ).toMatchObject({ media: { processed: 0, existing: 1 } });
    expect(s.processor.calls).toHaveLength(1);
  });

  it("un post con dos videos arma discord_video solo del primero (el único que usa Discord)", async () => {
    const s = await setup({ platforms: ["discord"] });
    const first = await s.original(1, "video", "primero");
    const second = await s.original(2, "video", "segundo");
    await processPostMedia({ ...s.deps, discordLimits: smallLimits }, { postId: s.post.id });
    const discord = (await s.media.listBySubject({ kind: "post", id: s.post.id })).filter(
      (item) => item.variant === "discord_video",
    );
    expect(discord.map((item) => item.parentMediaId)).toEqual([first.id]);
    expect(
      s.processor.calls.filter((call) => call.kind === "video" && call.discordMaxBytes !== null),
    ).toHaveLength(1);
    // El segundo tiene sus variantes de siempre.
    const ofSecond = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
      .filter((item) => item.parentMediaId === second.id)
      .map((item) => item.variant)
      .sort();
    expect(ofSecond).toEqual(["ig_reel", "thumb", "x_video"]);
  });

  // F9.5-T19: la música del post va en todos sus videos y en su clave.
  describe("música", () => {
    const musicPath = "assets/musica/calm-piano.mp3";

    it("con música: el reel, X y Discord la llevan, y su clave suma el id de la pista", async () => {
      const s = await setup({ platforms: ["discord", "x", "instagram"] });
      await s.storage.put(musicPath, encode("PISTA"), "audio/mpeg");
      const video = await s.original(1, "video", "video");
      await s.posts.update(s.post.id, { musicTrackId: "calm-piano" });
      const result = await processPostMedia(
        { ...s.deps, discordLimits: smallLimits },
        { postId: s.post.id },
      );
      expect(result).toMatchObject({ media: { processed: 1 }, warnings: [] });
      expect(s.processor.calls.map((call) => call.kind === "video" && call.music)).toEqual([
        "PISTA",
        "PISTA",
      ]);
      const root = `posts/${s.post.id}/processed`;
      const paths = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
        .filter((item) => item.parentMediaId === video.id && item.kind === "video")
        .map((item) => item.storagePath)
        .sort();
      expect(paths).toEqual([
        `${root}/discord_video/${sha(1)}-v7-m-calm-piano.mp4`,
        `${root}/ig_reel/${sha(1)}-v7-m-calm-piano.mp4`,
        `${root}/x_video/${sha(1)}-v7-m-calm-piano.mp4`,
      ]);
    });

    it("cambiar la pista rehace los videos; quitarla vuelve a las claves de siempre", async () => {
      const s = await setup();
      await s.storage.put(musicPath, encode("PISTA"), "audio/mpeg");
      await s.storage.put("assets/musica/up-in-the-sky.mp3", encode("OTRA"), "audio/mpeg");
      await s.original(1, "video", "video");
      await processPostMedia(s.deps, { postId: s.post.id });
      const root = `posts/${s.post.id}/processed`;
      const reelPath = async () =>
        (await s.media.listBySubject({ kind: "post", id: s.post.id })).find(
          (item) => item.variant === "ig_reel",
        )?.storagePath;
      // Sin música: la clave de antes de F9.5-T19.
      expect(await reelPath()).toBe(`${root}/ig_reel/${sha(1)}-v7.mp4`);

      await s.posts.update(s.post.id, { musicTrackId: "calm-piano" });
      await processPostMedia(s.deps, { postId: s.post.id });
      expect(await reelPath()).toBe(`${root}/ig_reel/${sha(1)}-v7-m-calm-piano.mp4`);
      // El reel sin música se borró de R2 (se reemplazó).
      expect(s.storage.objects.has(`${root}/ig_reel/${sha(1)}-v7.mp4`)).toBe(false);

      await s.posts.update(s.post.id, { musicTrackId: "up-in-the-sky" });
      await processPostMedia(s.deps, { postId: s.post.id });
      expect(await reelPath()).toBe(`${root}/ig_reel/${sha(1)}-v7-m-up-in-the-sky.mp4`);
      expect(s.processor.calls.at(-1)).toMatchObject({ reel: true, xVideo: true, music: "OTRA" });

      await s.posts.update(s.post.id, { musicTrackId: null });
      await processPostMedia(s.deps, { postId: s.post.id });
      expect(await reelPath()).toBe(`${root}/ig_reel/${sha(1)}-v7.mp4`);
      expect(s.processor.calls.at(-1)).toMatchObject({ music: null });
      // Una vuelta más no repite nada.
      const calls = s.processor.calls.length;
      await processPostMedia(s.deps, { postId: s.post.id });
      expect(s.processor.calls).toHaveLength(calls);
    });

    it("una pista que no está en R2 (o ya no está en el catálogo): sin música y con aviso", async () => {
      const s = await setup();
      await s.original(1, "video", "video");
      await s.posts.update(s.post.id, { musicTrackId: "calm-piano" });
      const result = await processPostMedia(s.deps, { postId: s.post.id });
      expect(result).toMatchObject({ media: { processed: 1, failed: 0 } });
      if (result.outcome !== "processed") throw new Error("no se procesó");
      expect(result.warnings).toEqual([
        expect.stringContaining("todavía no está subida a la biblioteca"),
      ]);
      expect(s.processor.calls.at(-1)).toMatchObject({ music: null });
      const reel = (await s.media.listBySubject({ kind: "post", id: s.post.id })).find(
        (item) => item.variant === "ig_reel",
      );
      expect(reel?.storagePath).toBe(`posts/${s.post.id}/processed/ig_reel/${sha(1)}-v7.mp4`);

      await s.posts.update(s.post.id, { musicTrackId: "pista-que-se-saco" });
      const again = await processPostMedia(s.deps, { postId: s.post.id });
      expect(again).toMatchObject({
        media: { existing: 1 },
        warnings: [expect.stringContaining("ya no está en la biblioteca")],
      });
    });

    it("si ffmpeg no puede mezclar la pista: videos sin música, con las claves de siempre y un aviso", async () => {
      const s = await setup({ platforms: ["discord", "x"], musicFails: true });
      await s.storage.put(musicPath, encode("DAÑADA"), "audio/mpeg");
      await s.original(1, "video", "video");
      await s.posts.update(s.post.id, { musicTrackId: "calm-piano" });
      const result = await processPostMedia(
        { ...s.deps, discordLimits: smallLimits },
        { postId: s.post.id },
      );
      expect(result).toMatchObject({
        media: { processed: 1, failed: 0 },
        warnings: [expect.stringContaining("no se pudo mezclar")],
      });
      if (result.outcome !== "processed") throw new Error("no se procesó");
      expect(result.warnings).toHaveLength(1);
      const paths = (await s.media.listBySubject({ kind: "post", id: s.post.id }))
        .filter((item) => item.kind === "video" && item.role === "processed")
        .map((item) => item.storagePath);
      expect(paths).toHaveLength(3);
      expect(paths.every((path) => path.endsWith(`${sha(1)}-v7.mp4`))).toBe(true);
    });

    it("un post solo con fotos no busca la música", async () => {
      const s = await setup();
      await s.original(1, "image", "foto");
      await s.posts.update(s.post.id, { musicTrackId: "calm-piano" });
      expect(await processPostMedia(s.deps, { postId: s.post.id })).toMatchObject({
        warnings: [],
      });
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
