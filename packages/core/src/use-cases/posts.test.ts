import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import { archivePost, createPost, getPost, listPosts, updatePost } from "./posts.js";

// F9-T10 (spec F9 §4.2 y §4.10): los posts manuales, con el alcance de ADR-0022 y `posts.manage`.

const ADMIN = { id: "admin-1", role: "admin" as const, brokerId: null };
const brokerUser = (brokerId: string) => ({
  id: `u-${brokerId}`,
  role: "broker" as const,
  brokerId,
});

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
  const brokers = createInMemoryBrokerRepository();
  const posts = createInMemoryPostRepository();
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  const publications = createInMemoryPublicationRepository();
  const content = createInMemoryContentRepositories();
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media: createInMemoryMediaRepository(),
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications,
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const mine = await brokers.create(brokerData("mia"));
  const theirs = await brokers.create(brokerData("ajena"));
  // Una marca (ADR-0029): un post cuelga de cualquier corredor o marca.
  const brand = await brokers.create(brokerData("vinny"), { kind: "brand" });
  await editorialProfiles.upsert(mine.id, {
    languages: ["es"],
    audience: null,
    pillars: [{ key: "producto", name: "Producto", description: "", weight: 1 }],
    facts: [],
    avoid: [],
    cadence: {},
    defaultHashtags: [],
  });
  return {
    deps: { brokers, posts, editorialProfiles, postLock },
    posts,
    publications,
    mine,
    theirs,
    brand,
  };
}

