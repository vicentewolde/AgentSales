import type { Content, ContentRun } from "../content.js";
import { isTerminalContentRun, PLATFORMS } from "../enums.js";
import { AppError } from "../errors.js";
import { addLlmCall } from "../llm-usage.js";
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
  options: {
    nextId?: () => string;
    /**
     * El corredor de un aviso, para `sumLlmCost` (Postgres lo cruza con `listings`). Sin esto,
     * `sumLlmCost` falla: solo lo necesitan los tests del gasto.
     */
    brokerOfListing?: (listingId: string) => string | null;
  } = {},
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
        llmUsage: null,
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
    async addLlmUsage(id, call) {
      const run = findRun(id);
      if (run === undefined) {
        throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida de contenido ${id}`);
      }
      const updated = { ...run, llmUsage: addLlmCall(run.llmUsage, call) };
      replaceRun(updated);
      return structuredCopy(updated);
    },
    async sumLlmCost({ from, to, brokerId }) {
      const brokerOf = options.brokerOfListing;
      if (brokerOf === undefined)
        throw new Error("El doble necesita `brokerOfListing` para sumLlmCost");
      const totals = new Map<string, { costUsd: number; runs: number }>();
      for (const run of runs) {
        if (run.llmUsage === null || run.createdAt < from || run.createdAt >= to) continue;
        const owner = brokerOf(run.listingId);
        if (owner === null || (brokerId !== undefined && owner !== brokerId)) continue;
        const total = totals.get(owner) ?? { costUsd: 0, runs: 0 };
        totals.set(owner, { costUsd: total.costUsd + run.llmUsage.costUsd, runs: total.runs + 1 });
      }
      return [...totals].map(([id, total]) => ({ brokerId: id, ...total }));
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
    async listCurrentMany(listingIds) {
      const wanted = [...new Set(listingIds)];
      return (await Promise.all(wanted.map((id) => contentRepository.listCurrent(id)))).flat();
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
