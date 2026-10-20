import { createHash } from "node:crypto";
import type { BrokerData } from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "../access.js";
import { createApp } from "../app.js";
import {
  errorBodySchema,
  postDetailResponseSchema,
  postListResponseSchema,
  postResponseSchema,
  postUploadCompleteResponseSchema,
  postUploadResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps, testStorage } from "../testing/index.js";

// F9-T10 (spec F9 §4.10): `/posts` y la subida de sus medios directo a R2 (ADR-0025). Un corredor
// ve y gestiona solo los posts de su marca (lo ajeno es 404); el administrador, todos.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-posts";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const VIDEO = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 9]);

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

async function setup() {
  const auth = testAuth();
  const storage = testStorage();
  const queue = createInMemoryJobQueue();
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    storage,
    queue,
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("vinny"), { kind: "brand" });
  const theirs = await deps.brokers.create(brokerData("ajena"));
  const user = auth.repos.seed.user({
    email: "marca@ejemplo.cl",
    name: "Marca",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: { method?: string; json?: unknown } = {}) =>
      app.request(path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method !== undefined && init.method !== "GET" ? { origin: ORIGIN } : {}),
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      });
  return { deps, storage, queue, mine, theirs, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("/posts: crear, listar, ver, editar y archivar", () => {
  it("el corredor crea en su marca y lo ve; el post viaja con su contrato", async () => {
    const s = await setup();
    const created = await s.broker("/posts", {
      method: "POST",
      json: {
        topic: "Lo que aprendí",
        brief: "Tres cosas",
        plannedAt: "2026-11-02T10:00:00-03:00",
      },
    });
    expect(created.status).toBe(201);
    const { post } = postResponseSchema.parse(await created.json());
    expect(post).toMatchObject({
      brokerId: s.mine.id,
      topic: "Lo que aprendí",
      status: "draft",
      source: "manual",
      briefOrigin: "operator",
      kind: "text",
      plannedAt: new Date("2026-11-02T13:00:00Z"),
    });

    const detail = postDetailResponseSchema.parse(
      await (await s.broker(`/posts/${post.id}`)).json(),
    );
    expect(detail).toMatchObject({ post: { id: post.id }, media: [] });

    const list = postListResponseSchema.parse(await (await s.broker("/posts")).json());
    expect(list.posts.map((item) => item.id)).toEqual([post.id]);
    const ranged = postListResponseSchema.parse(
      await (
        await s.broker("/posts?from=2026-11-03T00:00:00Z&to=2026-11-10T00:00:00Z&status=draft")
      ).json(),
    );
    expect(ranged.posts).toEqual([]);
  });

  it("editar el brief lo deja como del operador; archivar lo cierra y ya no se edita (409)", async () => {
    const s = await setup();
    const idea = await s.deps.posts.create({
      brokerId: s.mine.id,
      topic: "Idea de la IA",
      kind: "text",
      brief: "De la IA",
      briefOrigin: "ai",
      status: "idea",
      source: "ai",
    });
    const patched = await s.broker(`/posts/${idea.id}`, {
      method: "PATCH",
      json: { brief: "Mío", kind: "video", plannedAt: null },
    });
    expect(patched.status).toBe(200);
    expect(postResponseSchema.parse(await patched.json()).post).toMatchObject({
      brief: "Mío",
      briefOrigin: "operator",
      kind: "video",
    });

    const archived = await s.broker(`/posts/${idea.id}/archive`, { method: "POST" });
    expect(postResponseSchema.parse(await archived.json()).post.status).toBe("archived");
    const late = await s.broker(`/posts/${idea.id}`, { method: "PATCH", json: { topic: "Tarde" } });
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("POST_ARCHIVED");
  });

  it("validación: un campo desconocido o un tema vacío son 400", async () => {
    const s = await setup();
    const unknown = await s.broker("/posts", {
      method: "POST",
      json: { topic: "Algo", status: "ready" },
    });
    expect(unknown.status).toBe(400);
    const empty = await s.broker("/posts", { method: "POST", json: { topic: "  " } });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).code).toBe("POST_INVALID");
  });
});

describe("/posts: permisos (ADR-0022, `posts.manage`)", () => {
  it("lo ajeno es 404 y no aparece en la lista; el administrador ve y crea en cualquiera", async () => {
    const s = await setup();
    const foreign = await s.deps.posts.create({
      brokerId: s.theirs.id,
      topic: "Ajeno",
      kind: "text",
    });
    for (const [method, path, json] of [
      ["GET", `/posts/${foreign.id}`, undefined],
      ["PATCH", `/posts/${foreign.id}`, { topic: "Mío" }],
      ["POST", `/posts/${foreign.id}/archive`, undefined],
      [
        "POST",
        `/posts/${foreign.id}/uploads`,
        { files: [{ name: "a.jpg", size: 7, sha256: sha256(PHOTO) }] },
      ],
      ["POST", `/posts/${foreign.id}/uploads/complete`, undefined],
    ] as const) {
      const response = await s.broker(path, { method, json });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect((await errorOf(response)).code).toBe("POST_NOT_FOUND");
    }
    expect((await s.deps.posts.get(foreign.id))?.topic).toBe("Ajeno");

    const list = postListResponseSchema.parse(await (await s.broker("/posts")).json());
    expect(list.posts).toEqual([]);
    const other = await s.broker(`/posts?brokerId=${s.theirs.id}`);
    expect(other.status).toBe(404);
    expect((await errorOf(other)).code).toBe("BROKER_NOT_FOUND");
    const intoOther = await s.broker("/posts", {
      method: "POST",
      json: { brokerId: s.theirs.id, topic: "Colado" },
    });
    expect(intoOther.status).toBe(404);

    expect((await s.admin(`/posts/${foreign.id}`)).status).toBe(200);
    const adminList = postListResponseSchema.parse(await (await s.admin("/posts")).json());
    expect(adminList.posts.map((item) => item.id)).toEqual([foreign.id]);
    const byAdmin = await s.admin("/posts", {
      method: "POST",
      json: { brokerId: s.mine.id, topic: "Del administrador" },
    });
    expect(byAdmin.status).toBe(201);
    // Sin corredor, el administrador no puede crear.
    const orphan = await s.admin("/posts", { method: "POST", json: { topic: "Sin dueño" } });
    expect(orphan.status).toBe(400);
  });

  it("cada ruta de posts está en la tabla de permisos, como de sesión", () => {
    for (const route of [
      "GET /posts",
      "POST /posts",
      "GET /posts/:id",
      "PATCH /posts/:id",
      "POST /posts/:id/archive",
      "POST /posts/:id/uploads",
      "POST /posts/:id/uploads/complete",
    ]) {
      expect([route, ROUTE_ACCESS[route]]).toEqual([route, "session"]);
    }
  });
});

