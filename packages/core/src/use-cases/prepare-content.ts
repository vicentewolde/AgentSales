import type { AbortSignalLike } from "../abort.js";
import type { Broker } from "../broker.js";
import { assembleContents } from "../content/assemble.js";
import { type ContentCheckContext, checkContent } from "../content/check.js";
import { loadCheckContext } from "../content/check-context.js";
import { coverPhoto, variantOf, videosOf } from "../content/compose.js";
import { generateContentDraft } from "../content/generate.js";
import {
  reelPath,
  reelTextInput,
  renderInput,
  renderPath,
  variantPath,
} from "../content/media-keys.js";
import { CONTENT_PROMPT_VERSION } from "../content/prompt.js";
import { coverData, reelOverlayData, slideBrand, specSheetData } from "../content/slides-data.js";
import type { ContentRun, ContentRunReport } from "../content.js";
import {
  type ContentRunStage,
  isTerminalContentRun,
  PLATFORMS,
  type RenderedMediaVariant,
} from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import { photoSizeWarnings, REEL_MIN_DURATION_S, reelWarnings } from "../media-checks.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository, NewContent } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import type { ImageVariant, MediaProcessor } from "../ports/media-processor.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import {
  type HtmlRenderer,
  SLIDE_IMAGE_MIMES,
  SLIDE_SIZES,
  type SlideImage,
  type SlideImageMime,
  type SlideImageRef,
  type SlideTemplates,
} from "../ports/slide-templates.js";

export type PrepareContentDeps = {
  contentRuns: ContentRunRepository;
  listings: Pick<ListingRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  fieldDefinitions: FieldDefinitionRepository;
  media: MediaRepository;
  storage: MediaStorage;
  processor: MediaProcessor;
  templates: SlideTemplates;
  renderer: HtmlRenderer;
  llm: LLMProvider;
  /** sha256 hexadecimal de un texto (core no usa `node:crypto`; lo inyecta quien compone). */
  sha256: (text: string) => string;
  /** Reloj en milisegundos, para la duración de la llamada a la IA. */
  now?: () => number;
  /**
   * Un objeto viejo de R2 que no se pudo borrar (al reemplazar un derivado). No corta la corrida:
   * solo queda en el log (spec F2 §4.2).
   */
  onCleanupFailed?: (path: string, error: unknown) => void;
};

export type PrepareContentParams = {
  contentRunId: string;
  /** Último intento del job: un error deja la corrida en `failed`. */
  isLastAttempt: boolean;
  /** El del worker: se dispara al apagarse. */
  signal?: AbortSignalLike;
};

export type PrepareContentResult =
  | { outcome: "succeeded"; report: ContentRunReport }
  /** La corrida ya estaba terminada, o un intento solapado guardó antes: no se hizo nada. */
  | { outcome: "skipped"; status: ContentRun["status"] };

/** Las variantes de una foto. */
const PHOTO_VARIANTS: readonly ImageVariant[] = ["thumb", "ig_4x5", "pi_4x3"];

const ordered = (media: readonly Media[]) =>
  media
    .filter((item) => item.role === "original")
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));

const isDecodeFailed = (error: unknown) =>
  isAppError(error) && error.code === "MEDIA_DECODE_FAILED";

/**
 * Mensajes fijos para los errores que pueden traer claves de R2 o rutas (`STORAGE_*`, `MEDIA_*`):
 * el error de la corrida lo muestran la API, el panel y la CLI (spec F2 §4.9).
 */
const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  STORAGE_NOT_FOUND:
    "Falta un archivo del aviso en el almacenamiento: vuelve a importar sus medios",
  STORAGE_UNAVAILABLE: "El almacenamiento de archivos no respondió",
  STORAGE_ERROR: "El almacenamiento de archivos rechazó la operación",
  STORAGE_CONTENT_MISMATCH: "Un archivo cambió mientras se subía",
  MEDIA_CONFLICT: "Otra preparación del mismo aviso escribió los medios al mismo tiempo",
  MEDIA_NOT_FOUND: "Falta un medio del aviso",
};

/**
 * El error que se guarda en la corrida: sin claves de R2 ni rutas absolutas (dos o más tramos; un
 * comando como `/login` queda).
 */
export function contentRunErrorOf(error: AppError): { code: string; message: string } {
  const message =
    FIXED_MESSAGES[error.code] ??
    error.message
      .replace(/brokers\/\S+/g, "<archivo>")
      .replace(/(?:^|\s)\/[^\s/]+\/\S+/g, " <ruta>");
  return { code: error.code, message };
}

