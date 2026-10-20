import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import { AppError } from "../errors.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryJobQueue,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import {
  closeAbandonedPostUploads,
  completePostUploads,
  POST_UPLOAD,
  type PostUploadTarget,
  requestPostUploads,
} from "./post-uploads.js";

// F9-T10 (spec F9 §4.5, ADR-0025): subir los medios de un post directo a R2 (falso), con avance y
// reintento, la deduplicación por `(post_id, checksum)`, las claves bajo `posts/{postId}/` y la
// limpieza de lo abandonado.

const ADMIN = { id: "admin-1", role: "admin" as const, brokerId: null };
const brokerUser = (brokerId: string) => ({
  id: `u-${brokerId}`,
  role: "broker" as const,
  brokerId,
});
const MB = 1024 * 1024;

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

/** Un sha256 de mentira con forma válida (64 hex): core no calcula hashes. */
const sha = (n: number) => n.toString(16).padStart(64, "0");
const bytes = (size: number) => new Uint8Array(size).fill(7);

async function setup(options: { now?: () => Date } = {}) {
  let ids = 0;
  let clock = new Date("2026-10-20T12:00:00Z");
  const now = options.now ?? (() => clock);
  const brokers = createInMemoryBrokerRepository();
  const posts = createInMemoryPostRepository();
  const postUploads = createInMemoryPostUploadRepository();
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage({ now });
  const queue = createInMemoryJobQueue();
  const content = createInMemoryContentRepositories();
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads,
    media,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications: createInMemoryPublicationRepository(),
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const mine = await brokers.create(brokerData("vinny"), { kind: "brand" });
  const theirs = await brokers.create(brokerData("ajena"));
  const post = await posts.create({ brokerId: mine.id, topic: "Bastidores", kind: "carousel" });
  const deps = {
    posts,
    postLock,
    storage,
    queue,
    postUploads,
    media,
    maxFileBytes: 50 * MB,
    maxVideoBytes: 30 * MB,
    newId: () => `aaaaaaaa-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    now,
  };
  return {
    deps,
    post,
    mine,
    theirs,
    storage,
    media,
    queue,
    postUploads,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

type Upload = Extract<PostUploadTarget, { status: "upload" }>;
const asUpload = (target: PostUploadTarget | undefined): Upload => {
  if (target?.status !== "upload") throw new Error(`se esperaba una subida: ${target?.status}`);
  return target;
};

describe("requestPostUploads y completePostUploads", () => {
  it("una imagen y un video: URLs bajo posts/{postId}/, avance, reintento y medios del post", async () => {
    const s = await setup();
    const user = brokerUser(s.mine.id);
    const { uploads } = await requestPostUploads(s.deps, user, s.post.id, [
      { name: "foto.JPEG", size: 1000, sha256: sha(1).toUpperCase() },
      { name: "clip.mov", size: 4000, sha256: sha(2) },
    ]);
    const photo = asUpload(uploads[0]);
    const video = asUpload(uploads[1]);
    expect(photo.name).toBe("foto.JPEG");
    expect(photo.headers["content-type"]).toBe("image/jpeg");
    expect(video.headers["content-type"]).toBe("video/quicktime");
    expect(photo.url).toContain(`posts/${s.post.id}/original/${sha(1)}.jpg`);
    expect(video.url).toContain(`posts/${s.post.id}/original/${sha(2)}.mov`);
    const pending = await s.postUploads.listByPost(s.post.id);
    expect(pending.map((upload) => upload.status)).toEqual(["pending", "pending"]);
    expect(pending.every((upload) => upload.objectPath.startsWith(`posts/${s.post.id}/`))).toBe(
      true,
    );

    // Avance: llega solo la foto.
    await s.storage.receiveUpload(photo.url, photo.headers, bytes(1000));
    const first = await completePostUploads(s.deps, user, s.post.id);
    expect(first.completed).toEqual([photo.uploadId]);
    expect(first.missing).toEqual([video.uploadId]);
    expect(first.media).toHaveLength(1);
    expect(first.media[0]).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
      checksum: sha(1),
      postId: s.post.id,
      listingId: null,
      brokerId: s.mine.id,
      sortOrder: 0,
      storagePath: `posts/${s.post.id}/original/${sha(1)}.jpg`,
    });
    expect(s.queue.jobs).toEqual([
      { name: "post.media", data: { postId: s.post.id }, options: { singletonKey: s.post.id } },
    ]);

    // Reintento: la URL del video venció; pedirlo otra vez reabre la misma subida (y la foto ya
    // está: `existing`, nada que subir).
    const again = await requestPostUploads(s.deps, user, s.post.id, [
      { name: "foto.jpg", size: 1000, sha256: sha(1) },
      { name: "clip.mov", size: 4000, sha256: sha(2) },
    ]);
    expect(again.uploads[0]).toEqual({
      status: "existing",
      name: "foto.jpg",
      mediaId: first.media[0]?.id,
    });
    const retry = asUpload(again.uploads[1]);
    expect(retry.uploadId).toBe(video.uploadId);
    await s.storage.receiveUpload(retry.url, retry.headers, bytes(4000));
    const second = await completePostUploads(s.deps, user, s.post.id);
    expect(second.completed).toEqual([video.uploadId]);
    expect(second.missing).toEqual([]);
    expect(second.media.map((item) => [item.kind, item.mime, item.sortOrder])).toEqual([
      ["image", "image/jpeg", 0],
      ["video", "video/quicktime", 1],
    ]);
    expect((await s.postUploads.listByPost(s.post.id)).map((upload) => upload.status)).toEqual([
      "completed",
      "completed",
    ]);
    // Completar otra vez no duplica nada y vuelve a encolar (repara un encolado que falló).
    const third = await completePostUploads(s.deps, user, s.post.id);
    expect(third).toMatchObject({ completed: [], missing: [] });
    expect(third.media).toHaveLength(2);
    expect(s.queue.jobs).toHaveLength(3);
  });

  it("un archivo con otro tamaño en R2 sigue pendiente; sin medios no se encola", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "foto.png", size: 1000, sha256: sha(3) },
    ]);
    const photo = asUpload(uploads[0]);
    // Alguien sube otro contenido a la misma clave sin la URL (o R2 no exigiera el largo).
    await s.storage.put(`posts/${s.post.id}/original/${sha(3)}.png`, bytes(10), "image/png");
    const result = await completePostUploads(s.deps, ADMIN, s.post.id);
    expect(result).toMatchObject({ completed: [], missing: [photo.uploadId], media: [] });
    expect(s.queue.jobs).toEqual([]);
  });

  it("el mismo contenido con dos nombres es una sola subida, y el único (post, checksum) evita duplicados", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "a.jpg", size: 500, sha256: sha(4) },
      { name: "copia-de-a.jpg", size: 500, sha256: sha(4) },
    ]);
    const a = asUpload(uploads[0]);
    const copy = asUpload(uploads[1]);
    expect(copy.uploadId).toBe(a.uploadId);
    expect(await s.postUploads.listByPost(s.post.id)).toHaveLength(1);
    await s.storage.receiveUpload(a.url, a.headers, bytes(500));
    await completePostUploads(s.deps, ADMIN, s.post.id);
    // El repositorio rechaza un segundo original con el mismo checksum en el post.
    await expect(
      s.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.mine.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/otra-clave.jpg`,
        mime: "image/jpeg",
        bytes: 500,
        checksum: sha(4),
        sortOrder: 9,
        isCover: false,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CONFLICT" });
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toHaveLength(1);
  });

  it("valida tipo, nombre, tamaño, sha256, cantidad y estado; lo ajeno es 404", async () => {
    const s = await setup();
    const request = (
      files: { name: string; size: number; sha256: string }[],
      actor: Parameters<typeof requestPostUploads>[1] = ADMIN,
    ) => requestPostUploads(s.deps, actor, s.post.id, files);
    await expect(request([{ name: "doc.pdf", size: 10, sha256: sha(1) }])).rejects.toMatchObject({
      code: "POST_UPLOAD_INVALID",
    });
    await expect(request([{ name: "a/b.jpg", size: 10, sha256: sha(1) }])).rejects.toMatchObject({
      code: "POST_UPLOAD_INVALID",
    });
    await expect(request([{ name: "x.jpg", size: 0, sha256: sha(1) }])).rejects.toMatchObject({
      code: "POST_UPLOAD_INVALID",
    });
    await expect(request([{ name: "x.jpg", size: 10, sha256: "abc" }])).rejects.toMatchObject({
      code: "POST_UPLOAD_INVALID",
    });
    await expect(request([])).rejects.toMatchObject({ code: "POST_UPLOAD_INVALID" });
    // El tope de un video es el menor entre MAX_VIDEO_MB y el de cada archivo.
    await expect(request([{ name: "v.mp4", size: 31 * MB, sha256: sha(1) }])).rejects.toMatchObject(
      { code: "POST_UPLOAD_TOO_LARGE" },
    );
    await expect(request([{ name: "f.jpg", size: 51 * MB, sha256: sha(1) }])).rejects.toMatchObject(
      { code: "POST_UPLOAD_TOO_LARGE" },
    );
    const many = Array.from({ length: POST_UPLOAD.maxFilesPerRequest + 1 }, (_, i) => ({
      name: `f${i}.jpg`,
      size: 10,
      sha256: sha(100 + i),
    }));
    await expect(request(many)).rejects.toMatchObject({ code: "POST_UPLOAD_INVALID" });
    await expect(
      request([{ name: "f.jpg", size: 10, sha256: sha(1) }], brokerUser(s.theirs.id)),
    ).rejects.toMatchObject({ code: "POST_NOT_FOUND" });
    await expect(
      completePostUploads(s.deps, brokerUser(s.theirs.id), s.post.id),
    ).rejects.toMatchObject({ code: "POST_NOT_FOUND" });

    // Hasta 20 medios por post, contando lo pendiente.
    await request(many.slice(0, POST_UPLOAD.maxMediaPerPost));
    await expect(
      request([{ name: "uno-mas.jpg", size: 10, sha256: sha(999) }]),
    ).rejects.toMatchObject({ code: "POST_UPLOAD_INVALID" });

    await s.deps.posts.archive(s.post.id);
    await expect(request([{ name: "f.jpg", size: 10, sha256: sha(1) }])).rejects.toMatchObject({
      code: "POST_ARCHIVED",
    });
  });

  it("con la cola caída, complete falla (503) pero los medios quedan; repetirlo encola", async () => {
    const s = await setup();
    let down = true;
    const queue = createInMemoryJobQueue({
      fail: () =>
        down
          ? new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true })
          : undefined,
    });
    const deps = { ...s.deps, queue };
    const { uploads } = await requestPostUploads(deps, ADMIN, s.post.id, [
      { name: "f.webp", size: 10, sha256: sha(5) },
    ]);
    const target = asUpload(uploads[0]);
    await s.storage.receiveUpload(target.url, target.headers, bytes(10));
    await expect(completePostUploads(deps, ADMIN, s.post.id)).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toHaveLength(1);
    down = false;
    const result = await completePostUploads(deps, ADMIN, s.post.id);
    expect(result.media).toHaveLength(1);
    expect(queue.jobs.map((job) => job.name)).toEqual(["post.media"]);
  });
});

