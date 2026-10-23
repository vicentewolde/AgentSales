import type { AbortSignalLike } from "../abort.js";
import type { Broker } from "../broker.js";
import { postOriginalPath } from "../content/media-keys.js";
import { AppError, isAppError } from "../errors.js";
import { assertImageAiBudget, type ImageAiPricing } from "../image-ai-budget.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { CardBrand, CardRenderer } from "../ports/card-renderer.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { MediaProcessor, VideoOutput } from "../ports/media-processor.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type { ImageFile, ImageGenerator, StockPhotoProvider } from "../ports/post-image-sources.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { Post } from "../post.js";
import { postCardDeck } from "../post-cards.js";
import {
  imageAiPrompt,
  POST_IMAGE_LIMITS,
  type PostImageRequest,
  postImageNotNeeded,
  postImageSourceNotConfigured,
  sniffImage,
} from "../post-image.js";
import { scrubMessage } from "../redact.js";
import { postSubject } from "../subject.js";
import { POST_UPLOAD } from "./post-uploads.js";

// El job `post.image` (F9.5-T25, ADR-0038): consigue lo pedido (tarjetas, una foto de la biblioteca
// o una imagen con IA), lo guarda en R2 como un original del post (la clave por su sha256, como una
// foto subida), crea sus medios en el candado del post y encola `post.media` para sus variantes.
// Así pasa por la vista previa y la aprobación igual que una foto subida (ADR-0038 §7).

export type RunPostImageDeps = {
  runs: PostImageRunRepository;
  posts: Pick<PostRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  contents: Pick<ContentRepository, "listCurrent">;
  media: Pick<MediaRepository, "get" | "listOriginals">;
  storage: Pick<MediaStorage, "get" | "put" | "putStream">;
  postLock: PostLock;
  queue: JobQueue;
  cards: CardRenderer;
  /** El procesador del intento: solo arma el video de las tarjetas (`processPhotoReel`). */
  processor: Pick<MediaProcessor, "processPhotoReel">;
  /** La biblioteca (sin `PIXABAY_API_KEY`, `null`). */
  stock: StockPhotoProvider | null;
  /** La IA con su precio y tope (sin `GEMINI_API_KEY`, `null`). */
  ai: { generator: ImageGenerator; pricing: ImageAiPricing } | null;
  sha256: (bytes: Uint8Array) => string;
  now?: () => Date;
};

export type RunPostImageResult =
  | { outcome: "skipped"; reason: "not_active" }
  | { outcome: "succeeded"; mediaIds: string[]; created: number }
  | { outcome: "failed"; code: string };

/** Un archivo listo para guardar como original del post. */
type Produced =
  | { kind: "image"; bytes: Uint8Array; mime: string; extension: string; sha256: string }
  | { kind: "video"; video: VideoOutput };

const invalidDownload = (what: string) =>
  new AppError(
    "STOCK_DOWNLOAD_INVALID",
    `${what}: no es una foto JPG, PNG ni WebP o pasa de 20 MB`,
  );

/**
 * Revisa un archivo de afuera antes de guardarlo: el tipo por sus bytes (no por lo que dice el
 * proveedor) y el tamaño.
 */
function checkedImage(
  file: ImageFile,
  sha256: (bytes: Uint8Array) => string,
  onInvalid: () => AppError,
): Produced {
  const type = sniffImage(file.bytes);
  if (
    type === null ||
    file.bytes.length === 0 ||
    file.bytes.length > POST_IMAGE_LIMITS.downloadMaxBytes
  ) {
    throw onInvalid();
  }
  return {
    kind: "image",
    bytes: file.bytes,
    mime: type.mime,
    extension: type.extension,
    sha256: sha256(file.bytes),
  };
}

/** La marca para las tarjetas: sus colores y su logo (el PNG que se guardó al subirlo), si hay. */
async function cardBrand(
  deps: Pick<RunPostImageDeps, "media" | "storage">,
  broker: Broker,
): Promise<CardBrand> {
  const logo = broker.logoMediaId === null ? null : await deps.media.get(broker.logoMediaId);
  const usable = logo !== null && ["image/png", "image/jpeg", "image/webp"].includes(logo.mime);
  return {
    brandName: broker.brandName,
    primaryColor: broker.primaryColor,
    secondaryColor: broker.secondaryColor,
    logo: usable ? await deps.storage.get(logo.storagePath) : null,
  };
}

