import {
  type BrokerRepository,
  type ContentRepository,
  type ContentRunReport,
  type ContentRunRepository,
  isAppError,
  type ListingRepository,
  type NewContent,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";
import { brokerData, newListing } from "./import-repositories.contract.js";

/**
 * Suite de contrato de los puertos de contenido (F2-T02): corre igual contra los dobles en memoria
 * (`@agentsales/core/testing`) y contra Drizzle sobre PGlite. Cada caso crea sus propios avisos:
 * la base se comparte entre casos.
 */
export type ContentRepositories = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

const REPORT: ContentRunReport = {
  media: { processed: 3, existing: 1, failed: 0 },
  renders: { rendered: 2, existing: 0 },
  reel: "none",
  llm: {
    provider: "fake",
    model: "modelo-falso",
    promptVersion: "listing-content-v1",
    attempts: 1,
    durationMs: 120,
  },
  warnings: ["Una foto tiene menos de 1080 px de ancho"],
};

/** Texto inventado de un canal; `rawOutput` es un objeto anidado, como el borrador de la IA. */
export const newContent = (
  platform: NewContent["platform"],
  overrides: Partial<NewContent> = {},
): NewContent => ({
  platform,
  title: platform === "instagram" ? null : `Título ${platform}`,
  body: `Texto de ${platform}`,
  hashtags: platform === "instagram" ? ["#nunoa", "#departamentoventa"] : [],
  llmProvider: "fake",
  llmModel: "modelo-falso",
  promptVersion: "listing-content-v1",
  rawOutput: { instagram: { hook: "Gancho" }, warnings: [] },
  ...overrides,
});

const ALL_PLATFORMS = [
  newContent("instagram"),
  newContent("portal_inmobiliario"),
  newContent("fb_marketplace"),
];

export function contentRepositoriesContract(
  name: string,
  make: () => Promise<ContentRepositories>,
) {
  describe(`${name} · ContentRunRepository y ContentRepository`, () => {
    let repos: ContentRepositories;
    let brokerId: string;
    beforeAll(async () => {
      repos = await make();
      brokerId = (await repos.brokers.create(brokerData(unique("contenido")))).id;
    });

    const newListingId = async () =>
      (await repos.listings.create(newListing(brokerId, unique("P-CONT")))).id;
    /** Una corrida en `running`, lista para terminar. */
    const runningRun = async (listingId?: string, texts = true) => {
      const run = await repos.contentRuns.create({
        listingId: listingId ?? (await newListingId()),
        texts,
      });
      expect(await repos.contentRuns.markRunning(run.id)).toBe(true);
      return run;
    };

    it("create nace en queued, sin etapa, reporte, error ni fechas; get lo devuelve", async () => {
      const listingId = await newListingId();
      const run = await repos.contentRuns.create({ listingId, texts: false });
      expect(run).toMatchObject({
        listingId,
        status: "queued",
        texts: false,
        stage: null,
        report: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      });
      expect(run.createdAt).toBeInstanceOf(Date);
      expect(await repos.contentRuns.get(run.id)).toEqual(run);
      expect(await repos.contentRuns.get(repos.missingId)).toBeNull();
    });

    it("una sola corrida activa por aviso: el segundo create es CONTENT_RUN_CONFLICT, reintentable", async () => {
      const listingId = await newListingId();
      const first = await repos.contentRuns.create({ listingId, texts: true });
      const error = await repos.contentRuns
        .create({ listingId, texts: false })
        .catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code).toBe("CONTENT_RUN_CONFLICT");
      expect(isAppError(error) && error.retriable).toBe(true);

      // También mientras corre; otro aviso no choca.
      await repos.contentRuns.markRunning(first.id);
      await expect(repos.contentRuns.create({ listingId, texts: true })).rejects.toMatchObject({
        code: "CONTENT_RUN_CONFLICT",
      });
      await expect(
        repos.contentRuns.create({ listingId: await newListingId(), texts: true }),
      ).resolves.toMatchObject({ status: "queued" });

      // Terminada, el aviso acepta otra.
      await repos.contentRuns.markFailed(first.id, { code: "X", message: "falló" });
      await expect(repos.contentRuns.create({ listingId, texts: true })).resolves.toMatchObject({
        status: "queued",
      });
    });

    it("findActive devuelve la corrida en cola o en curso; latest, la más reciente en cualquier estado", async () => {
      const listingId = await newListingId();
      expect(await repos.contentRuns.findActive(listingId)).toBeNull();
      expect(await repos.contentRuns.latest(listingId)).toBeNull();

      const first = await repos.contentRuns.create({ listingId, texts: true });
      expect((await repos.contentRuns.findActive(listingId))?.id).toBe(first.id);
      await repos.contentRuns.markRunning(first.id);
      expect((await repos.contentRuns.findActive(listingId))?.status).toBe("running");
      await repos.contentRuns.markSucceeded(first.id, { report: REPORT, contents: [] });
      expect(await repos.contentRuns.findActive(listingId)).toBeNull();
      expect((await repos.contentRuns.latest(listingId))?.id).toBe(first.id);

      const second = await repos.contentRuns.create({ listingId, texts: false });
      expect((await repos.contentRuns.latest(listingId))?.id).toBe(second.id);
    });

    it("listQueued devuelve solo las en cola, las más antiguas primero", async () => {
      const older = await repos.contentRuns.create({
        listingId: await newListingId(),
        texts: true,
      });
      const running = await runningRun();
      const newer = await repos.contentRuns.create({
        listingId: await newListingId(),
        texts: true,
      });
      const queued = (await repos.contentRuns.listQueued()).map((run) => run.id);
      expect(queued).not.toContain(running.id);
      expect(queued.indexOf(older.id)).toBeGreaterThanOrEqual(0);
      expect(queued.indexOf(older.id)).toBeLessThan(queued.indexOf(newer.id));
    });

    it("markRunning toma una corrida en cola o en curso, y fija started_at solo la primera vez", async () => {
      const run = await repos.contentRuns.create({ listingId: await newListingId(), texts: true });
      expect(await repos.contentRuns.markRunning(run.id)).toBe(true);
      const started = (await repos.contentRuns.get(run.id))?.startedAt;
      expect(started).toBeInstanceOf(Date);
      expect(await repos.contentRuns.markRunning(run.id)).toBe(true);
      expect((await repos.contentRuns.get(run.id))?.startedAt).toEqual(started);
    });

    it("setStage solo mientras la corrida está en running", async () => {
      const run = await repos.contentRuns.create({ listingId: await newListingId(), texts: true });
      expect(await repos.contentRuns.setStage(run.id, "media")).toBe(false);
      await repos.contentRuns.markRunning(run.id);
      expect(await repos.contentRuns.setStage(run.id, "renders")).toBe(true);
      expect((await repos.contentRuns.get(run.id))?.stage).toBe("renders");
      await repos.contentRuns.markSucceeded(run.id, { report: REPORT, contents: [] });
      expect(await repos.contentRuns.setStage(run.id, "texts")).toBe(false);
      expect((await repos.contentRuns.get(run.id))?.stage).toBe("renders");
    });

    it("markSucceeded guarda el reporte y los textos en draft, del aviso y de la corrida", async () => {
      const listingId = await newListingId();
      const run = await runningRun(listingId);
      expect(
        await repos.contentRuns.markSucceeded(run.id, { report: REPORT, contents: ALL_PLATFORMS }),
      ).toBe(true);

      const done = await repos.contentRuns.get(run.id);
      expect(done).toMatchObject({ status: "succeeded", report: REPORT, error: null });
      expect(done?.finishedAt).toBeInstanceOf(Date);

      const current = await repos.contents.listCurrent(listingId);
      expect(current.map((content) => content.platform)).toEqual([
        "instagram",
        "portal_inmobiliario",
        "fb_marketplace",
      ]);
      expect(current[0]).toMatchObject({
        listingId,
        contentRunId: run.id,
        status: "draft",
        title: null,
        body: "Texto de instagram",
        hashtags: ["#nunoa", "#departamentoventa"],
        llmProvider: "fake",
        promptVersion: "listing-content-v1",
        rawOutput: { instagram: { hook: "Gancho" }, warnings: [] },
      });
    });

    it("markSucceeded no cambia nada si la corrida no está en running", async () => {
      const listingId = await newListingId();
      const queued = await repos.contentRuns.create({ listingId, texts: true });
      expect(
        await repos.contentRuns.markSucceeded(queued.id, {
          report: REPORT,
          contents: ALL_PLATFORMS,
        }),
      ).toBe(false);
      expect(await repos.contentRuns.get(queued.id)).toEqual(queued);
      expect(await repos.contents.listCurrent(listingId)).toEqual([]);
    });

    it("markSucceeded es todo o nada: un canal repetido deshace la transacción y la corrida sigue en running", async () => {
      const listingId = await newListingId();
      const run = await runningRun(listingId);
      const before = await repos.contentRuns.get(run.id);
      expect(
        await repos.contentRuns.markSucceeded(run.id, {
          report: REPORT,
          contents: [newContent("instagram"), newContent("instagram", { body: "Otra" })],
        }),
      ).toBe(false);
      expect(await repos.contentRuns.get(run.id)).toEqual(before);
      expect(await repos.contents.listCurrent(listingId)).toEqual([]);
    });

    it("el vigente es el más reciente por canal; una corrida sin textos conserva el anterior y su edición", async () => {
      const listingId = await newListingId();
      const first = await runningRun(listingId);
      await repos.contentRuns.markSucceeded(first.id, { report: REPORT, contents: ALL_PLATFORMS });
      const [instagram] = await repos.contents.listCurrent(listingId);
      if (instagram === undefined) throw new Error("se esperaba el texto de Instagram");
      await repos.contents.update(instagram.id, { body: "Editado a mano", status: "edited" });

      const mediaOnly = await runningRun(listingId, false);
      await repos.contentRuns.markSucceeded(mediaOnly.id, { report: REPORT, contents: [] });
      expect((await repos.contents.listCurrent(listingId))[0]).toMatchObject({
        id: instagram.id,
        body: "Editado a mano",
        status: "edited",
      });

      const second = await runningRun(listingId);
      await repos.contentRuns.markSucceeded(second.id, {
        report: REPORT,
        contents: [newContent("instagram", { body: "Regenerado" })],
      });
      const current = await repos.contents.listCurrent(listingId);
      expect(current.map((content) => [content.platform, content.contentRunId])).toEqual([
        ["instagram", second.id],
        ["portal_inmobiliario", first.id],
        ["fb_marketplace", first.id],
      ]);
      expect(current[0]?.body).toBe("Regenerado");
      // El editado sigue en la base como historial.
      expect((await repos.contents.get(instagram.id))?.body).toBe("Editado a mano");
      // Otro aviso no ve estos textos.
      expect(await repos.contents.listCurrent(await newListingId())).toEqual([]);
    });

    it("markFailed desde queued o running, con error, reporte opcional y finished_at", async () => {
      const queued = await repos.contentRuns.create({
        listingId: await newListingId(),
        texts: true,
      });
      const error = { code: "LLM_AUTH_REQUIRED", message: "La CLI de Claude no tiene sesión" };
      expect(await repos.contentRuns.markFailed(queued.id, error)).toBe(true);
      expect(await repos.contentRuns.get(queued.id)).toMatchObject({
        status: "failed",
        error,
        report: null,
      });

      const running = await runningRun();
      expect(await repos.contentRuns.markFailed(running.id, error, REPORT)).toBe(true);
      const failed = await repos.contentRuns.get(running.id);
      expect(failed).toMatchObject({ status: "failed", error, report: REPORT });
      expect(failed?.finishedAt).toBeInstanceOf(Date);
    });

    it("una corrida terminal no cambia: el primer estado terminal gana", async () => {
      const succeeded = await runningRun();
      await repos.contentRuns.markSucceeded(succeeded.id, { report: REPORT, contents: [] });
      const failed = await repos.contentRuns.create({
        listingId: await newListingId(),
        texts: true,
      });
      await repos.contentRuns.markFailed(failed.id, { code: "X", message: "primero" });

      for (const run of [succeeded, failed]) {
        const before = await repos.contentRuns.get(run.id);
        expect(await repos.contentRuns.markRunning(run.id)).toBe(false);
        expect(await repos.contentRuns.setStage(run.id, "texts")).toBe(false);
        expect(
          await repos.contentRuns.markSucceeded(run.id, {
            report: REPORT,
            contents: ALL_PLATFORMS,
          }),
        ).toBe(false);
        expect(await repos.contentRuns.markFailed(run.id, { code: "Y", message: "otro" })).toBe(
          false,
        );
        expect(await repos.contentRuns.get(run.id)).toEqual(before);
        expect(await repos.contents.listCurrent(before?.listingId ?? "")).toEqual([]);
      }
    });

    it("failAbandoned cierra las running viejas; deja las recientes, las queued y las terminadas", async () => {
      const old = await runningRun();
      const queued = await repos.contentRuns.create({
        listingId: await newListingId(),
        texts: true,
      });
      const done = await runningRun();
      await repos.contentRuns.markSucceeded(done.id, { report: REPORT, contents: [] });
      const error = { code: "CONTENT_RUN_ABANDONED", message: "La corrida quedó a medias" };

      // Un corte en el futuro: todo lo que está running "empezó antes".
      const closed = await repos.contentRuns.failAbandoned(new Date(Date.now() + 60_000), error);
      expect(closed).toContain(old.id);
      expect(closed).not.toContain(queued.id);
      expect(closed).not.toContain(done.id);
      expect(await repos.contentRuns.get(old.id)).toMatchObject({ status: "failed", error });
      expect((await repos.contentRuns.get(queued.id))?.status).toBe("queued");
      expect((await repos.contentRuns.get(done.id))?.status).toBe("succeeded");

      const recent = await runningRun();
      expect(
        await repos.contentRuns.failAbandoned(new Date(Date.now() - 60_000), error),
      ).not.toContain(recent.id);
      expect((await repos.contentRuns.get(recent.id))?.status).toBe("running");
    });

    it("los cambios de estado de un id inexistente devuelven false", async () => {
      const id = repos.missingId;
      expect(await repos.contentRuns.markRunning(id)).toBe(false);
      expect(await repos.contentRuns.setStage(id, "media")).toBe(false);
      expect(await repos.contentRuns.markSucceeded(id, { report: REPORT, contents: [] })).toBe(
        false,
      );
      expect(await repos.contentRuns.markFailed(id, { code: "X", message: "x" })).toBe(false);
    });

    it("update cambia solo los campos dados y updated_at; get de un id inexistente es null", async () => {
      const listingId = await newListingId();
      const run = await runningRun(listingId);
      await repos.contentRuns.markSucceeded(run.id, { report: REPORT, contents: ALL_PLATFORMS });
      const portal = (await repos.contents.listCurrent(listingId))[1];
      if (portal === undefined) throw new Error("se esperaba el texto de Portal");

      const updated = await repos.contents.update(portal.id, {
        title: "Título editado",
        status: "edited",
      });
      expect(updated).toMatchObject({
        id: portal.id,
        title: "Título editado",
        body: portal.body,
        hashtags: portal.hashtags,
        status: "edited",
        createdAt: portal.createdAt,
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(portal.updatedAt.getTime());
      expect(await repos.contents.get(portal.id)).toEqual(updated);
      expect(await repos.contents.get(repos.missingId)).toBeNull();
    });

    it("update de un id inexistente → CONTENT_NOT_FOUND", async () => {
      await expect(repos.contents.update(repos.missingId, { body: "x" })).rejects.toMatchObject({
        code: "CONTENT_NOT_FOUND",
        retriable: false,
      });
    });
  });
}