describe("closeAbandonedPostUploads", () => {
  it("una subida vencida se borra de R2 y queda abandoned; pedirla otra vez la reabre", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "a-medias.mp4", size: 100, sha256: sha(6) },
      { name: "a-tiempo.jpg", size: 10, sha256: sha(7) },
    ]);
    const half = asUpload(uploads[0]);
    // Un objeto quedó en R2 (una subida que nadie completó).
    await s.storage.receiveUpload(half.url, half.headers, bytes(100));
    s.advance(POST_UPLOAD.abandonedAfterMs - 60_000);
    expect(await closeAbandonedPostUploads(s.deps)).toEqual({ abandoned: [], failed: [] });

    s.advance(2 * 60_000);
    const result = await closeAbandonedPostUploads(s.deps);
    expect(result.abandoned).toHaveLength(2);
    expect(s.storage.objects.has(`posts/${s.post.id}/original/${sha(6)}.mp4`)).toBe(false);
    expect((await s.postUploads.listByPost(s.post.id)).map((upload) => upload.status)).toEqual([
      "abandoned",
      "abandoned",
    ]);
    // Una segunda vuelta no encuentra nada.
    expect(await closeAbandonedPostUploads(s.deps)).toEqual({ abandoned: [], failed: [] });

    const again = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "a-medias.mp4", size: 100, sha256: sha(6) },
    ]);
    expect(asUpload(again.uploads[0]).uploadId).toBe(half.uploadId);
    expect((await s.postUploads.get(half.uploadId))?.status).toBe("pending");
  });

  it("si el borrado falla, sigue pendiente para la próxima vuelta; nunca borra un medio guardado", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "f.jpg", size: 10, sha256: sha(8) },
    ]);
    const target = asUpload(uploads[0]);
    s.advance(POST_UPLOAD.abandonedAfterMs + 1000);
    const failing = {
      ...s.deps,
      storage: {
        delete: async () => {
          throw new AppError("STORAGE_UNAVAILABLE", "R2 no responde", { retriable: true });
        },
      },
    };
    expect(await closeAbandonedPostUploads(failing)).toEqual({
      abandoned: [],
      failed: [target.uploadId],
    });
    expect((await s.postUploads.get(target.uploadId))?.status).toBe("pending");

    // El archivo llegó y ya es un medio (se completó a última hora): no se borra.
    await s.storage.receiveUpload(target.url, target.headers, bytes(10));
    await s.media.create({
      listingId: null,
      postId: s.post.id,
      brokerId: s.mine.id,
      kind: "image",
      storagePath: `posts/${s.post.id}/original/${sha(8)}.jpg`,
      mime: "image/jpeg",
      bytes: 10,
      checksum: sha(8),
      sortOrder: 0,
      isCover: false,
    });
    expect(await closeAbandonedPostUploads(s.deps)).toEqual({ abandoned: [], failed: [] });
    expect(s.storage.objects.has(`posts/${s.post.id}/original/${sha(8)}.jpg`)).toBe(true);
    expect((await s.postUploads.get(target.uploadId))?.status).toBe("completed");
  });

  /** Una barrera: `wait()` queda esperando hasta `open()`. */
  const gate = () => {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait: () => opened, open };
  };

  it("complete y limpieza intercalados (la limpieza revisó antes): queda el medio con su objeto", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "tarde.jpg", size: 10, sha256: sha(10) },
    ]);
    const target = asUpload(uploads[0]);
    await s.storage.receiveUpload(target.url, target.headers, bytes(10));
    s.advance(POST_UPLOAD.abandonedAfterMs + 1000);

    // La limpieza ya leyó las vencidas y espera su turno; mientras, `complete` corre entero.
    const held = gate();
    const reached = gate();
    const cleanup = closeAbandonedPostUploads({
      ...s.deps,
      postLock: {
        run: async (postId, fn) => {
          reached.open();
          await held.wait();
          return s.deps.postLock.run(postId, fn);
        },
      },
    });
    await reached.wait();
    const done = await completePostUploads(s.deps, ADMIN, s.post.id);
    expect(done.completed).toEqual([target.uploadId]);
    held.open();
    expect(await cleanup).toEqual({ abandoned: [], failed: [] });

    const [stored] = await s.media.listOriginals({ kind: "post", id: s.post.id });
    expect(stored?.storagePath).toBe(`posts/${s.post.id}/original/${sha(10)}.jpg`);
    expect(s.storage.objects.has(stored?.storagePath ?? "")).toBe(true);
    expect((await s.postUploads.get(target.uploadId))?.status).toBe("completed");
  });

  it("complete y limpieza intercalados (complete listó antes): no queda un medio sin objeto", async () => {
    const s = await setup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "tarde.jpg", size: 10, sha256: sha(11) },
    ]);
    const target = asUpload(uploads[0]);
    await s.storage.receiveUpload(target.url, target.headers, bytes(10));
    s.advance(POST_UPLOAD.abandonedAfterMs + 1000);

    // `complete` ya vio el objeto en R2 y espera; mientras, la limpieza lo borra y lo abandona.
    const held = gate();
    const reached = gate();
    const list = s.storage.list.bind(s.storage);
    const completing = completePostUploads(
      {
        ...s.deps,
        storage: {
          list: async (prefix) => {
            const listed = await list(prefix);
            reached.open();
            await held.wait();
            return listed;
          },
        },
      },
      ADMIN,
      s.post.id,
    );
    await reached.wait();
    expect((await closeAbandonedPostUploads(s.deps)).abandoned).toEqual([target.uploadId]);
    held.open();
    const result = await completing;

    expect(result).toMatchObject({ completed: [], missing: [], media: [] });
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toEqual([]);
    expect((await s.postUploads.get(target.uploadId))?.status).toBe("abandoned");
  });
});

