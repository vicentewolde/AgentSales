import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSlideTemplates } from "@agentsales/templates";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { createHtmlRenderer } from "../src/index.js";
import { errorOf } from "./images.js";

// Necesita el Chromium de Playwright (la CI lo instala; en local, `doctor` dice cómo).

const renderer = createHtmlRenderer();
afterAll(async () => {
  await renderer.close();
});

const page = (body: string, css = "") =>
  `<!doctype html><html><head><style>*{margin:0}html,body{width:100%;height:100%}${css}</style></head><body>${body}</body></html>`;

describe("createHtmlRenderer", () => {
  it("una portada: JPEG de 1080×1350 con su sha256", async () => {
    const html = page("<div></div>", "body{background:#1F4E79}");
    const result = await renderer.render(html, { width: 1080, height: 1350, format: "jpeg" });
    const metadata = await sharp(result.bytes).metadata();

    expect([metadata.format, metadata.width, metadata.height]).toEqual(["jpeg", 1080, 1350]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [r = 0, g = 0, b = 0] = await sharp(result.bytes)
      .extract({ left: 540, top: 675, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([Math.abs(r - 0x1f) < 6, Math.abs(g - 0x4e) < 6, Math.abs(b - 0x79) < 6]).toEqual([
      true,
      true,
      true,
    ]);
  }, 60_000);

  it("el texto del reel: PNG transparente de 1080×1920, opaco donde hay contenido", async () => {
    const html = page(
      '<div style="position:absolute;top:0;left:0;width:1080px;height:300px;background:#00FF00"></div>',
      "html,body{background:transparent}",
    );
    const result = await renderer.render(html, { width: 1080, height: 1920, format: "png" });
    const image = sharp(result.bytes);
    const metadata = await image.metadata();
    const alphaAt = async (x: number, y: number) => {
      const data = await sharp(result.bytes)
        .ensureAlpha()
        .extract({ left: x, top: y, width: 1, height: 1 })
        .raw()
        .toBuffer();
      return data[3];
    };

    expect([metadata.format, metadata.width, metadata.height, metadata.hasAlpha]).toEqual([
      "png",
      1080,
      1920,
      true,
    ]);
    expect(await alphaAt(540, 100)).toBe(255);
    expect(await alphaAt(540, 1500)).toBe(0);
  }, 60_000);

  it("una plantilla que pide una URL externa no la carga: ninguna petición sale", async () => {
    let requests = 0;
    const server = createServer((_, response) => {
      requests += 1;
      response.end("x");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const html = page(
      `<img src="${url}/foto.png"><link rel="stylesheet" href="${url}/estilo.css">`,
      `@font-face{font-family:X;src:url(${url}/fuente.woff2)}body{font-family:X;background:url(${url}/fondo.png)}`,
    );

    try {
      const result = await renderer.render(html, { width: 400, height: 300, format: "jpeg" });
      expect(result.bytes.length).toBeGreaterThan(0);
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  }, 60_000);

  it("dibuja las plantillas de verdad, con Inter y los datos", async () => {
    const templates = createSlideTemplates();
    const photo = await sharp({
      create: { width: 1080, height: 1350, channels: 3, background: { r: 120, g: 140, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    const html = templates.cover({
      operation: "sale",
      propertyType: "Departamento",
      comuna: "Ñuñoa",
      price: "UF 5.800",
      facts: [{ icon: "area", text: "72,5 m²" }],
      photo: { bytes: new Uint8Array(photo), mime: "image/jpeg", sha256: "x" },
      brand: {
        brandName: "Inventada",
        primaryColor: "#1F4E79",
        secondaryColor: "#F2A900",
        logo: null,
      },
    });

    const result = await renderer.render(html, { width: 1080, height: 1350, format: "jpeg" });
    const metadata = await sharp(result.bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual([1080, 1350]);
  }, 60_000);

  it("con el signal ya disparado no dibuja: RENDER_ABORTED, reintentable", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(
      renderer.render(page(""), { width: 100, height: 100, format: "png" }, controller.signal),
    );
    expect([error.code, error.retriable]).toEqual(["RENDER_ABORTED", true]);
  });

  it("un tope de tiempo mínimo: RENDER_TIMEOUT, reintentable", async () => {
    const quick = createHtmlRenderer({ timeoutMs: 1 });
    try {
      const error = await errorOf(
        quick.render(page("<div></div>"), { width: 1080, height: 1350, format: "jpeg" }),
      );
      expect([error.code, error.retriable]).toEqual(["RENDER_TIMEOUT", true]);
    } finally {
      await quick.close();
    }
  }, 60_000);

  it("sin Chromium → RENDER_BROWSER_NOT_INSTALLED, con el comando para instalarlo", async () => {
    const missing = createHtmlRenderer({ executablePath: "/no/existe/chromium" });
    const error = await errorOf(missing.render(page(""), { width: 10, height: 10, format: "png" }));
    expect([error.code, error.retriable]).toEqual(["RENDER_BROWSER_NOT_INSTALLED", false]);
    expect(error.message).toContain("playwright install chromium");
    expect(error.message).not.toContain("/no/existe");
    await missing.close();
  });

  it("después de close() se puede volver a dibujar (abre otro Chromium)", async () => {
    const own = createHtmlRenderer();
    await own.render(page(""), { width: 10, height: 10, format: "png" });
    await own.close();
    const again = await own.render(page(""), { width: 10, height: 10, format: "png" });
    expect(again.bytes.length).toBeGreaterThan(0);
    await own.close();
  }, 60_000);
});