const aborted = (cause?: unknown) =>
  new AppError("CONTENT_RUN_ABORTED", "Se cortó la corrida de contenido", {
    retriable: true,
    ...(cause === undefined ? {} : { cause }),
  });

/** La corrida ya no está en `running` (la cerró otro intento): este intento termina `skipped`. */
class RunClosed extends Error {}

function normalized(error: unknown): AppError {
  return isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al preparar el contenido", { cause: error });
}

/** Lo que una corrida comparte entre etapas. */
type Run = {
  deps: PrepareContentDeps;
  run: ContentRun;
  listing: Listing;
  broker: Broker;
  ctx: ContentCheckContext;
  ids: { brokerId: string; listingId: string };
  report: ContentRunReport;
  signal: AbortSignalLike | undefined;
};

/**
 * Prepara el contenido de un aviso (el handler del job `content.prepare`, spec F2 §4.4), por
 * etapas idempotentes: `media` (medidas y variantes), `renders` (portada y ficha), `reel` y `texts`
 * (IA, ensamblado y revisión). Cada etapa rehace solo lo que falta: un reintento, o una corrida sin
 * cambios, no vuelve a procesar ni a subir lo que ya está (las claves de R2 son determinísticas).
 * - Una corrida terminal no se toca (`skipped`); `markRunning` y `markSucceeded` son condicionales.
 * - Un error no reintentable, o el último intento, deja la corrida en `failed` con el reporte hasta
 *   donde llegó, **salvo** que el worker se esté apagando (`signal`): entonces relanza sin tocarla.
 */
