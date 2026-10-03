import { createHash } from "node:crypto";
import { type AbortSignalLike, AppError, type HtmlRenderer } from "@agentsales/core";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { CHROMIUM_INSTALL_HINT } from "./tools.js";

/** Tope de cada render, de punta a punta (spec F2 §4.2). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Calidad de la portada y la ficha (Instagram solo acepta JPEG). */
const JPEG_QUALITY = 90;

export type HtmlRendererOptions = {
  /** Tope de cada render, en milisegundos (30 s por defecto). */
  timeoutMs?: number;
  /** Otro Chromium (por defecto, el que pide la versión de Playwright instalada). */
  executablePath?: string;
};

/**
 * El renderizador con su cierre. El worker crea uno por proceso y, al apagarse, primero dispara el
 * `signal` de los renders en curso y después llama a `close()`.
 */
export type ClosableHtmlRenderer = HtmlRenderer & { close(): Promise<void> };

/** La primera línea de un error de Playwright, sin rutas (pueden traer el usuario del sistema). */
const withoutPaths = (error: unknown) =>
  (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)).replace(
    /(?:[A-Za-z]:)?[/\\][^\s'"]+/g,
    "<ruta>",
  );

const renderAborted = () =>
  new AppError("RENDER_ABORTED", "Se cortó el render de la imagen", { retriable: true });

const renderTimeout = () =>
  new AppError("RENDER_TIMEOUT", "El render de la imagen tardó demasiado", { retriable: true });

/** Chromium no se pudo abrir: si no está, `RENDER_BROWSER_NOT_INSTALLED`; si no, `RENDER_FAILED`. */
function launchFailed(error: unknown): AppError {
  const message = withoutPaths(error);
  if (/doesn't exist|does not exist|ENOENT|install/i.test(message)) {
    return new AppError(
      "RENDER_BROWSER_NOT_INSTALLED",
      `No se encontró Chromium. ${CHROMIUM_INSTALL_HINT}`,
      {
        cause: { message },
      },
    );
  }
  return new AppError("RENDER_FAILED", "No se pudo abrir Chromium para dibujar la imagen", {
    cause: { message },
  });
}

/**
 * El renderizador de HTML con Playwright (puerto `HtmlRenderer`, spec F2 §4.2). Un solo Chromium por
 * proceso, que se abre al primer render, se vuelve a abrir si se cae y se cierra con `close()`. Cada
 * render usa un contexto nuevo que **bloquea toda la red** (solo `data:`, que no pasa por la red),
 * sin JavaScript de la página, y espera a que carguen las fuentes incrustadas. Un solo plazo cubre
 * todo el render: si vence, se cierra el contexto.
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
          throw launchFailed(error);
        });
      browser = started;
      started.then(
        // Si el navegador se cae, el próximo render abre otro.
        (opened) =>
          opened.on("disconnected", () => {
            if (browser === started) browser = null;
          }),
        () => {
          if (browser === started) browser = null;
        },
      );
    }
    return browser;
  };

  return {
    async render(html, { width, height, format }, signal?: AbortSignalLike) {
      if (signal?.aborted) throw renderAborted();
      let context: BrowserContext | null = null;
      let stopped: "timeout" | "abort" | null = null;
      // Algunas operaciones de Playwright no se cortan al cerrar el contexto (abrir la página): el
      // render compite contra el corte, y la limpieza sigue aparte.
      let interrupt: (reason: Error) => void = () => undefined;
      const interrupted = new Promise<never>((_, reject) => {
        interrupt = reject;
      });
      interrupted.catch(() => undefined);
      const stop = (reason: "timeout" | "abort") => {
        stopped ??= reason;
        interrupt(new Error(reason));
        void context?.close().catch(() => undefined);
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const onAbort = () => stop("abort");
      signal?.addEventListener("abort", onAbort, { once: true });

      const work = (async () => {
        const opened = await launch();
        const created = await opened.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
          javaScriptEnabled: false,
          offline: true,
        });
        context = created;
        // Un corte o un plazo vencido mientras se abría el contexto.
        if (stopped !== null) {
          await created.close().catch(() => undefined);
          throw new Error("detenido");
        }
        // Ninguna petición sale: ni a internet ni a la red local.
        await created.route("**/*", (route) => route.abort("blockedbyclient"));
        const page = await created.newPage();
        await page.setContent(html, { waitUntil: "load" });
        // Las fuentes son `data:`, pero se decodifican en paralelo: se espera a que estén listas.
        await page.evaluate("document.fonts.ready.then(() => true)");
        const bytes = await page.screenshot({
          type: format,
          ...(format === "jpeg" ? { quality: JPEG_QUALITY } : { omitBackground: true }),
          clip: { x: 0, y: 0, width, height },
          animations: "disabled",
        });
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      })();
      work.catch(() => undefined);

      try {
        const output = await Promise.race([work, interrupted]);
        return { bytes: output, sha256: createHash("sha256").update(output).digest("hex") };
      } catch (error) {
        if (stopped === "abort" || signal?.aborted) throw renderAborted();
        if (stopped === "timeout") throw renderTimeout();
        if (error instanceof AppError) throw error;
        throw new AppError("RENDER_FAILED", "No se pudo dibujar la imagen", {
          cause: { message: withoutPaths(error) },
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        // El contexto se cierra en segundo plano: un cierre lento no demora la respuesta.
        // (TypeScript no ve la asignación dentro de `work`.)
        const current = context as BrowserContext | null;
        void current?.close().catch(() => undefined);
      }
    },
    async close() {
      const current = browser;
      browser = null;
      if (current !== null) await (await current.catch(() => null))?.close();
    },
  };
}
