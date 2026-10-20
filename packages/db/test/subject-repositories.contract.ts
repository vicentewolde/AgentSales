import {
  ALL_SCOPE,
  type BrokerRepository,
  brokerScope,
  type ContentRepository,
  type ContentRunRepository,
  type EditorialProfileData,
  type EditorialProfileRepository,
  type ListingRepository,
  type LlmCallUsage,
  listingSubject,
  type MediaRepository,
  type NewMedia,
  type NewPost,
  type PlanRunRepository,
  type PlatformAccountRepository,
  type PostRepository,
  type PostUploadRepository,
  type PublicationRepository,
  postSubject,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";
import { newContent } from "./content-repositories.contract.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { connectedAccount } from "./platform-accounts.contract.js";

/**
 * Suite de contrato de F9-T04 (ADR-0029): los repositorios con sujeto (un aviso o un post) y los
 * nuevos de posts, planes, subidas y perfil editorial. Corre igual contra los dobles en memoria y
 * contra Drizzle sobre PGlite. Las suites de avisos (`content-repositories`, `publications`,
 * `import-repositories`) no cambian sus aserciones: esta prueba lo nuevo.
 */
export type SubjectRepositories = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  posts: PostRepository;
  postUploads: PostUploadRepository;
  planRuns: PlanRunRepository;
  editorialProfiles: EditorialProfileRepository;
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  publications: PublicationRepository;
  media: MediaRepository;
  accounts: PlatformAccountRepository;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

const call = (costUsd: number): LlmCallUsage => ({
  provider: "anthropic-api",
  model: "claude-sonnet-5-5",
  inputTokens: 100,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 50,
  costUsd,
  priceTable: "2026-10-16",
  requestId: unique("req"),
});

const REPORT = { warnings: [] };

const profile = (overrides: Partial<EditorialProfileData> = {}): EditorialProfileData => ({
  languages: ["es", "en"],
  audience: "Corredores independientes de Santiago",
  pillars: [{ key: "producto", name: "Producto", description: "Lo que hace", weight: 2 }],
  facts: ["AgentSales publica en Instagram"],
  avoid: ["promesas de venta"],
  cadence: { instagram: { postsPerWeek: 3, days: ["mon"], hours: ["10:00"], languageGapHours: 6 } },
  defaultHashtags: ["#agentsales"],
  ...overrides,
});

export function subjectRepositoriesContract(
  name: string,
  make: () => Promise<SubjectRepositories>,
) {
  describe(`${name} · repositorios con sujeto y de posts (F9-T04)`, () => {
    let repos: SubjectRepositories;
    let brand: string;
    let other: string;
    beforeAll(async () => {
      repos = await make();
      brand = (await repos.brokers.create(brokerData(unique("marca")))).id;
      other = (await repos.brokers.create(brokerData(unique("otra-marca")))).id;
    });

    const newPost = (brokerId = brand, overrides: Partial<NewPost> = {}) =>
      repos.posts.create({ brokerId, topic: unique("Tema"), kind: "image", ...overrides });

    /** Un post con un texto aprobado de Instagram en cada idioma, y una cuenta de la marca. */
    const postWithTexts = async () => {
      const post = await newPost();
      const run = await repos.contentRuns.create({ postId: post.id, texts: true });
      await repos.contentRuns.markRunning(run.id);
      await repos.contentRuns.markSucceeded(run.id, {
        report: REPORT,
        contents: [
          newContent("instagram", { language: "es", body: "Hola" }),
          newContent("instagram", { language: "en", body: "Hello" }),
        ],
      });
      const texts = await repos.contents.listCurrent(postSubject(post.id));
      const account = await repos.accounts.upsertConnected(connectedAccount(brand));
      return { post, texts, accountId: account.id };
    };

    describe("PostRepository", () => {
      it("create nace manual, en draft y con el brief del operador; get lo devuelve igual", async () => {
        const post = await repos.posts.create({
          brokerId: brand,
          topic: "Bastidores",
          kind: "text",
        });
        expect(post).toMatchObject({
          brokerId: brand,
          topic: "Bastidores",
          kind: "text",
          brief: null,
          briefOrigin: "operator",
          status: "draft",
          source: "manual",
          pillar: null,
          plannedAt: null,
          planRunId: null,
          createdBy: null,
          rationale: null,
        });
        expect(await repos.posts.get(post.id)).toEqual(post);
        expect(await repos.posts.get(repos.missingId)).toBeNull();
      });

      it("list filtra por alcance, marca, estado y fecha, por fecha planificada (las sin fecha al final)", async () => {
        const owner = (await repos.brokers.create(brokerData(unique("lista")))).id;
        const late = await newPost(owner, { plannedAt: new Date("2026-11-03T13:00:00Z") });
        const early = await newPost(owner, { plannedAt: new Date("2026-11-01T13:00:00Z") });
        const undated = await newPost(owner);
        const idea = await newPost(owner, {
          status: "idea",
          source: "ai",
          briefOrigin: "ai",
          plannedAt: new Date("2026-11-02T13:00:00Z"),
        });
        const foreign = await newPost(other);
        const ids = (posts: { id: string }[]) => posts.map((post) => post.id);

        expect(ids(await repos.posts.list({}, brokerScope(owner)))).toEqual([
          early.id,
          idea.id,
          late.id,
          undated.id,
        ]);
        expect(ids(await repos.posts.list({ status: "draft" }, brokerScope(owner)))).toEqual([
          early.id,
          late.id,
          undated.id,
        ]);
        expect(
          ids(await repos.posts.list({ status: ["idea", "ready"] }, brokerScope(owner))),
        ).toEqual([idea.id]);
        expect(
          ids(
            await repos.posts.list(
              { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-03T13:00:00Z") },
              brokerScope(owner),
            ),
          ),
        ).toEqual([idea.id]);
        // El alcance manda sobre el filtro: un corredor nunca ve lo de otra marca.
        expect(await repos.posts.list({ brokerId: other }, brokerScope(owner))).toEqual([]);
        expect(ids(await repos.posts.list({ brokerId: other }, ALL_SCOPE))).toContain(foreign.id);
      });

      it("update cambia solo lo dado; archive es idempotente; un post que no existe es POST_NOT_FOUND", async () => {
        const post = await newPost(brand, { brief: "El brief", pillar: "producto" });
        const at = new Date("2026-11-05T15:00:00Z");
        const updated = await repos.posts.update(post.id, {
          topic: "Otro tema",
          plannedAt: at,
          pillar: null,
        });
        expect(updated).toMatchObject({
          topic: "Otro tema",
          brief: "El brief",
          pillar: null,
          plannedAt: at,
          status: "draft",
        });
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(post.updatedAt.getTime());
        const archived = await repos.posts.archive(post.id);
        expect(archived.status).toBe("archived");
        expect(await repos.posts.archive(post.id)).toEqual(archived);
        await expect(repos.posts.update(repos.missingId, { topic: "x" })).rejects.toMatchObject({
          code: "POST_NOT_FOUND",
        });
        await expect(repos.posts.archive(repos.missingId)).rejects.toMatchObject({
          code: "POST_NOT_FOUND",
        });
      });
    });

    describe("corridas y textos de un post", () => {
      it("una corrida por post a la vez (CONTENT_RUN_CONFLICT, reintentable), aparte de las de avisos", async () => {
        const post = await newPost();
        const run = await repos.contentRuns.create({ postId: post.id, texts: true });
        expect(run).toMatchObject({ subject: postSubject(post.id), listingId: null });
        await expect(
          repos.contentRuns.create({ postId: post.id, texts: true }),
        ).rejects.toMatchObject({ code: "CONTENT_RUN_CONFLICT", retriable: true });
        expect(await repos.contentRuns.findActive(postSubject(post.id))).toEqual(run);
        expect(await repos.contentRuns.latest(postSubject(post.id))).toEqual(run);
        expect(await repos.contentRuns.get(run.id)).toEqual(run);
        // Un aviso con su propia corrida no choca con la del post.
        const listing = await repos.listings.create(newListing(brand, unique("P-SUJ")));
        const listingRun = await repos.contentRuns.create({ listingId: listing.id, texts: true });
        expect(listingRun.subject).toEqual(listingSubject(listing.id));
        expect(await repos.contentRuns.findActive(listingSubject(listing.id))).toEqual(listingRun);
        expect(await repos.contentRuns.findActive(listingSubject(listing.id))).toEqual(listingRun);
        // Las corridas de posts no son de `content.prepare`: el barrido no las ve.
        expect((await repos.contentRuns.listQueued()).map((item) => item.id)).not.toContain(run.id);
        // Las reencola su propio barrido (`post.draft`, F9-T05), que no ve las de avisos.
        const queuedPosts = (await repos.contentRuns.listQueued("post")).map((item) => item.id);
        expect(queuedPosts).toContain(run.id);
        expect(queuedPosts).not.toContain(listingRun.id);
      });

      it("markSucceeded guarda un texto por red e idioma del post; listCurrent los da en orden", async () => {
        const post = await newPost();
        const run = await repos.contentRuns.create({ postId: post.id, texts: true });
        await repos.contentRuns.markRunning(run.id);
        expect(
          await repos.contentRuns.markSucceeded(run.id, {
            report: REPORT,
            contents: [
              newContent("discord", { language: "en", title: null }),
              newContent("instagram", { language: "en" }),
              newContent("instagram", { language: "es" }),
              newContent("discord", { title: null }),
            ],
          }),
        ).toBe(true);
        const current = await repos.contents.listCurrent(postSubject(post.id));
        expect(current.map((content) => [content.platform, content.language])).toEqual([
          ["instagram", "es"],
          ["instagram", "en"],
          ["discord", "es"],
          ["discord", "en"],
        ]);
        expect(current.every((content) => content.status === "draft")).toBe(true);
        expect(current[0]).toMatchObject({ subject: postSubject(post.id), listingId: null });
        expect(await repos.contents.get(current[0]?.id ?? "")).toEqual(current[0]);
        // Lo del post no aparece en un aviso.
        expect(await repos.contents.listCurrent(listingSubject(post.id))).toEqual([]);
      });

      it("un canal repetido en el mismo idioma es CONTENT_PLATFORM_DUPLICATED, sin escribir nada", async () => {
        const post = await newPost();
        const run = await repos.contentRuns.create({ postId: post.id, texts: true });
        await repos.contentRuns.markRunning(run.id);
        await expect(
          repos.contentRuns.markSucceeded(run.id, {
            report: REPORT,
            contents: [newContent("x", { language: "en" }), newContent("x", { language: "en" })],
          }),
        ).rejects.toMatchObject({ code: "CONTENT_PLATFORM_DUPLICATED", retriable: false });
        expect((await repos.contentRuns.get(run.id))?.status).toBe("running");
        expect(await repos.contents.listCurrent(postSubject(post.id))).toEqual([]);
      });
    });

    describe("publicaciones de un post", () => {
      it("nacen con el post y su idioma; una activa por post, cuenta, formato e idioma", async () => {
        const { post, texts, accountId } = await postWithTexts();
        const [es, en] = texts;
        const input = {
          postId: post.id,
          platformAccountId: accountId,
          platform: "instagram" as const,
          format: "post" as const,
          contentId: es?.id ?? "",
          mediaIds: [],
        };
        const spanish = await repos.publications.create(input, { actor: "operator" });
        expect(spanish).toMatchObject({
          subject: postSubject(post.id),
          listingId: null,
          language: "es",
          status: "approved",
          listingSourceHash: null,
          relistedFrom: null,
          costUsd: null,
        });
        await expect(repos.publications.create(input, { actor: "operator" })).rejects.toMatchObject(
          { code: "PUBLICATION_CONFLICT", retriable: false },
        );
        // El otro idioma es otra publicación de la misma cuenta (spec F9 §4.4).
        const english = await repos.publications.create(
          { ...input, contentId: en?.id ?? "", language: "en", costUsd: 0.015 },
          { actor: "operator" },
        );
        expect(english).toMatchObject({ language: "en", costUsd: 0.015 });
        expect(await repos.publications.get(english.id)).toEqual(english);
        expect(
          (await repos.publications.listBySubject(postSubject(post.id))).map((item) => item.id),
        ).toEqual([spanish.id, english.id]);
        // Descartada, deja nacer otra.
        await repos.publications.transition(
          spanish.id,
          { from: "approved", to: "cancelled" },
          { actor: "operator" },
        );
        await expect(
          repos.publications.create(input, { actor: "operator" }),
        ).resolves.toMatchObject({ status: "approved" });
      });

      it("los barridos ven también las publicaciones de posts (F9-T06), con su sujeto", async () => {
        const { post, texts, accountId } = await postWithTexts();
        const publication = await repos.publications.create(
          {
            postId: post.id,
            platformAccountId: accountId,
            platform: "instagram",
            format: "reel",
            contentId: texts[0]?.id ?? "",
            mediaIds: [],
          },
          { actor: "system" },
        );
        await repos.publications.transition(
          publication.id,
          {
            from: "approved",
            to: "scheduled",
            changes: { dryRun: true, scheduledAt: new Date(Date.now() - 60_000) },
          },
          { actor: "system" },
        );
        const scheduled = await repos.publications.listByStatus("scheduled");
        expect(scheduled.find((item) => item.id === publication.id)?.subject).toEqual({
          kind: "post",
          id: post.id,
        });
        const due = await repos.publications.listDue({
          now: new Date(),
          since: new Date(Date.now() - 3_600_000),
          excludePlatforms: [],
          limit: 100,
        });
        expect(due.map((item) => item.id)).toContain(publication.id);
      });

      it("listForTracking trae las de esos posts junto a las de esos avisos (F9-T08)", async () => {
        const { post, texts, accountId } = await postWithTexts();
        const otherPost = await postWithTexts();
        const input = {
          platformAccountId: accountId,
          platform: "instagram" as const,
          format: "post" as const,
          contentId: texts[0]?.id ?? "",
          mediaIds: [],
        };
        const mine = await repos.publications.create(
          { ...input, postId: post.id },
          { actor: "system" },
        );
        const theirs = await repos.publications.create(
          { ...input, postId: otherPost.post.id, platformAccountId: otherPost.accountId },
          { actor: "system" },
        );
        const since = new Date(Date.now() - 60_000);
        const found = await repos.publications.listForTracking({
          listingIds: [],
          postIds: [post.id],
          since,
        });
        expect(found.map((item) => item.id)).toEqual([mine.id]);
        expect(found[0]?.subject).toEqual(postSubject(post.id));
        expect(
          (
            await repos.publications.listForTracking({
              listingIds: [],
              postIds: [post.id, otherPost.post.id],
              since,
            })
          ).map((item) => item.id),
        ).toEqual(expect.arrayContaining([mine.id, theirs.id]));
        // Sin posts, las de posts no aparecen (los avisos de siempre).
        expect(
          await repos.publications.listForTracking({ listingIds: [repos.missingId], since }),
        ).toEqual([]);
      });
    });

    describe("medios de un post", () => {
      const original = (postId: string, checksum: string): NewMedia => ({
        listingId: null,
        postId,
        brokerId: brand,
        kind: "image",
        storagePath: `posts/${postId}/original/${checksum}.jpg`,
        mime: "image/jpeg",
        bytes: 2048,
        checksum,
        sortOrder: 0,
        isCover: false,
      });

      it("un original por post y checksum (MEDIA_CONFLICT, reintentable); otro post puede repetirlo", async () => {
        const post = await newPost();
        const another = await newPost();
        const checksum = unique("sha-post");
        const created = await repos.media.create(original(post.id, checksum));
        expect(created).toMatchObject({ postId: post.id, listingId: null });
        await expect(
          repos.media.create({
            ...original(post.id, checksum),
            storagePath: `posts/${post.id}/original/${checksum}-b.jpg`,
          }),
        ).rejects.toMatchObject({ code: "MEDIA_CONFLICT", retriable: true });
        await expect(repos.media.create(original(another.id, checksum))).resolves.toMatchObject({
          postId: another.id,
        });
        // De un aviso y de un post a la vez: un bug de quien llama.
        const listing = await repos.listings.create(newListing(brand, unique("P-MED")));
        await expect(
          repos.media.create({ ...original(post.id, unique("sha")), listingId: listing.id }),
        ).rejects.toMatchObject({ code: "MEDIA_SUBJECT_INVALID", retriable: false });
      });

      it("listOriginals, arrange, listBySubject y la variante de un original de un post", async () => {
        const post = await newPost();
        const first = await repos.media.create(original(post.id, unique("sha-a")));
        const second = await repos.media.create(original(post.id, unique("sha-b")));
        await repos.media.arrange(postSubject(post.id), [
          { id: second.id, sortOrder: 0, isCover: true },
          { id: first.id, sortOrder: 1, isCover: false },
        ]);
        expect(
          (await repos.media.listOriginals(postSubject(post.id))).map((item) => [
            item.id,
            item.isCover,
          ]),
        ).toEqual([
          [second.id, true],
          [first.id, false],
        ]);
        await expect(
          repos.media.arrange(postSubject((await newPost()).id), [
            { id: first.id, sortOrder: 0, isCover: false },
          ]),
        ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });

        const variant = {
          role: "processed" as const,
          variant: "ig_4x5" as const,
          parentMediaId: first.id,
          postId: post.id,
          brokerId: brand,
          kind: "image" as const,
          storagePath: `posts/${post.id}/processed/ig_4x5/${first.id}.jpg`,
          mime: "image/jpeg",
          width: 1080,
          height: 1350,
          durationS: null,
          bytes: 1024,
          checksum: unique("sha-variante"),
        };
        const { media: derived } = await repos.media.upsertDerivative(variant);
        expect(derived).toMatchObject({ postId: post.id, listingId: null, role: "processed" });
        expect(
          (await repos.media.listBySubject(postSubject(post.id))).map((item) => item.id),
        ).toEqual([second.id, first.id, derived.id]);
        // El original de otro post no sirve de padre, y un post no tiene renders.
        await expect(
          repos.media.upsertDerivative({ ...variant, postId: (await newPost()).id }),
        ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
        await expect(
          repos.media.upsertDerivative({
            ...variant,
            role: "rendered",
            variant: "cover",
            parentMediaId: null,
          }),
        ).rejects.toMatchObject({ code: "MEDIA_DERIVATIVE_INVALID" });

        // F9-T10: el video para X es un video; como imagen, es un bug de quien llama.
        const xVideo = {
          ...variant,
          variant: "x_video" as const,
          kind: "video" as const,
          storagePath: `posts/${post.id}/processed/x_video/${first.id}.mp4`,
          mime: "video/mp4",
          width: 720,
          height: 1280,
          durationS: 12.5,
          checksum: unique("sha-x"),
        };
        await expect(repos.media.upsertDerivative(xVideo)).resolves.toMatchObject({
          media: { variant: "x_video", kind: "video", postId: post.id },
        });
        await expect(
          repos.media.upsertDerivative({ ...xVideo, kind: "image" }),
        ).rejects.toMatchObject({ code: "MEDIA_DERIVATIVE_INVALID" });
      });
    });

    describe("PostUploadRepository", () => {
      it("nace pendiente; una clave repetida es POST_UPLOAD_CONFLICT; los cambios son condicionales", async () => {
        const post = await newPost();
        const now = new Date();
        const path = `posts/${post.id}/uploads/${unique("archivo")}.jpg`;
        const upload = await repos.postUploads.create({
          postId: post.id,
          objectPath: path,
          expectedBytes: 5000,
          expiresAt: new Date(now.getTime() - 1000),
        });
        expect(upload).toMatchObject({ postId: post.id, status: "pending", expectedBytes: 5000 });
        await expect(
          repos.postUploads.create({
            postId: post.id,
            objectPath: path,
            expectedBytes: 1,
            expiresAt: now,
          }),
        ).rejects.toMatchObject({ code: "POST_UPLOAD_CONFLICT" });
        const fresh = await repos.postUploads.create({
          postId: post.id,
          objectPath: `${path}.2`,
          expectedBytes: 10,
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        expect((await repos.postUploads.listByPost(post.id)).map((item) => item.id)).toEqual([
          upload.id,
          fresh.id,
        ]);
        expect((await repos.postUploads.listExpired(now)).map((item) => item.id)).toContain(
          upload.id,
        );
        expect(await repos.postUploads.markAbandoned(upload.id)).toBe(true);
        expect(await repos.postUploads.markCompleted(upload.id)).toBe(false);
        expect((await repos.postUploads.listExpired(now)).map((item) => item.id)).not.toContain(
          upload.id,
        );
        expect(await repos.postUploads.markCompleted(fresh.id)).toBe(true);
        expect((await repos.postUploads.get(fresh.id))?.status).toBe("completed");
        expect(await repos.postUploads.markCompleted(repos.missingId)).toBe(false);
      });

      it("reopen vuelve a pendiente con el vencimiento nuevo, desde cualquier estado (F9-T10)", async () => {
        const post = await newPost();
        const now = new Date();
        const upload = await repos.postUploads.create({
          postId: post.id,
          objectPath: `posts/${post.id}/original/${unique("sha")}.jpg`,
          expectedBytes: 7,
          expiresAt: new Date(now.getTime() - 1000),
        });
        expect(await repos.postUploads.markAbandoned(upload.id)).toBe(true);
        const later = new Date(now.getTime() + 3_600_000);
        const reopened = await repos.postUploads.reopen(upload.id, later);
        expect(reopened).toMatchObject({ id: upload.id, status: "pending" });
        expect(reopened?.expiresAt.getTime()).toBe(later.getTime());
        expect((await repos.postUploads.listExpired(now)).map((item) => item.id)).not.toContain(
          upload.id,
        );
        expect(await repos.postUploads.markCompleted(upload.id)).toBe(true);
        expect((await repos.postUploads.reopen(upload.id, later))?.status).toBe("pending");
        expect(await repos.postUploads.reopen(repos.missingId, later)).toBeNull();
      });
    });

    describe("PlanRunRepository", () => {
      it("nace en queued; los cambios de estado son condicionales y el gasto se suma", async () => {
        const plan = await repos.planRuns.create({
          brokerId: brand,
          periodStart: new Date("2026-11-01T03:00:00Z"),
          periodEnd: new Date("2026-11-15T03:00:00Z"),
          request: { platforms: ["instagram"], ideas: 10 },
        });
        expect(plan).toMatchObject({
          brokerId: brand,
          status: "queued",
          request: { platforms: ["instagram"], ideas: 10 },
          report: null,
          error: null,
          llmUsage: null,
          promptVersion: null,
          startedAt: null,
        });
        expect(
          await repos.planRuns.markSucceeded(plan.id, { report: {}, promptVersion: "v" }),
        ).toBe(false);
        expect(await repos.planRuns.markRunning(plan.id)).toBe(true);
        const used = await repos.planRuns.addLlmUsage(plan.id, call(0.01));
        expect(used.llmUsage?.costUsd).toBeCloseTo(0.01, 10);
        expect(
          await repos.planRuns.markSucceeded(plan.id, {
            report: { ideas: [{ topic: "Una idea" }] },
            promptVersion: "social-v1",
          }),
        ).toBe(true);
        expect(await repos.planRuns.markFailed(plan.id, { code: "X", message: "x" })).toBe(false);
        expect(await repos.planRuns.get(plan.id)).toMatchObject({
          status: "succeeded",
          report: { ideas: [{ topic: "Una idea" }] },
          promptVersion: "social-v1",
        });
        expect((await repos.planRuns.listByBroker(brand)).map((item) => item.id)).toContain(
          plan.id,
        );
        await expect(repos.planRuns.addLlmUsage(repos.missingId, call(1))).rejects.toMatchObject({
          code: "PLAN_RUN_NOT_FOUND",
        });
      });
    });

    describe("EditorialProfileRepository", () => {
      it("un perfil por corredor: get da null sin perfil, upsert crea y después reemplaza", async () => {
        const owner = (await repos.brokers.create(brokerData(unique("perfil")))).id;
        expect(await repos.editorialProfiles.get(owner)).toBeNull();
        const created = await repos.editorialProfiles.upsert(owner, profile());
        expect(created).toMatchObject({ brokerId: owner, ...profile() });
        expect(await repos.editorialProfiles.get(owner)).toEqual(created);
        const replaced = await repos.editorialProfiles.upsert(
          owner,
          profile({ languages: ["en"], facts: [] }),
        );
        expect(replaced).toMatchObject({ languages: ["en"], facts: [] });
        expect(replaced.createdAt).toEqual(created.createdAt);
        // El de otra marca no cambió (no existe).
        expect(await repos.editorialProfiles.get(other)).toBeNull();
      });
    });

    it("sumLlmCost suma las corridas de avisos, las de posts y los planes de cada corredor", async () => {
      const owner = (await repos.brokers.create(brokerData(unique("gasto-f9")))).id;
      const listing = await repos.listings.create(newListing(owner, unique("P-GASTO")));
      const listingRun = await repos.contentRuns.create({ listingId: listing.id, texts: true });
      await repos.contentRuns.addLlmUsage(listingRun.id, call(0.02));
      const post = await newPost(owner);
      const postRun = await repos.contentRuns.create({ postId: post.id, texts: true });
      await repos.contentRuns.addLlmUsage(postRun.id, call(0.03));
      const plan = await repos.planRuns.create({
        brokerId: owner,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86_400_000),
        request: {},
      });
      await repos.planRuns.addLlmUsage(plan.id, call(0.05));
      // Un plan sin gasto no cuenta.
      await repos.planRuns.create({
        brokerId: owner,
        periodStart: new Date(),
        periodEnd: new Date(),
        request: {},
      });

      const now = Date.now();
      const range = { from: new Date(now - 60_000), to: new Date(now + 60_000) };
      const [spend] = await repos.contentRuns.sumLlmCost({ ...range, brokerId: owner });
      expect(spend?.brokerId).toBe(owner);
      expect(spend?.runs).toBe(3);
      expect(spend?.costUsd).toBeCloseTo(0.1, 10);
      const all = await repos.contentRuns.sumLlmCost(range);
      expect(all.find((row) => row.brokerId === owner)?.runs).toBe(3);
    });
  });
}