export async function prepareContent(
  deps: PrepareContentDeps,
  { contentRunId, isLastAttempt, signal }: PrepareContentParams,
): Promise<PrepareContentResult> {
  const run = await deps.contentRuns.get(contentRunId);
  if (run === null) {
    throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida ${contentRunId}`, {
      details: { contentRunId },
    });
  }
  if (isTerminalContentRun(run.status)) return { outcome: "skipped", status: run.status };
  if (!(await deps.contentRuns.markRunning(run.id))) return skipped(deps, run);

  const report: ContentRunReport = { warnings: [] };
  let contents: NewContent[] = [];
  try {
    const state = await load(deps, run, report, signal);
    await stage(state, "media", () => mediaStage(state));
    await stage(state, "renders", () => rendersStage(state));
    await stage(state, "reel", () => reelStage(state));
    if (run.texts) contents = await stage(state, "texts", () => textsStage(state));
  } catch (caught) {
    if (caught instanceof RunClosed) return skipped(deps, run);
    const error = normalized(caught);
    // Corte por apagado: la corrida queda en `running` y el error sube como reintentable, aunque el
    // adaptador cortado haya dado otro (spec F2 §4.4). La retoma un reintento, un nuevo pedido o la
    // limpieza de abandonadas.
    if (signal?.aborted) throw error.retriable ? error : aborted(error);
    if (!error.retriable || isLastAttempt) {
      await deps.contentRuns
        .markFailed(run.id, contentRunErrorOf(error), report)
        .catch(() => false);
    }
    throw error;
  }

  if (!(await deps.contentRuns.markSucceeded(run.id, { report, contents })))
    return skipped(deps, run);
  return { outcome: "succeeded", report };
}

async function skipped(deps: PrepareContentDeps, run: ContentRun): Promise<PrepareContentResult> {
  const current = await deps.contentRuns.get(run.id);
  return { outcome: "skipped", status: current?.status ?? run.status };
}

/**
 * Marca la etapa y la corre. Si la corrida ya no está en `running` (la cerró un intento solapado),
 * este intento se detiene en el acto: no sigue gastando la IA ni el procesador.
 */
async function stage<T>(state: Run, name: ContentRunStage, work: () => Promise<T>): Promise<T> {
  if (state.signal?.aborted) throw aborted();
  if (!(await state.deps.contentRuns.setStage(state.run.id, name))) throw new RunClosed();
  return work();
}

/** El aviso, su corredor y el contexto (el mismo brief para la IA, el ensamblado y la revisión). */
async function load(
  deps: PrepareContentDeps,
  run: ContentRun,
  report: ContentRunReport,
  signal: AbortSignalLike | undefined,
): Promise<Run> {
  const { listing, broker, ctx } = await loadCheckContext(deps, run.listingId);
  return {
    deps,
    run,
    listing,
    broker,
    ctx,
    ids: { brokerId: listing.brokerId, listingId: listing.id },
    report,
    signal,
  };
}

/** Sube un derivado, lo registra y borra el objeto anterior si la clave cambió. */
async function saveDerivative(
  state: Run,
  upload: () => Promise<void>,
  derivative: Parameters<MediaRepository["upsertDerivative"]>[0],
): Promise<void> {
  await upload();
  const { previousPath } = await state.deps.media.upsertDerivative(derivative);
  if (previousPath !== null && previousPath !== derivative.storagePath) {
    await state.deps.storage
      .delete(previousPath)
      .catch((error: unknown) => state.deps.onCleanupFailed?.(previousPath, error));
  }
}

/**
 * Etapa `media`: mide cada original y arma las variantes que le faltan (las vigentes son las de la
 * clave de la versión actual del procesador). Las medidas se guardan antes que las variantes. Un
 * medio ilegible es un aviso; sin ninguna foto procesada, `CONTENT_NO_PHOTOS`.
 */
async function mediaStage(state: Run): Promise<void> {
  const { deps, ids } = state;
  const counts = { processed: 0, existing: 0, failed: 0 };
  const media = await deps.media.listByListing(ids.listingId);
  const originals = ordered(media);
  const pathOf = (original: Media, variant: ImageVariant) =>
    variantPath(ids, variant, original.checksum, deps.processor.version);

  let photoNumber = 0;
  let videoNumber = 0;
  for (const original of originals) {
    const label = original.kind === "image" ? `Foto ${++photoNumber}` : `Video ${++videoNumber}`;
    const variants: readonly ImageVariant[] =
      original.kind === "image" ? PHOTO_VARIANTS : ["thumb"];
    const missing = variants.filter(
      (variant) =>
        variantOf(media, original.id, variant)?.storagePath !== pathOf(original, variant),
    );
    const measured =
      original.width !== null && (original.kind === "image" || original.durationS !== null);
    if (missing.length === 0 && measured) {
      counts.existing += 1;
      continue;
    }
    try {
      const outputs =
        original.kind === "image"
          ? await processPhoto(state, original, missing)
          : await processVideoThumb(state, original);
      for (const output of outputs) {
        const storagePath = pathOf(original, output.variant);
        await saveDerivative(
          state,
          () => deps.storage.put(storagePath, output.bytes, output.mime),
          {
            role: "processed",
            variant: output.variant,
            parentMediaId: original.id,
            listingId: ids.listingId,
            brokerId: ids.brokerId,
            kind: "image",
            storagePath,
            mime: output.mime,
            bytes: output.bytes.length,
            checksum: output.sha256,
            width: output.width,
            height: output.height,
            durationS: null,
          },
        );
      }
      counts.processed += 1;
    } catch (error) {
      if (!isDecodeFailed(error)) throw error;
      counts.failed += 1;
      state.report.warnings.push(`${label}: no se pudo leer (formato no válido o archivo dañado)`);
    }
  }
  state.report.media = counts;

  // Avisos de tamaño desde las medidas guardadas: también de las fotos que ya estaban procesadas.
  const after = await deps.media.listByListing(ids.listingId);
  ordered(after)
    .filter((item) => item.kind === "image")
    .forEach((photo, index) => {
      for (const warning of photoSizeWarnings(photo.width)) {
        state.report.warnings.push(`Foto ${index + 1}: ${warning.message}`);
      }
    });
  const photosReady = ordered(after).some(
    (photo) => photo.kind === "image" && variantOf(after, photo.id, "ig_4x5") !== null,
  );
  if (!photosReady) {
    throw new AppError("CONTENT_NO_PHOTOS", "Ninguna foto del aviso se pudo procesar", {
      details: { listingId: ids.listingId },
    });
  }
}

/** Una foto: la lee, la mide (guardando las medidas) y devuelve las variantes que faltaban. */
async function processPhoto(state: Run, original: Media, variants: readonly ImageVariant[]) {
  const { deps, signal } = state;
  const bytes = await deps.storage.get(original.storagePath);
  const result = await deps.processor.processImage(
    bytes,
    { mime: original.mime, variants },
    signal,
  );
  await deps.media.updateMeasurements(original.id, result.measurements);
  return result.outputs;
}

/** Un video: lo lee en streaming, lo mide (guardando las medidas) y devuelve su `thumb`. */
async function processVideoThumb(state: Run, original: Media) {
  const { deps, signal } = state;
  const stream = await deps.storage.getStream(
    original.storagePath,
    signal === undefined ? {} : { signal },
  );
  const result = await deps.processor.processVideo(stream, { reel: null }, signal);
  await deps.media.updateMeasurements(original.id, result.measurements);
  return [result.thumb];
}

const isSlideMime = (mime: string): mime is SlideImageMime =>
  (SLIDE_IMAGE_MIMES as readonly string[]).includes(mime);

/** La referencia de una imagen guardada (para la clave del render), si se puede incrustar. */
function imageRef(media: Media | null): SlideImageRef | null {
  if (media === null || !isSlideMime(media.mime)) return null;
  return { mime: media.mime, sha256: media.checksum };
}

/** Borra un derivado vigente y su objeto: mejor no tener uno que tener uno desactualizado. */
async function dropDerivative(state: Run, media: Media | null | undefined): Promise<void> {
  if (media === null || media === undefined) return;
  const path = await state.deps.media.deleteDerivative(media.id);
  if (path !== null) {
    await state.deps.storage
      .delete(path)
      .catch((error: unknown) => state.deps.onCleanupFailed?.(path, error));
  }
}

/**
 * Etapa `renders`: portada y ficha, solo si cambió su entrada (los datos, la foto de portada, el
 * logo o la versión de las plantillas). Las imágenes se descargan solo para dibujar.
 */
async function rendersStage(state: Run): Promise<void> {
  const { deps, ids, ctx, broker, signal } = state;
  const counts = { rendered: 0, existing: 0 };
  const media = await deps.media.listByListing(ids.listingId);
  const coverOriginal = coverPhoto(media);
  const photo = coverOriginal === null ? null : variantOf(media, coverOriginal.id, "ig_4x5");
  const photoRef = imageRef(photo);
  if (photo === null || photoRef === null) {
    // `mediaStage` ya exige al menos una foto procesada; la de portada pudo fallar. La portada
    // anterior (con otra foto o datos viejos) no queda vigente.
    state.report.warnings.push("La foto de portada no se pudo procesar: no se armó la portada");
    await dropDerivative(
      state,
      media.find((item) => item.role === "rendered" && item.variant === "cover"),
    );
  }

  const logo = broker.logoMediaId === null ? null : await deps.media.get(broker.logoMediaId);
  const logoRef = imageRef(logo);
  if (logo !== null && logoRef === null) {
    state.report.warnings.push(
      "El logo no es JPG, PNG ni WebP: la portada y la ficha muestran el nombre de la marca",
    );
  }
  const bytesOf = async (
    ref: SlideImageRef | null,
    source: Media | null,
  ): Promise<SlideImage | null> =>
    ref === null || source === null
      ? null
      : { ...ref, bytes: await deps.storage.get(source.storagePath) };

  const renders: {
    variant: RenderedMediaVariant;
    input: string;
    html: () => Promise<string>;
  }[] = [];
  if (photo !== null && photoRef !== null) {
    renders.push({
      variant: "cover",
      input: renderInput(
        coverData(ctx.brief, photoRef, slideBrand(broker, logoRef)),
        deps.templates.version,
      ),
      html: async () => {
        const image = await bytesOf(photoRef, photo);
        if (image === null) throw new AppError("INTERNAL_ERROR", "Falta la foto de portada");
        return deps.templates.cover(
          coverData(ctx.brief, image, slideBrand(broker, await bytesOf(logoRef, logo))),
        );
      },
    });
  }
  renders.push({
    variant: "spec_sheet",
    input: renderInput(
      specSheetData(ctx.brief, broker, slideBrand(broker, logoRef)),
      deps.templates.version,
    ),
    html: async () =>
      deps.templates.specSheet(
        specSheetData(ctx.brief, broker, slideBrand(broker, await bytesOf(logoRef, logo))),
      ),
  });

  for (const render of renders) {
    const storagePath = renderPath(ids, render.variant, deps.sha256(render.input));
    const current = media.find(
      (item) => item.role === "rendered" && item.variant === render.variant,
    );
    if (current?.storagePath === storagePath) {
      counts.existing += 1;
      continue;
    }
    const size = render.variant === "cover" ? SLIDE_SIZES.cover : SLIDE_SIZES.specSheet;
    const image = await deps.renderer.render(
      await render.html(),
      { ...size, format: "jpeg" },
      signal,
    );
    await saveDerivative(state, () => deps.storage.put(storagePath, image.bytes, "image/jpeg"), {
      role: "rendered",
      variant: render.variant,
      parentMediaId: null,
      listingId: ids.listingId,
      brokerId: ids.brokerId,
      kind: "image",
      storagePath,
      mime: "image/jpeg",
      bytes: image.bytes.length,
      checksum: image.sha256,
      width: size.width,
      height: size.height,
      durationS: null,
    });
    counts.rendered += 1;
  }
  state.report.renders = counts;
}

/**
 * Etapa `reel`: con el primer video, si su clave cambió (el video, el texto o las versiones). Borra
 * el reel de otro video si quedó uno. Los avisos salen de la duración guardada (`reelWarnings`), y
 * un video de menos de 3 s no se vuelve a descargar.
 */
async function reelStage(state: Run): Promise<void> {
  const { deps, ids, ctx, signal } = state;
  const media = await deps.media.listByListing(ids.listingId);
  const first = videosOf(media)[0] ?? null;

  for (const stale of media.filter(
    (item) =>
      item.role === "processed" && item.variant === "ig_reel" && item.parentMediaId !== first?.id,
  )) {
    const path = await deps.media.deleteDerivative(stale.id);
    if (path !== null) {
      await deps.storage
        .delete(path)
        .catch((error: unknown) => deps.onCleanupFailed?.(path, error));
    }
  }

  if (first === null) {
    state.report.reel = "none";
    return;
  }
  for (const warning of reelWarnings(first.durationS))
    state.report.warnings.push(`Video 1: ${warning.message}`);
  const currentReel = variantOf(media, first.id, "ig_reel");
  if (first.durationS === null || first.durationS < REEL_MIN_DURATION_S) {
    state.report.reel = "skipped";
    await dropDerivative(state, currentReel);
    return;
  }

  const overlay = reelOverlayData(ctx.brief);
  const textKey = deps.sha256(
    reelTextInput(overlay, {
      templates: deps.templates.version,
      processor: deps.processor.version,
    }),
  );
  const storagePath = reelPath(ids, first.checksum, textKey);
  if (currentReel?.storagePath === storagePath) {
    state.report.reel = "existing";
    return;
  }

  try {
    const png = await deps.renderer.render(
      deps.templates.reelOverlay(overlay),
      { ...SLIDE_SIZES.reelOverlay, format: "png" },
      signal,
    );
    const stream = await deps.storage.getStream(
      first.storagePath,
      signal === undefined ? {} : { signal },
    );
    const result = await deps.processor.processVideo(
      stream,
      { reel: { overlayPng: png.bytes } },
      signal,
    );
    const reel = result.reel;
    if (reel === null) {
      state.report.reel = "skipped";
      await dropDerivative(state, currentReel);
      return;
    }
    await saveDerivative(
      state,
      () =>
        deps.storage.putStream(storagePath, reel.open(), {
          contentType: "video/mp4",
          contentLength: reel.size,
          sha256: reel.sha256,
        }),
      {
        role: "processed",
        variant: "ig_reel",
        parentMediaId: first.id,
        listingId: ids.listingId,
        brokerId: ids.brokerId,
        kind: "video",
        storagePath,
        mime: "video/mp4",
        bytes: reel.size,
        checksum: reel.sha256,
        width: reel.width,
        height: reel.height,
        durationS: reel.durationS,
      },
    );
    state.report.reel = "created";
  } catch (error) {
    // El video no se pudo armar como reel: aviso de ese video; la siguiente corrida lo reintenta.
    if (!isDecodeFailed(error)) throw error;
    // El reel anterior tiene el texto viejo (por ejemplo, otro precio): no queda vigente.
    await dropDerivative(state, currentReel);
    state.report.reel = "skipped";
    state.report.warnings.push(
      "Video 1: no se pudo armar el reel (formato no válido o archivo dañado)",
    );
  }
}

/**
 * Etapa `texts`: el borrador de la IA con el brief del contexto, el ensamblado de los tres canales
 * y su revisión (en el reporte, solo los códigos). Las filas se guardan con el paso a `succeeded`.
 */
async function textsStage(state: Run): Promise<NewContent[]> {
  const { deps, ctx, signal } = state;
  const now = deps.now ?? Date.now;
  const started = now();
  const result = await generateContentDraft(
    { llm: deps.llm },
    { brief: ctx.brief, ...(signal === undefined ? {} : { signal }) },
  );
  const assembled = assembleContents(ctx.brief, result.draft, ctx.contact);
  state.report.llm = {
    provider: deps.llm.name,
    model: result.model,
    promptVersion: CONTENT_PROMPT_VERSION,
    attempts: result.attempts,
    durationMs: Math.max(0, Math.round(now() - started)),
  };
  state.report.warnings.push(...result.draft.warnings);
  state.report.checks = Object.fromEntries(
    PLATFORMS.map((platform) => [
      platform,
      checkContent(platform, assembled[platform], ctx).map((check) => check.code),
    ]),
  );
  return PLATFORMS.map((platform) => ({
    platform,
    title: assembled[platform].title,
    body: assembled[platform].body,
    hashtags: assembled[platform].hashtags,
    llmProvider: deps.llm.name,
    llmModel: result.model,
    promptVersion: CONTENT_PROMPT_VERSION,
    rawOutput: result.draft,
  }));
}
