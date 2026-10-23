import { AppError } from "../errors.js";
import { roundUsd } from "../llm-usage.js";
import type { CardRenderer, CardSpec } from "../ports/card-renderer.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type {
  ImageFile,
  ImageGenerator,
  StockPhoto,
  StockPhotoProvider,
} from "../ports/post-image-sources.js";
import type { PostImageFormat, PostImageRun } from "../post-image.js";
import { structuredCopy } from "./copy.js";
import { fakeHash } from "./fake-hash.js";

// Dobles de las imágenes de un post (F9.5-T25): el repositorio de pedidos, las tarjetas, la
// biblioteca y la IA, sin sharp ni red.

const uuidLike = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const later = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1));

/**
 * `PostImageRunRepository` en memoria, con los cambios de estado condicionales y el único activo
 * por post de Postgres. `createdAt` sale de `now` (para probar el mes del gasto).
 */
export function createInMemoryPostImageRunRepository(
  options: { now?: () => Date } = {},
): PostImageRunRepository & { all(): PostImageRun[] } {
  let sequence = 0;
  const runs = new Map<string, PostImageRun>();
  const change = (
    id: string,
    from: readonly PostImageRun["status"][],
    patch: Partial<PostImageRun>,
  ) => {
    const current = runs.get(id);
    if (current === undefined || !from.includes(current.status)) return false;
    runs.set(id, { ...current, ...patch, updatedAt: later(current.updatedAt) });
    return true;
  };
  return {
    all: () => [...runs.values()].map(structuredCopy),
    async create(input) {
      const active = [...runs.values()].find(
        (run) =>
          run.postId === input.postId && (run.status === "queued" || run.status === "running"),
      );
      if (active !== undefined) {
        throw new AppError(
          "POST_IMAGE_RUN_ACTIVE",
          "Ya se está consiguiendo una imagen para este post: espera a que termine",
        );
      }
      const now = (options.now ?? (() => new Date()))();
      const run: PostImageRun = {
        id: uuidLike(++sequence),
        postId: input.postId,
        brokerId: input.brokerId,
        source: input.source,
        status: "queued",
        request: structuredCopy(input.request),
        mediaIds: [],
        costUsd: null,
        model: null,
        error: null,
        createdBy: input.createdBy,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      runs.set(run.id, run);
      return structuredCopy(run);
    },
    async get(id) {
      const run = runs.get(id);
      return run === undefined ? null : structuredCopy(run);
    },
    async listByPost(postId, limit) {
      return [...runs.values()]
        .filter((run) => run.postId === postId)
        .reverse()
        .slice(0, limit)
        .map(structuredCopy);
    },
    async markRunning(id) {
      const current = runs.get(id);
      return change(id, ["queued", "running"], {
        status: "running",
        startedAt: current?.startedAt ?? new Date(),
      });
    },
    async markSucceeded(id, mediaIds) {
      return change(id, ["running"], {
        status: "succeeded",
        mediaIds: [...mediaIds],
        finishedAt: new Date(),
      });
    },
    async markFailed(id, error) {
      return change(id, ["queued", "running"], {
        status: "failed",
        error: { ...error },
        finishedAt: new Date(),
      });
    },
    async reserveImageCost(id, { costUsd, model, capUsd, from, to }) {
      const current = runs.get(id);
      if (current === undefined) return false;
      // Como la transacción de Postgres: lo gastado por la marca en el rango, más esta imagen.
      const spent = [...runs.values()]
        .filter(
          (run) =>
            run.brokerId === current.brokerId &&
            run.costUsd !== null &&
            run.createdAt >= from &&
            run.createdAt < to,
        )
        .reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      if (roundUsd(spent + costUsd) > roundUsd(capUsd)) return false;
      runs.set(id, { ...current, costUsd: roundUsd((current.costUsd ?? 0) + costUsd), model });
      return true;
    },
    async releaseImageCost(id, costUsd) {
      const current = runs.get(id);
      if (current === undefined) return;
      const left = roundUsd((current.costUsd ?? 0) - costUsd);
      runs.set(id, { ...current, costUsd: left > 0 ? left : null });
    },
    async listQueued() {
      return [...runs.values()].filter((run) => run.status === "queued").map(structuredCopy);
    },
    async failAbandoned(startedBefore, error) {
      const closed: string[] = [];
      for (const run of runs.values()) {
        if (run.status !== "running" || run.startedAt === null || run.startedAt >= startedBefore)
          continue;
        change(run.id, ["running"], {
          status: "failed",
          error: { ...error },
          finishedAt: new Date(),
        });
        closed.push(run.id);
      }
      return closed;
    },
    async sumImageCost({ from, to, brokerId }) {
      const totals = new Map<string, { costUsd: number; images: number }>();
      for (const run of runs.values()) {
        if (run.costUsd === null || run.createdAt < from || run.createdAt >= to) continue;
        if (brokerId !== undefined && run.brokerId !== brokerId) continue;
        const total = totals.get(run.brokerId) ?? { costUsd: 0, images: 0 };
        totals.set(run.brokerId, {
          costUsd: roundUsd(total.costUsd + run.costUsd),
          images: total.images + 1,
        });
      }
      return [...totals].map(([id, total]) => ({ brokerId: id, ...total }));
    },
  };
}

// Core no carga los tipos de Node ni del DOM (sin `TextEncoder`): un byte por carácter.
const encoder = {
  encode: (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff),
};
/** Bytes que empiezan como un JPEG, para que `sniffImage` los acepte. */
export const fakeJpeg = (text: string): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, ...encoder.encode(text)]);

