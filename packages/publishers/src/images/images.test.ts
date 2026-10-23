import { imageAiNotCharged, isAppError } from "@agentsales/core";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createGeminiImages, GEMINI_API_URL } from "./gemini.js";
import { createPixabayStock, PIXABAY_API_URL } from "./pixabay.js";

// F9.5-T25 (ADR-0038): la biblioteca de Pixabay y la IA de Google contra msw, sin red. Ningún error
// deja ver la clave ni la indicación.

const KEY = "clave-pixabay-secreta-123";
const GEMINI_KEY = "clave-gemini-secreta-456";
const { server, recorded } = usePlatformServer();

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const CDN = "https://cdn.pixabay.com/photo/2026/10/01/casa_1280.jpg";

const hit = (id: number, tags: string, large = CDN) => ({
  id,
  pageURL: `https://pixabay.com/photos/casa-${id}/`,
  type: "photo",
  tags,
  previewURL: `https://cdn.pixabay.com/photo/${id}_150.jpg`,
  webformatURL: `https://pixabay.com/get/${id}_640.jpg`,
  largeImageURL: large,
  imageWidth: 3000,
  imageHeight: 4000,
  user: "autora",
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(errorText(error)).not.toContain(KEY);
    expect(errorText(error)).not.toContain(GEMINI_KEY);
    return isAppError(error) ? error.code : String(error);
  }
  return "OK";
};