describe("/posts/:id/uploads (ADR-0025)", () => {
  it("una imagen y un video: URL bajo posts/{postId}/, avance, reintento, medios y post.media", async () => {
    const s = await setup();
    const post = await s.deps.posts.create({ brokerId: s.mine.id, topic: "Reel", kind: "video" });
    const files = [
      { name: "foto.jpg", size: PHOTO.length, sha256: sha256(PHOTO) },
      { name: "clip.mp4", size: VIDEO.length, sha256: sha256(VIDEO) },
    ];
    const requested = await s.broker(`/posts/${post.id}/uploads`, {
      method: "POST",
      json: { files },
    });
    expect(requested.status).toBe(201);
    const { uploads } = postUploadResponseSchema.parse(await requested.json());
    const [photo, video] = uploads;
    if (photo?.status !== "upload" || video?.status !== "upload") throw new Error("sin URLs");
    expect(photo.url).toContain(`posts/${post.id}/original/${sha256(PHOTO)}.jpg`);
    expect(video.url).toContain(`posts/${post.id}/original/${sha256(VIDEO)}.mp4`);

    // Avance: solo la foto llega a R2.
    await s.storage.receiveUpload(photo.url, photo.headers, PHOTO);
    const first = await s.broker(`/posts/${post.id}/uploads/complete`, { method: "POST" });
    expect(first.status).toBe(200);
    const progress = postUploadCompleteResponseSchema.parse(await first.json());
    expect(progress).toMatchObject({ completed: [photo.uploadId], missing: [video.uploadId] });
    expect(progress.media).toMatchObject([
      { kind: "image", mime: "image/jpeg", bytes: PHOTO.length, thumbUrl: null, variants: [] },
    ]);
    expect(progress.media[0]?.url).toBe(
      `https://r2.test/posts/${post.id}/original/${sha256(PHOTO)}.jpg?firma`,
    );

    // Reintento: la foto ya está; el video se pide de nuevo (misma subida) y se sube.
    const again = postUploadResponseSchema.parse(
      await (
        await s.broker(`/posts/${post.id}/uploads`, { method: "POST", json: { files } })
      ).json(),
    );
    expect(again.uploads[0]).toMatchObject({ status: "existing", name: "foto.jpg" });
    const retry = again.uploads[1];
    if (retry?.status !== "upload") throw new Error("sin URL para el video");
    expect(retry.uploadId).toBe(video.uploadId);
    // Un contenido distinto del firmado lo rechaza R2 (el doble verifica el sha256).
    await expect(
      s.storage.receiveUpload(retry.url, retry.headers, new Uint8Array(VIDEO.length)),
    ).rejects.toMatchObject({ code: "STORAGE_CONTENT_MISMATCH" });
    await s.storage.receiveUpload(retry.url, retry.headers, VIDEO);
    const done = postUploadCompleteResponseSchema.parse(
      await (await s.broker(`/posts/${post.id}/uploads/complete`, { method: "POST" })).json(),
    );
    expect(done).toMatchObject({ completed: [video.uploadId], missing: [] });
    expect(done.media.map((item) => item.kind)).toEqual(["image", "video"]);
    expect(s.queue.jobs.map((job) => [job.name, job.data])).toEqual([
      ["post.media", { postId: post.id }],
      ["post.media", { postId: post.id }],
    ]);
    const detail = postDetailResponseSchema.parse(
      await (await s.broker(`/posts/${post.id}`)).json(),
    );
    expect(detail.media).toHaveLength(2);
  });

  it("un tipo no admitido es 400 y un video sobre el tope, 413", async () => {
    const s = await setup();
    const post = await s.deps.posts.create({ brokerId: s.mine.id, topic: "X", kind: "image" });
    const pdf = await s.broker(`/posts/${post.id}/uploads`, {
      method: "POST",
      json: { files: [{ name: "doc.pdf", size: 10, sha256: sha256(PHOTO) }] },
    });
    expect(pdf.status).toBe(400);
    expect((await errorOf(pdf)).code).toBe("POST_UPLOAD_INVALID");
    const big = await s.broker(`/posts/${post.id}/uploads`, {
      method: "POST",
      json: { files: [{ name: "v.mov", size: 31 * 1024 * 1024, sha256: sha256(VIDEO) }] },
    });
    expect(big.status).toBe(413);
    expect((await errorOf(big)).code).toBe("POST_UPLOAD_TOO_LARGE");
  });
});
