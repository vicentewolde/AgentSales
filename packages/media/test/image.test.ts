import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAppError } from "@agentsales/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMediaProcessor, MEDIA_PIPELINE_VERSION } from "../src/index.js";
import {
  FFMPEG,
  FFPROBE,
  fakeFfmpeg,
  HEIC_FIXTURE,
  isRed,
  pixel,
  syntheticPhoto,
} from "./images.js";

const ALL = ["thumb", "ig_4x5", "pi_4x3"] as const;

const HEIC_PATH = fileURLToPath(HEIC_FIXTURE);

let workDir: string;
const tempDirs: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
beforeAll(async () => {
  workDir = await tempDir("agentsales-media-test-");
});
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const processor = (overrides: { ffmpegPath?: string } = {}) =>
  createMediaProcessor({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, workDir, ...overrides });

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isAppError(error)) throw new Error(`se esperaba un AppError: ${String(error)}`);
  return error;
}

describe("processImage: variantes", () => {
  it("mide el original y arma cada variante con su tamaño, proporción y sha256", async () => {
    const input = await syntheticPhoto(2000, 1500);
    const result = await processor().processImage(input, { mime: "image/jpeg", variants: ALL });

    expect(result.measurements).toEqual({ width: 2000, height: 1500, durationS: null });
    expect(
      result.outputs.map(({ variant, width, height, mime }) => ({ variant, width, height, mime })),
    ).toEqual([
      { variant: "thumb", width: 800, height: 600, mime: "image/jpeg" },
      { variant: "ig_4x5", width: 1080, height: 1350, mime: "image/jpeg" },
      { variant: "pi_4x3", width: 1600, height: 1200, mime: "image/jpeg" },
    ]);
    for (const output of result.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual([
        "jpeg",
        output.width,
        output.height,
      ]);
      expect(output.sha256).toBe(createHash("sha256").update(output.bytes).digest("hex"));
    }
  });

  it("devuelve solo las variantes pedidas, en ese orden, y una PNG también sale en JPEG", async () => {
    const input = await syntheticPhoto(1600, 1600, { format: "png" });
    const result = await processor().processImage(input, {
      mime: "image/png",
      variants: ["pi_4x3", "thumb"],
    });

    expect(result.outputs.map((output) => [output.variant, output.width, output.height])).toEqual([
      ["pi_4x3", 1600, 1200],
      ["thumb", 800, 800],
    ]);
    expect((await sharp(result.outputs[0]?.bytes).metadata()).format).toBe("jpeg");
  });

  it("aplica la rotación del EXIF: una foto vertical del celular sale vertical", async () => {
    // Guardada en 1600×1200 con Orientation = 6: derecha mide 1200×1600, y el bloque rojo de la
    // esquina superior izquierda queda arriba a la derecha.
    const input = await syntheticPhoto(1600, 1200, { orientation: 6 });
    const result = await processor().processImage(input, {
      mime: "image/jpeg",
      variants: ["thumb"],
    });
    const thumb = result.outputs[0];
    if (thumb === undefined) throw new Error("falta el thumb");

    expect(result.measurements).toEqual({ width: 1200, height: 1600, durationS: null });
    expect([thumb.width, thumb.height]).toEqual([600, 800]);
    expect(isRed(await pixel(thumb.bytes, 590, 10))).toBe(true);
    expect(isRed(await pixel(thumb.bytes, 10, 10))).toBe(false);
  });

  it("borra los metadatos: ni EXIF, ni GPS, ni orientación, y en sRGB", async () => {
    const input = await syntheticPhoto(2000, 1500, { gps: true, orientation: 1, p3: true });
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();

    const result = await processor().processImage(input, { mime: "image/jpeg", variants: ALL });

    for (const output of result.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata.exif, output.variant).toBeUndefined();
      expect(metadata.xmp, output.variant).toBeUndefined();
      expect(metadata.orientation, output.variant).toBeUndefined();
      expect(metadata.space, output.variant).toBe("srgb");
      expect(metadata.icc, output.variant).toBeUndefined();
      expect(metadata.iptc, output.variant).toBeUndefined();
      expect(metadata.tifftagPhotoshop, output.variant).toBeUndefined();
      // Ni rastro de la ubicación ni del equipo en los bytes.
      const text = Buffer.from(output.bytes).toString("latin1");
      expect(text).not.toContain("Fabricante Inventado");
      expect(text).not.toContain("Exif");
    }
  });
});

