import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibrePictures } from "./pictures.js";

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const UPLOAD_URL = "https://api.mercadolibre.com/pictures/items/upload";
/** Unos bytes que empiezan como un JPEG (no hace falta una imagen real: msw no la mira). */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const FILE = { bytes: JPEG, mime: "image/jpeg", filename: "foto-1.jpg" };

const { server, requests } = usePlatformServer();
const pictures = createMercadoLibrePictures();

/** La respuesta de la doc de imágenes (con los dominios nuevos `D_NQ_NP_`). */
const uploadBody = {
  id: "123-MLC456_102026",
  variations: [
    {
      size: "1920x1440",
      url: "http://http2.mlstatic.com/D_NQ_NP_123-MLC456_102026-F.jpg",
      secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLC456_102026-F.jpg",
    },
  ],
};

describe("createMercadoLibrePictures", () => {
  /** Responde como la doc y guarda lo que llegó: el `multipart` se lee dentro del handler. */
  const captureUpload = () => {
    const seen: { contentType: string | null; form: FormData | null } = {
      contentType: null,
      form: null,
    };
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        seen.contentType = request.headers.get("content-type");
        seen.form = await request.formData();
        return HttpResponse.json(uploadBody, { status: 201 });
      }),
    );
    return seen;
  };

  it("upload: multipart con el campo file, el tipo, el nombre y los bytes; devuelve el id", async () => {
    const seen = captureUpload();

    await expect(pictures.upload(ACCESS, FILE)).resolves.toEqual({ id: "123-MLC456_102026" });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(request?.url.toString()).toBe(UPLOAD_URL);
    // `fetch` arma el Content-Type con su separador: el cliente no lo fija a mano.
    expect(seen.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect([...(seen.form?.keys() ?? [])]).toEqual(["file"]);
    const file = seen.form?.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("foto-1.jpg");
    expect((file as File).type).toBe("image/jpeg");
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(JPEG);
  });

  it("los bytes se copian: una vista sobre un buffer más grande no manda lo que sobra", async () => {
    const seen = captureUpload();
    const shared = new Uint8Array([9, 9, ...JPEG, 9, 9]);

    await pictures.upload(ACCESS, { ...FILE, bytes: shared.subarray(2, 2 + JPEG.length) });

    const file = seen.form?.get("file") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
  });

  it("el 400 por límite de subidas por minuto (sin causas) es ML_RATE_LIMITED, reintentable", async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json(
          { message: "Bad_request", error: "bad_request", status: 400, cause: [] },
          { status: 400 },
        ),
      ),
    );

    const error = await pictures.upload(ACCESS, FILE).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ML_RATE_LIMITED",
      retriable: true,
      details: { httpStatus: 400, error: "bad_request" },
    });
    expect((error as Error).message).toContain("por minuto");
    expect(errorText(error)).not.toContain(ACCESS);
  });

  it("un 400 sin cuerpo JSON también es el límite (la doc no da su forma)", async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.text("Bad_request", { status: 400 })));

    await expect(pictures.upload(ACCESS, FILE)).rejects.toMatchObject({ code: "ML_RATE_LIMITED" });
  });

  it("un 400 con causas que bloquean es un rechazo de la foto, no el límite", async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json(
          {
            error: "validation_error",
            status: 400,
            cause: [{ cause_id: 3703, type: "error", code: "item.pictures.invalid_size" }],
          },
          { status: 400 },
        ),
      ),
    );

    await expect(pictures.upload(ACCESS, FILE)).rejects.toMatchObject({
      code: "ML_ITEM_REJECTED",
      retriable: false,
      message: expect.stringContaining("demasiado chica"),
    });
  });

  it.each([
    [401, "ML_AUTH_INVALID", false],
    [429, "ML_RATE_LIMITED", true],
    [503, "ML_UNAVAILABLE", true],
  ] as const)(
    "los demás errores siguen la tabla general: %i es %s",
    async (status, code, retriable) => {
      server.use(http.post(UPLOAD_URL, () => HttpResponse.json({}, { status })));

      await expect(pictures.upload(ACCESS, FILE)).rejects.toMatchObject({ code, retriable });
    },
  );

  it("una respuesta sin id es ML_UNEXPECTED_RESPONSE", async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.json({ variations: [] })));

    await expect(pictures.upload(ACCESS, FILE)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "uploadPicture" },
    });
  });
});