describe("createPost", () => {
  it("nace manual, en draft y con el brief del operador; el corredor crea en el suyo", async () => {
    const s = await setup();
    const post = await createPost(s.deps, brokerUser(s.mine.id), {
      topic: "  Lo que aprendí esta semana  ",
      brief: "Tres cosas",
      pillar: "producto",
      plannedAt: new Date("2026-11-02T13:00:00Z"),
    });
    expect(post).toMatchObject({
      brokerId: s.mine.id,
      topic: "Lo que aprendí esta semana",
      brief: "Tres cosas",
      briefOrigin: "operator",
      source: "manual",
      status: "draft",
      kind: "text",
      pillar: "producto",
      createdBy: `u-${s.mine.id}`,
    });
  });

  it("el administrador crea en una marca; sin corredor es POST_INVALID", async () => {
    const s = await setup();
    const post = await createPost(s.deps, ADMIN, {
      brokerId: s.brand.id,
      topic: "Bastidores",
      kind: "image",
    });
    expect(post).toMatchObject({ brokerId: s.brand.id, kind: "image" });
    await expect(createPost(s.deps, ADMIN, { topic: "Sin dueño" })).rejects.toMatchObject({
      code: "POST_INVALID",
    });
  });

  it("un corredor no crea en otro (404); tema vacío, tema largo o línea inexistente son POST_INVALID", async () => {
    const s = await setup();
    const user = brokerUser(s.mine.id);
    await expect(
      createPost(s.deps, user, { brokerId: s.theirs.id, topic: "Ajeno" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    await expect(createPost(s.deps, user, { topic: "   " })).rejects.toMatchObject({
      code: "POST_INVALID",
    });
    await expect(createPost(s.deps, user, { topic: "x".repeat(201) })).rejects.toMatchObject({
      code: "POST_INVALID",
    });
    await expect(
      createPost(s.deps, user, { topic: "Con línea", pillar: "no-existe" }),
    ).rejects.toMatchObject({ code: "POST_INVALID" });
    await expect(
      createPost(s.deps, ADMIN, { brokerId: "no-existe", topic: "Nada" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
  });
});

describe("listPosts y getPost", () => {
  it("un corredor ve solo los suyos; filtrar por otro es 404; el administrador ve todos", async () => {
    const s = await setup();
    const own = await createPost(s.deps, brokerUser(s.mine.id), {
      topic: "Mío",
      plannedAt: new Date("2026-11-02T13:00:00Z"),
    });
    const other = await createPost(s.deps, ADMIN, { brokerId: s.theirs.id, topic: "Ajeno" });

    expect((await listPosts(s.deps, brokerUser(s.mine.id), {})).map((post) => post.id)).toEqual([
      own.id,
    ]);
    await expect(
      listPosts(s.deps, brokerUser(s.mine.id), { brokerId: s.theirs.id }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect((await listPosts(s.deps, ADMIN, {})).map((post) => post.id).sort()).toEqual(
      [own.id, other.id].sort(),
    );
    expect(
      (
        await listPosts(s.deps, ADMIN, {
          from: new Date("2026-11-01T00:00:00Z"),
          to: new Date("2026-11-03T00:00:00Z"),
        })
      ).map((post) => post.id),
    ).toEqual([own.id]);
    expect(await listPosts(s.deps, ADMIN, { status: "archived" })).toEqual([]);
    await expect(
      listPosts(s.deps, ADMIN, {
        from: new Date("2026-11-03T00:00:00Z"),
        to: new Date("2026-11-01T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "POST_INVALID" });

    expect((await getPost(s.deps, brokerUser(s.mine.id), own.id)).id).toBe(own.id);
    await expect(getPost(s.deps, brokerUser(s.mine.id), other.id)).rejects.toMatchObject({
      code: "POST_NOT_FOUND",
    });
    await expect(getPost(s.deps, ADMIN, "no-existe")).rejects.toMatchObject({
      code: "POST_NOT_FOUND",
    });
  });
});

describe("updatePost", () => {
  it("edita tema, tipo, línea y fecha; editar el brief lo deja como del operador", async () => {
    const s = await setup();
    // Una idea de la IA (T20) con su brief: al editarlo, pasa a ser del operador (ADR-0030).
    const idea = await s.posts.create({
      brokerId: s.mine.id,
      topic: "Idea",
      kind: "text",
      brief: "Escrito por la IA",
      briefOrigin: "ai",
      status: "idea",
      source: "ai",
    });
    const user = brokerUser(s.mine.id);
    const renamed = await updatePost(s.deps, user, idea.id, { topic: "Idea mejor" });
    expect(renamed).toMatchObject({ topic: "Idea mejor", briefOrigin: "ai" });

    const edited = await updatePost(s.deps, user, idea.id, {
      brief: "Ahora lo escribo yo",
      kind: "carousel",
      pillar: "producto",
      plannedAt: new Date("2026-11-05T15:00:00Z"),
    });
    expect(edited).toMatchObject({
      brief: "Ahora lo escribo yo",
      briefOrigin: "operator",
      kind: "carousel",
      pillar: "producto",
      plannedAt: new Date("2026-11-05T15:00:00Z"),
    });
    const cleared = await updatePost(s.deps, user, idea.id, { pillar: null, plannedAt: null });
    expect(cleared).toMatchObject({ pillar: null, plannedAt: null });
  });

  it("lo ajeno es 404, una línea inexistente 400 y un post archivado no se edita (409)", async () => {
    const s = await setup();
    const post = await createPost(s.deps, ADMIN, { brokerId: s.theirs.id, topic: "Ajeno" });
    await expect(
      updatePost(s.deps, brokerUser(s.mine.id), post.id, { topic: "Mío" }),
    ).rejects.toMatchObject({ code: "POST_NOT_FOUND" });
    await expect(updatePost(s.deps, ADMIN, post.id, { pillar: "producto" })).rejects.toMatchObject({
      code: "POST_INVALID",
    });
    await archivePost(s.deps, ADMIN, post.id);
    await expect(updatePost(s.deps, ADMIN, post.id, { topic: "Tarde" })).rejects.toMatchObject({
      code: "POST_ARCHIVED",
    });
  });
});

describe("archivePost", () => {
  it("archiva (idempotente); con publicaciones pendientes, 409", async () => {
    const s = await setup();
    const post = await createPost(s.deps, brokerUser(s.mine.id), { topic: "Para archivar" });
    expect((await archivePost(s.deps, brokerUser(s.mine.id), post.id)).status).toBe("archived");
    expect((await archivePost(s.deps, brokerUser(s.mine.id), post.id)).status).toBe("archived");
    await expect(archivePost(s.deps, brokerUser(s.theirs.id), post.id)).rejects.toMatchObject({
      code: "POST_NOT_FOUND",
    });

    const busy = await createPost(s.deps, ADMIN, { brokerId: s.mine.id, topic: "Programado" });
    s.publications.listBySubject = async () =>
      [{ id: "pub-1", status: "scheduled" }] as Awaited<
        ReturnType<typeof s.publications.listBySubject>
      >;
    await expect(archivePost(s.deps, ADMIN, busy.id)).rejects.toMatchObject({
      code: "POST_HAS_PENDING_PUBLICATIONS",
    });
    expect((await getPost(s.deps, ADMIN, busy.id)).status).toBe("draft");
  });
});
