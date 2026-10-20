import type { Content, ContentRun } from "../content.js";
import { isTerminalContentRun, LANGUAGES, LISTING_PLATFORMS, PLATFORMS } from "../enums.js";
import { AppError } from "../errors.js";
import { addLlmCall } from "../llm-usage.js";
import type { PlanRun } from "../plan-run.js";
import {
  type ContentRepository,
  type ContentRunRepository,
  checkNewContents,
  languageOf,
  pickContentChanges,
} from "../ports/content-repository.js";
import {
  listingSubject,
  type Subject,
  sameSubject,
  subjectFieldsFor,
  subjectOfInput,
} from "../subject.js";
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
 * §4.3): una corrida activa por aviso o post (`CONTENT_RUN_CONFLICT`), cambios de estado
 * condicionales, `markSucceeded` todo o nada y el contenido vigente = el más reciente por canal e
 * idioma. Comparten el
 * almacén porque `markSucceeded` escribe las dos tablas. El orden es el de creación: el doble no
 * tiene reloj propio. A diferencia de Postgres, no verifica que el aviso exista (allí, la FK da
 * `DB_QUERY_FAILED`): en la aplicación el aviso siempre se carga antes.
 */
export function createInMemoryContentRepositories(
  options: {
    nextId?: () => string;
    /**
     * El corredor de un aviso, para `sumLlmCost` (Postgres lo cruza con `listings`). Sin esto,
     * `sumLlmCost` falla al encontrar una corrida de aviso con gasto: solo lo necesitan los tests
     * del gasto.
     */
    brokerOfListing?: (listingId: string) => string | null | Promise<string | null>;
    /** El corredor de un post, para `sumLlmCost` (F9). Sin esto, un post no suma. */
    brokerOfPost?: (postId: string) => string | null | Promise<string | null>;
    /** Los planes de ideas, que también suman en `sumLlmCost` (F9, ADR-0030). */
    planRuns?: () => readonly PlanRun[] | Promise<readonly PlanRun[]>;
  } = {},
): InMemoryContentRepositories {
  let sequence = 0;
  const nextId = options.nextId ?? (() => `content-${++sequence}`);
  const runs: ContentRun[] = [];
  const contents: Content[] = [];
  /** `auto_publish_done_at` (F8-T12): fuera de la entidad, como en la base. */
  const autoPublishDone = new Set<string>();

  const findRun = (id: string) => runs.find((run) => run.id === id);
  const ofSubject = (subject: Subject) => (item: { subject: Subject }) =>
    sameSubject(item.subject, subject);
  const replaceRun = (updated: ContentRun) => {
    runs[runs.findIndex((run) => run.id === updated.id)] = updated;
  };

  const contentRuns: ContentRunRepository = {
    async create(run) {
      const subject = subjectOfInput(run);
      if (runs.some((stored) => ofSubject(subject)(stored) && isActive(stored.status))) {
        throw new AppError(
          "CONTENT_RUN_CONFLICT",
          `${subject.kind === "listing" ? "El aviso" : "El post"} ${subject.id} ya tiene una corrida de contenido en curso`,
          { retriable: true },
        );
      }
      const created: ContentRun = {
        id: nextId(),
        ...subjectFieldsFor(subject),
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
    async findActive(subject) {
      const run = runs.find((stored) => ofSubject(subject)(stored) && isActive(stored.status));
      return run === undefined ? null : structuredCopy(run);
    },
    async latest(subject) {
      const run = runs.findLast(ofSubject(subject));
      return run === undefined ? null : structuredCopy(run);
    },
    async listQueued(kind = "listing") {
      // Las de un solo tipo de sujeto, como en Postgres: las de posts no son de `content.prepare`.
      return runs
        .filter((run) => run.status === "queued" && run.subject.kind === kind)
        .map(structuredCopy);
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
      // Como el único (content_run_id, platform, language): un canal e idioma que ya tiene fila no
      // guarda nada.
      const saved = contents.filter((content) => content.contentRunId === id);
      const taken = (row: (typeof rows)[number]) =>
        saved.some(
          (content) => content.platform === row.platform && content.language === languageOf(row),
        );
      if (rows.some(taken)) return false;
      const now = new Date();
      for (const row of rows) {
        contents.push({
          ...structuredCopy(row),
          language: languageOf(row),
          // Como jsonb NOT NULL: una salida ausente se guarda como `null`.
          rawOutput: structuredCopy(row.rawOutput ?? null),
          id: nextId(),
          ...subjectFieldsFor(run.subject),
          contentRunId: id,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        });
      }
      replaceRun({ ...run, status: "succeeded", report: structuredCopy(report), finishedAt: now });
      return true;
    },
    async listAutoPublishPending(finishedSince) {
      return runs
        .filter(
          (run) =>
            run.status === "succeeded" &&
            run.subject.kind === "listing" &&
            run.texts &&
            !autoPublishDone.has(run.id) &&
            run.finishedAt !== null &&
            run.finishedAt >= finishedSince,
        )
        .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))
        .map(structuredCopy);
    },
    async markAutoPublishDone(id) {
      const run = findRun(id);
      if (run?.status !== "succeeded" || autoPublishDone.has(id)) return false;
      autoPublishDone.add(id);
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
      const totals = new Map<string, { costUsd: number; runs: number }>();
      const add = (owner: string | null, costUsd: number) => {
        if (owner === null || (brokerId !== undefined && owner !== brokerId)) return;
        const total = totals.get(owner) ?? { costUsd: 0, runs: 0 };
        totals.set(owner, { costUsd: total.costUsd + costUsd, runs: total.runs + 1 });
      };
      const inRange = (createdAt: Date) => createdAt >= from && createdAt < to;
      // Solo hace falta `brokerOfListing` si hay una corrida de aviso que sumar.
      const brokerOfListingRun = (listingId: string) => {
        if (options.brokerOfListing === undefined) {
          throw new Error("El doble necesita `brokerOfListing` para sumar una corrida de aviso");
        }
        return options.brokerOfListing(listingId);
      };
      for (const run of runs) {
        if (run.llmUsage === null || !inRange(run.createdAt)) continue;
        // Como el `left join` de Postgres: el corredor del aviso o del post, el que exista.
        const owner =
          run.subject.kind === "listing"
            ? await brokerOfListingRun(run.subject.id)
            : ((await options.brokerOfPost?.(run.subject.id)) ?? null);
        add(owner, run.llmUsage.costUsd);
      }
      for (const plan of (await options.planRuns?.()) ?? []) {
        if (plan.llmUsage === null || !inRange(plan.createdAt)) continue;
        add(plan.brokerId, plan.llmUsage.costUsd);
      }
      return [...totals].map(([id, total]) => ({ brokerId: id, ...total }));
    },
  };

  const contentRepository: ContentRepository = {
    async listCurrent(subject) {
      // Un aviso tiene sus canales (en español); un post, uno por red e idioma.
      const platforms = subject.kind === "listing" ? LISTING_PLATFORMS : PLATFORMS;
      return platforms.flatMap((platform) =>
        LANGUAGES.flatMap((language) => {
          const current = contents.findLast(
            (content) =>
              ofSubject(subject)(content) &&
              content.platform === platform &&
              content.language === language,
          );
          return current === undefined ? [] : [structuredCopy(current)];
        }),
      );
    },
    async listCurrentMany(listingIds) {
      const wanted = [...new Set(listingIds)];
      return (
        await Promise.all(wanted.map((id) => contentRepository.listCurrent(listingSubject(id))))
      ).flat();
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