describe("createPixabayStock", () => {
  it("busca fotos verticales en español con safesearch y guarda 24 h la búsqueda", async () => {
    let clock = 0;
    server.use(
      http.get(PIXABAY_API_URL, () =>
        HttpResponse.json({
          total: 2,
          totalHits: 2,
          hits: [hit(1, "casa, living"), hit(2, "mujer")],
        }),
      ),
    );
    const stock = createPixabayStock({ apiKey: KEY, now: () => clock });
    const photos = await stock.search({ text: " living luminoso ", perPage: 12 });
    expect(photos).toEqual([
      {
        id: "1",
        previewUrl: "https://pixabay.com/get/1_640.jpg",
        pageUrl: "https://pixabay.com/photos/casa-1/",
        tags: ["casa", "living"],
        width: 3000,
        height: 4000,
        author: "autora",
      },
      expect.objectContaining({ id: "2", tags: ["mujer"] }),
    ]);
    const [request] = await recorded();
    const params = request?.url.searchParams;
    expect(params?.get("key")).toBe(KEY);
    expect(params?.get("q")).toBe("living luminoso");
    expect(
      ["lang", "image_type", "orientation", "safesearch", "per_page"].map((n) => params?.get(n)),
    ).toEqual(["es", "photo", "vertical", "true", "12"]);

    await stock.search({ text: "Living luminoso", perPage: 12 });
    expect(await recorded()).toHaveLength(1);
    clock = 24 * 60 * 60 * 1000;
    await stock.search({ text: "living luminoso", perPage: 12 });
    expect(await recorded()).toHaveLength(2);
  });

  it("descarga la foto elegida desde el CDN de Pixabay y revisa el tipo", async () => {
    server.use(
      http.get(PIXABAY_API_URL, () => HttpResponse.json({ totalHits: 1, hits: [hit(7, "casa")] })),
      http.get(CDN, () =>
        HttpResponse.arrayBuffer(JPEG.buffer, { headers: { "content-type": "image/jpeg" } }),
      ),
    );
    const stock = createPixabayStock({ apiKey: KEY });
    // Sin buscar antes: la pide por su id.
    const file = await stock.download("7");
    expect(file).toEqual({ bytes: JPEG, mime: "image/jpeg" });
    const requests = await recorded();
    expect(
      requests.map((request) => request.url.searchParams.get("id") ?? request.url.host),
    ).toEqual(["7", "cdn.pixabay.com"]);
  });

  it("no descarga de otro host, ni algo que no es imagen, ni lo que pasa del tope", async () => {
    server.use(
      http.get(PIXABAY_API_URL, ({ request }) => {
        const id = new URL(request.url).searchParams.get("id");
        return HttpResponse.json({
          totalHits: 1,
          hits: [hit(Number(id), "casa", id === "1" ? "https://malo.example/x.jpg" : CDN)],
        });
      }),
    );
    const stock = createPixabayStock({ apiKey: KEY, maxDownloadBytes: 4 });
    expect(await codeOf(stock.download("1"))).toBe("STOCK_DOWNLOAD_INVALID");
    server.use(
      http.get(CDN, () =>
        HttpResponse.text("<html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    expect(await codeOf(stock.download("2"))).toBe("STOCK_DOWNLOAD_INVALID");
    server.use(
      http.get(CDN, () =>
        HttpResponse.arrayBuffer(JPEG.buffer, { headers: { "content-type": "image/jpeg" } }),
      ),
    );
    expect(await codeOf(stock.download("3"))).toBe("STOCK_DOWNLOAD_INVALID");
    expect(await codeOf(stock.download("../etc"))).toBe("STOCK_PHOTO_NOT_FOUND");
  });

  it("dice en simple los errores: 429, clave mala, caída y una foto que no existe", async () => {
    const stock = createPixabayStock({ apiKey: KEY });
    server.use(http.get(PIXABAY_API_URL, () => new HttpResponse("Too Many", { status: 429 })));
    const limited = stock.search({ text: "a", perPage: 12 });
    expect(await codeOf(limited)).toBe("STOCK_RATE_LIMITED");
    await limited.catch((error: Error) =>
      expect(error.message).toBe(
        "La biblioteca de fotos recibió demasiadas búsquedas: espera un minuto y vuelve a intentarlo",
      ),
    );
    server.use(
      http.get(
        PIXABAY_API_URL,
        () => new HttpResponse("[ERROR 400] Invalid or missing API key", { status: 400 }),
      ),
    );
    expect(await codeOf(stock.search({ text: "b", perPage: 12 }))).toBe("STOCK_AUTH_INVALID");
    server.use(http.get(PIXABAY_API_URL, () => new HttpResponse(null, { status: 503 })));
    expect(await codeOf(stock.search({ text: "c", perPage: 12 }))).toBe("STOCK_UNAVAILABLE");
    server.use(http.get(PIXABAY_API_URL, () => HttpResponse.error()));
    expect(await codeOf(stock.search({ text: "d", perPage: 12 }))).toBe("STOCK_UNAVAILABLE");
    server.use(http.get(PIXABAY_API_URL, () => HttpResponse.json({ hits: "no" })));
    expect(await codeOf(stock.search({ text: "e", perPage: 12 }))).toBe(
      "STOCK_UNEXPECTED_RESPONSE",
    );
    server.use(http.get(PIXABAY_API_URL, () => HttpResponse.json({ totalHits: 0, hits: [] })));
    expect(await codeOf(stock.download("99"))).toBe("STOCK_PHOTO_NOT_FOUND");
  });

  it("descarta las fotos con miniatura, página o archivo fuera de Pixabay (otro host, http, puerto o credenciales)", async () => {
    server.use(
      http.get(PIXABAY_API_URL, () =>
        HttpResponse.json({
          totalHits: 5,
          hits: [
            hit(1, "casa"),
            { ...hit(2, "casa"), webformatURL: "https://malo.example/2.jpg" },
            { ...hit(3, "casa"), pageURL: "http://pixabay.com/photos/3/" },
            { ...hit(4, "casa"), webformatURL: "https://pixabay.com:8443/get/4.jpg" },
            { ...hit(5, "casa"), largeImageURL: "https://usuario:clave@cdn.pixabay.com/5.jpg" },
          ],
        }),
      ),
    );
    const photos = await createPixabayStock({ apiKey: KEY }).search({ text: "casa", perPage: 12 });
    expect(photos.map((photo) => photo.id)).toEqual(["1"]);
  });

  it("una redirección no se sigue: ni en la búsqueda ni en la descarga", async () => {
    const stock = createPixabayStock({ apiKey: KEY });
    server.use(
      http.get(PIXABAY_API_URL, () => HttpResponse.json({ totalHits: 1, hits: [hit(8, "casa")] })),
      http.get(
        CDN,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://malo.example/x.jpg" },
          }),
      ),
      http.get("https://malo.example/x.jpg", () =>
        HttpResponse.arrayBuffer(JPEG.buffer, { headers: { "content-type": "image/jpeg" } }),
      ),
    );
    expect(await codeOf(stock.download("8"))).toBe("STOCK_UNAVAILABLE");
    server.use(
      http.get(
        PIXABAY_API_URL,
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: { location: "https://malo.example/api" },
          }),
      ),
    );
    expect(await codeOf(stock.search({ text: "otra", perPage: 12 }))).toBe("STOCK_UNAVAILABLE");
    expect((await recorded()).some((request) => request.url.host === "malo.example")).toBe(false);
  });

  it("sin Content-Length, corta la descarga apenas pasa el tope", async () => {
    let sent = 0;
    server.use(
      http.get(PIXABAY_API_URL, () => HttpResponse.json({ totalHits: 1, hits: [hit(9, "casa")] })),
      http.get(CDN, () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 100) controller.close();
            else controller.enqueue(new Uint8Array(1024).fill(0xff));
          },
        });
        return new HttpResponse(body, { headers: { "content-type": "image/jpeg" } });
      }),
    );
    const stock = createPixabayStock({ apiKey: KEY, maxDownloadBytes: 4096 });
    expect(await codeOf(stock.download("9"))).toBe("STOCK_DOWNLOAD_INVALID");
    expect(sent).toBeLessThan(100);
  });

  it("si fetch falla, la clave no queda en el mensaje ni en los detalles", async () => {
    server.use(http.get(PIXABAY_API_URL, () => HttpResponse.error()));
    const failing = createPixabayStock({ apiKey: KEY }).search({ text: "casa", perPage: 12 });
    const error = await failing.catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("STOCK_UNAVAILABLE");
    expect(errorText(error)).not.toContain(KEY);
    expect(JSON.stringify(isAppError(error) ? (error.details ?? {}) : {})).not.toContain(KEY);
  });
});

