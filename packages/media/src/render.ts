import { createHash } from "node:crypto";
import { type AbortSignalLike, AppError, type HtmlRenderer } from "@agentsales/core";
import { type Browser, chromium } from "playwright";
import { CHROMIUM_INSTALL_HINT } from "./tools.js";

/** Tope de cada render (spec F2 §4.2). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Calidad de la portada y la ficha (Instagram solo acepta JPEG). */
const JPEG_QUALITY = 90;

export type HtmlRendererOptions = {
  /** Tope de cada render, en milisegundos (30 s por defecto). */
  timeoutMs?: number;
  /** Otro Chromium (por defecto, el que pide la versión de Playwright instalada). */
  executablePath?: string;
};

/** El renderizador con su cierre: el worker llama a `close()` al apagarse. */
export type ClosableHtmlRenderer = HtmlRenderer & { close(): Promise<void> };

const notInstalled = (cause: unknown) =>
  new AppError(
    "RENDER_BROWSER_NOT_INSTALLED",
    `No se encontró Chromium. ${CHROMIUM_INSTALL_HINT}`,
    {
      cause: { message: cause instanceof Error ? cause.message.split("\n")[0] : String(cause) },
    },
  );

const renderAborted = () =>
  new AppError("RENDER_ABORTED", "Se cortó el render de la imagen", { retriable: true });

/**
 * El renderizador de HTML con Playwright (puerto `HtmlRenderer`, spec F2 §4.2). Un solo Chromium por
 * proceso, que se abre al primer render y se cierra con `close()`. Cada render usa un contexto
 * nuevo que **bloquea toda la red** (solo `data:`, que no pasa por la red), sin JavaScript de la
 * página, y espera a que carguen las fuentes incrustadas.
 */
export function createHtmlRenderer(options: HtmlRendererOptions = {}): ClosableHtmlRenderer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let browser: Promise<Browser> | null = null;

  const launch = () => {
    if (browser === null) {
      const started = chromium
        .launch({
          headless: true,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
        })
        .catch((error: unknown) => {
          // Un Chromium que no está o no se puede ejecutar.
          throw notInstalled(error);
        });
      browser = started;
      started.catch(() => {
        if (browser === started) browser = null;
      });
    }
    return browser;
  };

  return {
    async render(html, { width, height, format }, signal?: AbortSignalLike) {
      if (signal?.aborted) throw renderAborted();
      const context = await (await launch()).newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        offline: true,
      });
      const onAbort = () => {
        void context.close();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Ninguna petición sale: ni a internet ni a la red local.
        await context.route("**/*", (route) => route.abort("blockedbyclient"));
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
        // Las fuentes son `data:`, pero se decodifican en paralelo: se espera a que estén listas.
        await page.evaluate("document.fonts.ready.then(() => true)");
        const bytes = await page.screenshot({
          type: format,
          ...(format === "jpeg" ? { quality: JPEG_QUALITY } : { omitBackground: true }),
          clip: { x: 0, y: 0, width, height },
          timeout: timeoutMs,
          animations: "disabled",
        });
        const output = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { bytes: output, sha256: createHash("sha256").update(output).digest("hex") };
      } catch (error) {
        if (signal?.aborted) throw renderAborted();
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new AppError("RENDER_TIMEOUT", "El render de la imagen tardó demasiado", {
            retriable: true,
          });
        }
        throw new AppError("RENDER_FAILED", "No se pudo dibujar la imagen", {
          cause: { message: error instanceof Error ? error.message.split("\n")[0] : String(error) },
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await context.close().catch(() => undefined);
      }
    },
    async close() {
      const current = browser;
      browser = null;
      if (current !== null) await (await current.catch(() => null))?.close();
    },
  };
}