describe("subidas de más de 100 MB sin sha256 (F9-T17, ADR-0025 punto 2)", () => {
  const BIG = POST_UPLOAD.sha256UpToBytes + 1;

  /** Topes de 1 GB y un R2 que lista el objeto grande con su tamaño (sin guardar 100 MB). */
  async function bigSetup() {
    const s = await setup();
    const sizes = new Map<string, number>();
    const deps = {
      ...s.deps,
      maxFileBytes: 1024 * MB,
      maxVideoBytes: 1024 * MB,
      storage: {
        signedUploadUrl: s.storage.signedUploadUrl,
        list: async (prefix: string) =>
          [...sizes]
            .filter(([path]) => path.startsWith(prefix))
            .map(([path, size]) => ({ path, size, lastModified: new Date() })),
      },
    };
    return { ...s, deps, arrive: (path: string, size: number) => sizes.set(path, size) };
  }

  it("hasta 100 MB el sha256 sigue siendo obligatorio", async () => {
    const s = await bigSetup();
    await expect(
      requestPostUploads(s.deps, ADMIN, s.post.id, [
        { name: "clip.mp4", size: POST_UPLOAD.sha256UpToBytes },
      ]),
    ).rejects.toMatchObject({ code: "POST_UPLOAD_INVALID" });
  });

  it("sobre 100 MB: la clave es la de la subida, sin sha256 firmado; complete la deja `uploaded` y encola post.media", async () => {
    const s = await bigSetup();
    const { uploads } = await requestPostUploads(s.deps, ADMIN, s.post.id, [
      { name: "grande.MP4", size: BIG },
      { name: "foto.jpg", size: 1000, sha256: sha(1) },
    ]);
    const big = asUpload(uploads[0]);
    expect(big.uploadId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(big.url).toContain(`posts/${s.post.id}/original/${big.uploadId}.mp4`);
    expect(big.headers["x-amz-checksum-sha256"]).toBeUndefined();
    expect(big.headers["content-type"]).toBe("video/mp4");
    expect(await s.postUploads.get(big.uploadId)).toMatchObject({
      status: "pending",
      expectedBytes: BIG,
    });

    // Todavía no llega: sigue pendiente y nada se encola.
    const first = await completePostUploads(s.deps, ADMIN, s.post.id);
    expect(first.missing).toContain(big.uploadId);
    expect(first.uploaded).toEqual([]);
    expect(s.queue.jobs).toEqual([]);

    s.arrive(`posts/${s.post.id}/original/${big.uploadId}.mp4`, BIG);
    const second = await completePostUploads(s.deps, ADMIN, s.post.id);
    expect(second.uploaded).toEqual([big.uploadId]);
    expect(second.completed).toEqual([]);
    // El medio lo crea el worker (con su sha256): todavía no hay.
    expect(second.media).toEqual([]);
    expect((await s.postUploads.get(big.uploadId))?.status).toBe("uploaded");
    expect(s.queue.jobs).toEqual([
      { name: "post.media", data: { postId: s.post.id }, options: { singletonKey: s.post.id } },
    ]);
    // Llamar otra vez no la vuelve a marcar, pero sí vuelve a encolar (el worker no ha pasado).
    const third = await completePostUploads(s.deps, ADMIN, s.post.id);
    expect(third.uploaded).toEqual([]);
    expect(s.queue.jobs).toHaveLength(2);
  });

  it("cada pedido de un archivo grande es una subida nueva, y las `uploaded` ocupan su lugar", async () => {
    const s = await bigSetup();
    const one = asUpload(
      (await requestPostUploads(s.deps, ADMIN, s.post.id, [{ name: "a.mov", size: BIG }]))
        .uploads[0],
    );
    s.arrive(`posts/${s.post.id}/original/${one.uploadId}.mov`, BIG);
    await completePostUploads(s.deps, ADMIN, s.post.id);
    const two = asUpload(
      (await requestPostUploads(s.deps, ADMIN, s.post.id, [{ name: "a.mov", size: BIG }]))
        .uploads[0],
    );
    expect(two.uploadId).not.toBe(one.uploadId);
    // Una `uploaded` y una pendiente ya ocupan dos de los 20 lugares.
    const files = Array.from({ length: POST_UPLOAD.maxMediaPerPost - 1 }, (_, n) => ({
      name: `f${n}.jpg`,
      size: 10,
      sha256: sha(100 + n),
    }));
    await expect(requestPostUploads(s.deps, ADMIN, s.post.id, files)).rejects.toMatchObject({
      code: "POST_UPLOAD_INVALID",
    });
  });
});

describe("closeAbandonedPostUploads · `uploaded` que el worker no revisó (F9-T17)", () => {
  const HOUR = 3_600_000;

  async function staleSetup() {
    const s = await setup();
    /** Una subida grande que llegó (`uploaded`) con su objeto en R2. */
    const arrived = async (id: string) => {
      const path = `posts/${s.post.id}/original/${id}.mp4`;
      await s.storage.put(path, bytes(10), "video/mp4");
      await s.postUploads.create({
        id,
        postId: s.post.id,
        objectPath: path,
        expectedBytes: 10,
        expiresAt: new Date(Date.now() + 48 * HOUR),
      });
      await s.postUploads.markUploaded(id);
      return path;
    };
    const cleanupAt = (ms: number) =>
      closeAbandonedPostUploads({ ...s.deps, now: () => new Date(Date.now() + ms) });
    return { ...s, arrived, cleanupAt };
  }

  it("antes de 24 h no la toca; pasadas, borra su objeto y la deja abandoned", async () => {
    const s = await staleSetup();
    const id = "bbbbbbbb-0000-4000-8000-000000000001";
    const path = await s.arrived(id);
    expect(await s.cleanupAt(23 * HOUR)).toEqual({ abandoned: [], failed: [] });
    expect((await s.postUploads.get(id))?.status).toBe("uploaded");

    expect(await s.cleanupAt(25 * HOUR)).toEqual({ abandoned: [id], failed: [] });
    expect((await s.postUploads.get(id))?.status).toBe("abandoned");
    expect(s.storage.objects.has(path)).toBe(false);
  });

  it("si el worker alcanzó a crear el medio, solo la marca completed y no borra el objeto", async () => {
    const s = await staleSetup();
    const id = "bbbbbbbb-0000-4000-8000-000000000002";
    const path = await s.arrived(id);
    await s.media.create({
      listingId: null,
      postId: s.post.id,
      brokerId: s.mine.id,
      kind: "video",
      storagePath: path,
      mime: "video/mp4",
      bytes: 10,
      checksum: sha(42),
      sortOrder: 0,
      isCover: false,
    });
    expect(await s.cleanupAt(25 * HOUR)).toEqual({ abandoned: [], failed: [] });
    expect((await s.postUploads.get(id))?.status).toBe("completed");
    expect(s.storage.objects.has(path)).toBe(true);
  });
});
