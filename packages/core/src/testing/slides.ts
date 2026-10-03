import { canonicalJson } from "../canonical-json.js";
import { AppError } from "../errors.js";
import {
  type CoverData,
  type HtmlRenderer,
  type ReelOverlayData,
  type RenderedImage,
  type SlideTemplates,
  type SpecSheetData,
  slideKeyInput,
} from "../ports/slide-templates.js";
import { fakeHash } from "./fake-hash.js";

export type SlideTemplateCall =
  | { kind: "cover"; data: unknown }
  | { kind: "specSheet"; data: unknown }
  | { kind: "reelOverlay"; data: unknown };

export type InMemorySlideTemplates = SlideTemplates & { calls: SlideTemplateCall[] };

/**
 * Plantillas para los tests de core: el "HTML" es la plantilla y sus datos sin bytes (como la clave
 * del render), así dos llamadas con los mismos datos dan el mismo HTML. Registra las llamadas.
 */
export function createInMemorySlideTemplates(version = "plantillas-test"): InMemorySlideTemplates {
  const calls: SlideTemplateCall[] = [];
  const html = (
    kind: SlideTemplateCall["kind"],
    data: CoverData | SpecSheetData | ReelOverlayData,
  ) => {
    const input = slideKeyInput(data);
    calls.push({ kind, data: input });
    return `<!-- ${kind} v${version} -->${canonicalJson(input)}`;
  };
  return {
    version,
    calls,
    cover: (data) => html("cover", data),
    specSheet: (data) => html("specSheet", data),
    reelOverlay: (data) => html("reelOverlay", data),
  };
}

export type HtmlRenderCall = {
  html: string;
  width: number;
  height: number;
  format: "jpeg" | "png";
};

export type InMemoryHtmlRenderer = HtmlRenderer & { calls: HtmlRenderCall[] };

/**
 * Renderizador para los tests de core: devuelve bytes deterministas por HTML y formato, registra
 * las llamadas, simula el corte con `signal` (`RENDER_ABORTED`) y un error guionado por HTML.
 */
export function createInMemoryHtmlRenderer(
  options: { fail?: (html: string) => AppError | undefined } = {},
): InMemoryHtmlRenderer {
  const calls: HtmlRenderCall[] = [];
  return {
    calls,
    async render(html, { width, height, format }, signal): Promise<RenderedImage> {
      if (signal?.aborted) {
        throw new AppError("RENDER_ABORTED", "Se cortó el render de la imagen", {
          retriable: true,
        });
      }
      calls.push({ html, width, height, format });
      const error = options.fail?.(html);
      if (error !== undefined) throw error;
      const text = `${format}:${width}x${height}:${html}`;
      const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
      return { bytes, sha256: fakeHash(text) };
    },
  };
}
