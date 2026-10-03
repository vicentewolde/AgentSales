import type { Content, ContentRun } from "../content.js";
import { isTerminalContentRun, PLATFORMS } from "../enums.js";
import { AppError } from "../errors.js";
import {
  type ContentRepository,
  type ContentRunRepository,
  checkNewContents,
  pickContentChanges,
} from "../ports/content-repository.js";
import { structuredCopy } from "./copy.js";

export type InMemoryContentRepositories = {
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  /** Todas las filas de `contents`, en orden de creación (para revisar el historial). */
  allContents(): Content[];
};

const isActive = (status: ContentRun["status"]) => !isTerminalContentRun(status);

/**
 * `ContentRunRepository` y `ContentRepository` en memoria, con la semántica de Postgres (spec F2
 * §4.3): una corrida activa por aviso (`CONTENT_RUN_CONFLICT`), cambios de estado condicionales,
 * `markSucceeded` todo o nada y el contenido vigente = el más reciente por canal. Comparten el
 * almacén porque `markSucceeded` escribe las dos tablas. El orden es el de creación: el doble no
 * tiene reloj propio. A diferencia de Postgres, no verifica que el aviso exista (allí, la FK da
 * `DB_QUERY_FAILED`): en la aplicación el aviso siempre se carga antes.
 */
export function createInMemoryContentRepositories(
  options: { nextId?: () => string } = {},
): InMemoryContentRepositories {
  let sequence = 0;
  const nextId = options.nextId ?? (() => `content-${++sequence}`);
  const runs: ContentRun[] = [];
  const contents: Content[] = [];

  const findRun = (id: string) => runs.find((run) => run.id === id);
  const replaceRun = (updated: ContentRun) => {
    runs[runs.findIndex((run) => run.id === updated.id)] = updated;
  };

  const contentRuns: ContentRunRepository = {
    async create(run) {
      if (runs.some((stored) => stored.listingId === run.listingId && isActive(stored.status))) {
        throw new AppError(
          "CONTENT_RUN_CONFLICT",
          `El aviso ${run.listingId} ya tiene una corrida de contenido en curso`,
          { retriable: true },
        );
      }
      const created: ContentRun = {
        id: nextId(),
        listingId: run.listingId,
        status: "queued",
        texts: run.texts,
        stage: null,
        report: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      };
      runs.push(created);
      return structuredCopy(created);
    },
    async get(id) {
      const run = findRun(id);
      return run === undefined ? null : structuredCopy(run);
    },
    async findActive(listingId) {
      const run = runs.find((stored) => stored.listingId === listingId && isActive(stored.status));
      return run === undefined ? null : structuredCopy(run);
    },
    async latest(listingId) {
      const run = runs.findLast((stored) => stored.listingId === listingId);
      return run === undefined ? null : structuredCopy(run);
    },
    async listQueued() {
      return runs.filter((run) => run.status === "queued").map(structuredCopy);
    },
    async markRunning(id) {
      const run = findRun(id);
      if (run === undefined || !isActive(run.status)) return false;
      replaceRun({ ...run, status: "running", startedAt: run.startedAt ?? new Date() });
      return true;
    },
    async setStage(id, stage) {
      const run = findRun(id);
      if (run?.status !== "running") return false;
      replaceRun({ ...run, stage });
      return true;
    },
    async markSucceeded(id, { report, contents: rows }) {
      checkNewContents(rows);
      const run = findRun(id);
      if (run?.status !== "running") return false;
      // Como el único (content_run_id, platform): un canal que ya tiene fila no guarda nada.
      const saved = contents.filter((content) => content.contentRunId === id);
      if (rows.some((row) => saved.some((content) => content.platform === row.platform))) {
        return false;
      }
      const now = new Date();
      for (const row of rows) {
        contents.push({
          ...structuredCopy(row),
          // Como jsonb NOT NULL: una salida ausente se guarda como `null`.
          rawOutput: structuredCopy(row.rawOutput ?? null),
          id: nextId(),
          listingId: run.listingId,
          contentRunId: id,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        });
      }
      replaceRun({ ...run, status: "succeeded", report: structuredCopy(report), finishedAt: now });
      return true;
    },
    async markFailed(id, error, report) {
      const run = findRun(id);
      if (run === undefined || !isActive(run.status)) return false;
      replaceRun({
        ...run,
        status: "failed",
        error: { ...error },
        report: report === undefined ? run.report : structuredCopy(report),
        finishedAt: new Date(),
      });
      return true;
    },
    async failAbandoned(startedBefore, error) {
      const closed: string[] = [];
      for (const run of runs) {
        if (run.status === "running" && run.startedAt !== null && run.startedAt < startedBefore) {
          replaceRun({ ...run, status: "failed", error: { ...error }, finishedAt: new Date() });
          closed.push(run.id);
        }
      }
      return closed;
    },
  };

  const contentRepository: ContentRepository = {
    async listCurrent(listingId) {
      return PLATFORMS.flatMap((platform) => {
        const current = contents.findLast(
          (content) => content.listingId === listingId && content.platform === platform,
        );
        return current === undefined ? [] : [structuredCopy(current)];
      });
    },
    async get(id) {
      const content = contents.find((stored) => stored.id === id);
      return content === undefined ? null : structuredCopy(content);
    },
    async update(id, changes) {
      const index = contents.findIndex((stored) => stored.id === id);
      const current = contents[index];
      if (current === undefined) {
        throw new AppError("CONTENT_NOT_FOUND", `No existe el contenido ${id}`);
      }
      const updated: Content = {
        ...current,
        ...structuredCopy(pickContentChanges(changes)),
        updatedAt: new Date(),
      };
      contents[index] = updated;
      return structuredCopy(updated);
    },
  };

  return {
    contentRuns,
    contents: contentRepository,
    allContents: () => contents.map(structuredCopy),
  };
}