describe("createGeminiImages", () => {
  const ENDPOINT = `${GEMINI_API_URL}/nano-test:generateContent`;
  const image = (data: string, mimeType = "image/png") => ({
    candidates: [
      {
        content: { parts: [{ text: "listo" }, { inlineData: { mimeType, data } }] },
        finishReason: "STOP",
      },
    ],
    modelVersion: "nano-test-001",
  });

  it("pide una imagen con la proporción y 1K, con la clave en la cabecera, y la decodifica", async () => {
    let apiKeyHeader: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        apiKeyHeader = request.headers.get("x-goog-api-key");
        return HttpResponse.json(image(Buffer.from(JPEG).toString("base64"), "image/jpeg"));
      }),
    );
    const ai = createGeminiImages({ apiKey: GEMINI_KEY, model: "nano-test" });
    const out = await ai.generate({ prompt: "Un living luminoso", format: "4:5" });
    expect(out).toEqual({ bytes: JPEG, mime: "image/jpeg", model: "nano-test-001" });
    expect(apiKeyHeader).toBe(GEMINI_KEY);
    const [request] = await recorded();
    expect(request?.url.search).toBe("");
    expect(request?.json).toEqual({
      contents: [{ role: "user", parts: [{ text: "Un living luminoso" }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "4:5", imageSize: "1K" },
      },
    });
  });

  it("un bloqueo, una respuesta sin imagen y los errores HTTP, en simple y sin la indicación", async () => {
    const ai = createGeminiImages({ apiKey: GEMINI_KEY, model: "nano-test", timeoutMs: 200 });
    const run = () => ai.generate({ prompt: "indicación privada", format: "9:16" });
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ promptFeedback: { blockReason: "SAFETY" } })),
    );
    expect(await codeOf(run())).toBe("IMAGE_AI_BLOCKED");
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({
          candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }],
        }),
      ),
    );
    expect(await codeOf(run())).toBe("IMAGE_AI_BLOCKED");
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({
          candidates: [{ content: { parts: [{ text: "no" }] }, finishReason: "STOP" }],
        }),
      ),
    );
    expect(await codeOf(run())).toBe("IMAGE_AI_UNEXPECTED_RESPONSE");
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 429 })));
    expect(await codeOf(run())).toBe("IMAGE_AI_RATE_LIMITED");
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json(
          {
            error: { status: "INVALID_ARGUMENT", message: "API key not valid. indicación privada" },
          },
          { status: 400 },
        ),
      ),
    );
    expect(await codeOf(run())).toBe("IMAGE_AI_AUTH_INVALID");
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({ error: { status: "NOT_FOUND", message: "modelo" } }, { status: 404 }),
      ),
    );
    const rejected = run();
    expect(await codeOf(rejected)).toBe("IMAGE_AI_REQUEST_REJECTED");
    await rejected.catch((error: Error) =>
      expect(errorText(error)).not.toContain("indicación privada"),
    );
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 500 })));
    expect(await codeOf(run())).toBe("IMAGE_AI_UNAVAILABLE");
    server.use(
      http.post(ENDPOINT, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const slow = run();
    expect(await codeOf(slow)).toBe("IMAGE_AI_UNAVAILABLE");
    await slow.catch((error) => expect(isAppError(error) && error.retriable).toBe(true));
  });

  it("una redirección no se sigue y cuenta como caída (cobrada); un 429 sale marcado sin cobrar", async () => {
    const ai = createGeminiImages({ apiKey: GEMINI_KEY, model: "nano-test" });
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(null, { status: 307, headers: { location: "https://malo.example/x" } }),
      ),
    );
    const redirected = await ai.generate({ prompt: "x", format: "4:5" }).catch((e: unknown) => e);
    expect(isAppError(redirected) && redirected.code).toBe("IMAGE_AI_UNAVAILABLE");
    expect(imageAiNotCharged(redirected)).toBe(false);
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 429 })));
    const limited = await ai.generate({ prompt: "x", format: "4:5" }).catch((e: unknown) => e);
    expect(imageAiNotCharged(limited)).toBe(true);
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    const offline = await ai.generate({ prompt: "x", format: "4:5" }).catch((e: unknown) => e);
    expect(errorText(offline)).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(isAppError(offline) ? (offline.details ?? {}) : {})).not.toContain(
      GEMINI_KEY,
    );
  });
});