describe("processImage: fotos chicas, transparencia y archivos dañados", () => {
  it.each([800, 1100, 1300])(
    "una foto de %i px de ancho igual se arma: ig_4x5 y pi_4x3 se amplían, el thumb no",
    async (width) => {
      // La advertencia de foto chica la calcula core desde el ancho guardado (photoSizeWarnings).
      const input = await syntheticPhoto(width, Math.round((width * 3) / 4));
      const result = await processor().processImage(input, { mime: "image/jpeg", variants: ALL });

      const sizes = Object.fromEntries(result.outputs.map((o) => [o.variant, [o.width, o.height]]));
      expect(sizes.ig_4x5).toEqual([1080, 1350]);
      expect(sizes.pi_4x3).toEqual([1600, 1200]);
      expect(sizes.thumb?.[0]).toBe(Math.min(width, 800));
      expect(result.measurements.width).toBe(width);
    },
  );

  it("una PNG con transparencia sale sobre fondo blanco, no negro", async () => {
    const input = new Uint8Array(
      await sharp({
        create: {
          width: 1200,
          height: 900,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer(),
    );
    const result = await processor().processImage(input, {
      mime: "image/png",
      variants: ["thumb"],
    });
    const [r = 0, g = 0, b = 0] = await pixel(result.outputs[0]?.bytes ?? new Uint8Array(), 10, 10);
    expect(Math.min(r, g, b)).toBeGreaterThan(240);
  });

  it.each([
    ["un archivo que no es una imagen", "image/jpeg", new TextEncoder().encode("no soy una foto")],
    ["un JPEG cortado a la mitad", "image/jpeg", null],
    ["un HEIC dañado", "image/heic", new TextEncoder().encode("ftypheic, pero no")],
  ])("%s → MEDIA_DECODE_FAILED, no reintentable", async (_, mime, bytes) => {
    const photo = await syntheticPhoto(1200, 900);
    const input = bytes ?? photo.slice(0, Math.floor(photo.length / 2));
    const dir = await tempDir("agentsales-media-bad-");
    const error = await errorOf(
      createMediaProcessor({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, workDir: dir }).processImage(
        input,
        { mime, variants: ALL },
      ),
    );
    expect([error.code, error.retriable]).toEqual(["MEDIA_DECODE_FAILED", false]);
    // El HEIC que no se pudo leer tampoco deja su copia en el temporal.
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("processImage: HEIC con ffmpeg", () => {
  it("el archivo de prueba es un HEIC hecho de mosaicos (grupo Tile Grid)", () => {
    const output = execFileSync(FFPROBE, [
      "-v",
      "error",
      "-show_stream_groups",
      HEIC_PATH,
    ]).toString();
    expect(output).toContain("type=Tile Grid");
  });

  it("sale en JPEG completo, derecho y sin metadatos, y borra su temporal", async () => {
    const input = new Uint8Array(await readFile(HEIC_FIXTURE));
    const dir = await tempDir("agentsales-media-heic-");
    const result = await createMediaProcessor({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workDir: dir,
    }).processImage(input, { mime: "image/heic", variants: ALL });

    // 1600×1200 guardado con giro: derecho es vertical, completo (no un mosaico de 512).
    expect(result.measurements).toEqual({ width: 1200, height: 1600, durationS: null });
    const thumb = result.outputs.find((output) => output.variant === "thumb");
    if (thumb === undefined) throw new Error("falta el thumb");
    expect([thumb.width, thumb.height]).toEqual([600, 800]);
    expect(isRed(await pixel(thumb.bytes, 590, 10))).toBe(true);
    expect(isRed(await pixel(thumb.bytes, 10, 10))).toBe(false);
    for (const output of result.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect([metadata.format, metadata.exif]).toEqual(["jpeg", undefined]);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("un FFMPEG_PATH que no existe → MEDIA_TOOL_NOT_INSTALLED, con el comando para instalarlo", async () => {
    const input = new Uint8Array(await readFile(HEIC_FIXTURE));
    const error = await errorOf(
      processor({ ffmpegPath: "/no/existe/ffmpeg" }).processImage(input, {
        mime: "image/heic",
        variants: ["thumb"],
      }),
    );
    expect([error.code, error.retriable]).toEqual(["MEDIA_TOOL_NOT_INSTALLED", false]);
    expect(error.message).toContain("brew install ffmpeg");
  });

  it("un JPEG no necesita ffmpeg", async () => {
    const input = await syntheticPhoto(1200, 900);
    const result = await processor({ ffmpegPath: "/no/existe/ffmpeg" }).processImage(input, {
      mime: "image/jpeg",
      variants: ["thumb"],
    });
    expect(result.outputs).toHaveLength(1);
  });

  it("un ffmpeg anterior a 8.1 → MEDIA_TOOL_NOT_INSTALLED", async () => {
    const fake = await fakeFfmpeg("7.1.1");
    tempDirs.push(fake.dir);
    const input = new Uint8Array(await readFile(HEIC_FIXTURE));
    const error = await errorOf(
      processor({ ffmpegPath: fake.path }).processImage(input, {
        mime: "image/heic",
        variants: ["thumb"],
      }),
    );
    expect(error.code).toBe("MEDIA_TOOL_NOT_INSTALLED");
    expect(error.message).toContain("7.1 es anterior a 8.1");
  });
});

describe("processImage: cortar con signal", () => {
  it("con el signal ya disparado no hace nada: MEDIA_ABORTED, reintentable", async () => {
    const input = await syntheticPhoto(1200, 900);
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(
      processor().processImage(input, { mime: "image/jpeg", variants: ALL }, controller.signal),
    );
    expect([error.code, error.retriable]).toEqual(["MEDIA_ABORTED", true]);
  });

  it("cortar una foto HEIC no corta otra que se procesa a la vez", async () => {
    const input = new Uint8Array(await readFile(HEIC_FIXTURE));
    const shared = processor();
    const controller = new AbortController();
    const cut = shared.processImage(
      input,
      { mime: "image/heic", variants: ["thumb"] },
      controller.signal,
    );
    const other = shared.processImage(input, { mime: "image/heic", variants: ["thumb"] });
    controller.abort();

    expect((await errorOf(cut)).code).toBe("MEDIA_ABORTED");
    expect((await other).outputs).toHaveLength(1);
  });

  it("cortar mientras ffmpeg trabaja lo termina", async () => {
    const fake = await fakeFfmpeg("9.0.1");
    const input = new Uint8Array(await readFile(HEIC_FIXTURE));
    const controller = new AbortController();
    const pending = processor({ ffmpegPath: fake.path }).processImage(
      input,
      { mime: "image/heic", variants: ["thumb"] },
      controller.signal,
    );
    const pidFile = join(fake.dir, "pid");
    const pid = await waitFor(async () => {
      const value = Number(await readFile(pidFile, "utf8"));
      return Number.isInteger(value) && value > 0 ? value : undefined;
    });
    controller.abort();

    expect((await errorOf(pending)).code).toBe("MEDIA_ABORTED");
    await waitFor(async () => (alive(pid) ? undefined : true));
    tempDirs.push(fake.dir);
  });
});

describe("createMediaProcessor", () => {
  it("expone la versión de los parámetros, y el video llega en F2-T08", async () => {
    expect(processor().version).toBe(MEDIA_PIPELINE_VERSION);
    const error = await errorOf(
      processor().processVideo((async function* () {})(), { reel: null }),
    );
    expect(error.code).toBe("MEDIA_VIDEO_NOT_IMPLEMENTED");
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Reintenta hasta que `read` devuelva algo (o 5 s). */
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch {
      // todavía no está
    }
    if (Date.now() > deadline) throw new Error("waitFor: se acabó el tiempo");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