/** Tarjetas falsas: un «JPEG» con el papel, la proporción y el texto; guarda cada llamada. */
export function createFakeCardRenderer(): CardRenderer & {
  calls: { card: CardSpec; format: PostImageFormat; brandName: string; logo: boolean }[];
} {
  const calls: { card: CardSpec; format: PostImageFormat; brandName: string; logo: boolean }[] = [];
  return {
    version: "fake-1",
    calls,
    async render(card, { format, brand }) {
      calls.push({ card, format, brandName: brand.brandName, logo: brand.logo !== null });
      const text = `card:${format}:${card.role}:${card.position}/${card.total}:${card.text}`;
      const [width, height] = format === "4:5" ? [1080, 1350] : [1080, 1920];
      return {
        bytes: fakeJpeg(text),
        width: width ?? 1080,
        height: height ?? 1350,
        mime: "image/jpeg",
        sha256: fakeHash(text),
      };
    },
  };
}

/** Una biblioteca falsa: las fotos dadas para toda búsqueda, y un archivo por id. */
export function createFakeStockPhotoProvider(
  options: { photos?: StockPhoto[]; file?: ImageFile; error?: AppError } = {},
): StockPhotoProvider & { searches: string[]; downloads: string[] } {
  const searches: string[] = [];
  const downloads: string[] = [];
  return {
    name: "fake",
    searches,
    downloads,
    async search({ text, perPage }) {
      searches.push(text);
      if (options.error !== undefined) throw options.error;
      return (options.photos ?? []).slice(0, perPage).map(structuredCopy);
    },
    async download(photoId) {
      downloads.push(photoId);
      if (options.error !== undefined) throw options.error;
      return options.file ?? { bytes: fakeJpeg(`stock:${photoId}`), mime: "image/jpeg" };
    },
  };
}

/** Una IA de imágenes falsa: un «JPEG» con la indicación, o el error dado. */
export function createFakeImageGenerator(
  options: { model?: string; file?: ImageFile; error?: AppError } = {},
): ImageGenerator & { prompts: { prompt: string; format: PostImageFormat }[] } {
  const prompts: { prompt: string; format: PostImageFormat }[] = [];
  return {
    name: "fake",
    prompts,
    async generate(request) {
      prompts.push({ ...request });
      if (options.error !== undefined) throw options.error;
      return {
        ...(options.file ?? { bytes: fakeJpeg(`ai:${request.prompt}`), mime: "image/jpeg" }),
        model: options.model ?? "fake-image-1",
      };
    },
  };
}