async function produce(
  deps: RunPostImageDeps,
  runId: string,
  post: Post,
  broker: Broker,
  request: PostImageRequest,
  signal: AbortSignalLike | undefined,
): Promise<Produced[]> {
  if (post.kind === "text") throw postImageNotNeeded(post.id);
  if (request.source === "card") {
    const contents = await deps.contents.listCurrent(postSubject(post.id));
    const deck = postCardDeck({ ...post, kind: post.kind }, contents, broker);
    const brand = await cardBrand(deps, broker);
    const format = post.kind === "video" ? "9:16" : request.format;
    const rendered = [];
    for (const card of deck) {
      rendered.push(await deps.cards.render(card, { format, brand }, signal));
    }
    if (post.kind !== "video") {
      return rendered.map((card) => ({
        kind: "image",
        bytes: card.bytes,
        mime: card.mime,
        extension: "jpg",
        sha256: card.sha256,
      }));
    }
    // El video de las tarjetas: el mismo motor del reel desde fotos (F9.5-T18), sin texto encima.
    // La música del post (F9.5-T19) la pone `post.media` en el reel y en los demás videos, como en
    // un video subido (aquí iría dos veces).
    const video = await deps.processor.processPhotoReel(
      rendered.map((card) => ({ mime: card.mime, read: async () => card.bytes })),
      { overlayPng: null, music: null },
      signal,
    );
    return [{ kind: "video", video }];
  }
  if (request.source === "stock") {
    if (deps.stock === null) throw postImageSourceNotConfigured("stock");
    const file = await deps.stock.download(request.photoId, signal);
    return [checkedImage(file, deps.sha256, () => invalidDownload("La foto de la biblioteca"))];
  }
  if (deps.ai === null) throw postImageSourceNotConfigured("ai");
  await assertImageAiBudget(
    { runs: deps.runs },
    broker,
    deps.ai.pricing,
    (deps.now ?? (() => new Date()))(),
  );
  const generated = await deps.ai.generator.generate(
    { prompt: imageAiPrompt(request.prompt), format: request.format },
    signal,
  );
  // Se cobra apenas la entrega, aunque después algo falle (ADR-0038 §3).
  await deps.runs.recordCost(runId, { costUsd: deps.ai.pricing.priceUsd, model: generated.model });
  return [
    checkedImage(
      generated,
      deps.sha256,
      () =>
        new AppError(
          "IMAGE_AI_UNEXPECTED_RESPONSE",
          "La IA entregó algo que no es una imagen JPG, PNG ni WebP",
        ),
    ),
  ];
}

const tooMany = (postId: string) =>
  new AppError(
    "POST_IMAGE_TOO_MANY",
    `Un post tiene hasta ${POST_UPLOAD.maxMediaPerPost} medios: quita alguno antes de conseguir más`,
    { details: { postId } },
  );

/**
 * Atiende un pedido de imágenes de un post (job `post.image`). Un pedido que ya terminó se salta.
 * Un error reintentable sube (el job reintenta) salvo en el último intento; los demás dejan el
 * pedido `failed` con su código y un mensaje limpio.
 */
export async function runPostImage(
  deps: RunPostImageDeps,
  params: { runId: string; isLastAttempt: boolean; signal?: AbortSignalLike },
): Promise<RunPostImageResult> {
  const run = await deps.runs.get(params.runId);
  if (run === null || !(await deps.runs.markRunning(run.id))) {
    return { outcome: "skipped", reason: "not_active" };
  }
  try {
    const post = await deps.posts.get(run.postId);
    if (post === null || post.status === "archived") {
      throw new AppError("POST_ARCHIVED", "El post está archivado o ya no existe");
    }
    const broker = await deps.brokers.findById(post.brokerId);
    if (broker === null) throw new AppError("BROKER_NOT_FOUND", "La marca del post ya no existe");
    const before = await deps.media.listOriginals(postSubject(post.id));
    if (before.length >= POST_UPLOAD.maxMediaPerPost) throw tooMany(post.id);

    const produced = await produce(deps, run.id, post, broker, run.request, params.signal);
    const files = produced.map((item) =>
      item.kind === "image"
        ? {
            item,
            sha256: item.sha256,
            path: postOriginalPath(post.id, item.sha256, item.extension),
            mime: item.mime,
            bytes: item.bytes.length,
          }
        : {
            item,
            sha256: item.video.sha256,
            path: postOriginalPath(post.id, item.video.sha256, "mp4"),
            mime: "video/mp4",
            bytes: item.video.size,
          },
    );
    for (const file of files) {
      if (file.item.kind === "image") {
        await deps.storage.put(file.path, file.item.bytes, file.mime);
      } else {
        await deps.storage.putStream(file.path, file.item.video.open(), {
          contentType: "video/mp4",
          contentLength: file.item.video.size,
          sha256: file.item.video.sha256,
        });
      }
    }

    const { mediaIds, created } = await deps.postLock.run(post.id, async ({ media }) => {
      const originals = await media.listOriginals(postSubject(post.id));
      const bySha = new Map(originals.map((item) => [item.checksum, item.id]));
      const fresh = new Set(files.filter((file) => !bySha.has(file.sha256)).map((f) => f.sha256));
      if (originals.length + fresh.size > POST_UPLOAD.maxMediaPerPost) throw tooMany(post.id);
      let nextOrder = originals.reduce((max, item) => Math.max(max, item.sortOrder + 1), 0);
      const ids: string[] = [];
      let count = 0;
      for (const file of files) {
        const existing = bySha.get(file.sha256);
        if (existing !== undefined) {
          if (!ids.includes(existing)) ids.push(existing);
          continue;
        }
        const record = await media.create({
          listingId: null,
          postId: post.id,
          brokerId: post.brokerId,
          kind: file.item.kind,
          storagePath: file.path,
          mime: file.mime,
          bytes: file.bytes,
          checksum: file.sha256,
          sortOrder: nextOrder++,
          isCover: false,
        });
        bySha.set(file.sha256, record.id);
        ids.push(record.id);
        count++;
      }
      return { mediaIds: ids, created: count };
    });
    // Las variantes (miniatura, 4:5, reel…), como después de una subida.
    await deps.queue.enqueue("post.media", { postId: post.id }, { singletonKey: post.id });
    await deps.runs.markSucceeded(run.id, mediaIds);
    return { outcome: "succeeded", mediaIds, created };
  } catch (error) {
    if (isAppError(error) && error.retriable && !params.isLastAttempt) throw error;
    const code = isAppError(error) ? error.code : "INTERNAL_ERROR";
    const message = isAppError(error)
      ? scrubMessage(error.message)
      : "Algo falló al conseguir la imagen: vuelve a intentarlo";
    await deps.runs.markFailed(run.id, { code, message });
    return { outcome: "failed", code };
  }
}
