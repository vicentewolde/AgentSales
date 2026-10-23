import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CardBrand, type CardSpec, postCardDeck } from "@agentsales/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCardRenderer, createMediaProcessor, textColorOn } from "../src/index.js";
import { FFMPEG, FFPROBE, pixel, TEST_THREADS } from "./images.js";

// F9.5-T25 (ADR-0038 §1.1): las tarjetas de la marca con sharp de verdad (sin red), y el video de
// las tarjetas con el motor del reel desde fotos (F9.5-T18) y música (F9.5-T19).

let dir: string;
let logo: Uint8Array;
let music: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentsales-cards-test-"));
  // Un logo sintético: un cuadrado rojo con transparencia alrededor.
  logo = new Uint8Array(
    await sharp({
      create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 200, height: 200, channels: 3, background: { r: 230, g: 20, b: 20 } },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 100,
        },
      ])
      .png()
      .toBuffer(),
  );
  // 6 s de un tono (la «pista» de música), como en las pruebas de T19.
  const track = join(dir, "pista.mp3");
  execFileSync(FFMPEG, [
    ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6"],
    ...["-c:a", "libmp3lame", "-b:a", "64k", track],
  ]);
  music = new Uint8Array(await readFile(track));
  // La primera tarjeta del proceso carga Pango y fontconfig (en Linux, con el archivo de Inter):
  // puede tardar, así que se hace aquí y no dentro del tope de una prueba.
  await createCardRenderer().render(card("cover", "Hola"), { format: "4:5", brand: BRAND });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BRAND: CardBrand = {
  brandName: "AgentPey",
  primaryColor: "#1F4E79",
  secondaryColor: "#F2A900",
  logo: null,
};

const card = (role: CardSpec["role"], text: string, detail: string | null = null): CardSpec => ({
  role,
  text,
  detail,
  position: 2,
  total: 4,
});

const near = (actual: number[], expected: number[], tolerance = 12) =>
  expected.every((value, index) => Math.abs((actual[index] ?? -999) - value) <= tolerance);

describe("createCardRenderer", () => {
  const renderer = createCardRenderer();

  it("una tarjeta en 4:5 y en 9:16: JPEG del tamaño exacto, el fondo y la franja de la marca", async () => {
    for (const [format, height] of [
      ["4:5", 1350],
      ["9:16", 1920],
    ] as const) {
      const out = await renderer.render(card("cover", "Cómo fijar el precio de tu casa"), {
        format,
        brand: BRAND,
      });
      const meta = await sharp(out.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1080, height]);
      expect([out.width, out.height, out.mime]).toEqual([1080, height, "image/jpeg"]);
      expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
      // Sin metadatos (sharp no copia los de entrada) y sin perfil EXIF.
      expect(meta.exif).toBeUndefined();
      expect(near(await pixel(out.bytes, 10, 10), [0x1f, 0x4e, 0x79])).toBe(true);
      expect(near(await pixel(out.bytes, 540, height - 5), [0xf2, 0xa9, 0x00], 20)).toBe(true);
    }
  });

  it("el texto se dibuja (hay píxeles claros sobre el fondo oscuro) y cambia con el texto", async () => {
    const a = await renderer.render(card("point", "Mira el mercado"), {
      format: "4:5",
      brand: BRAND,
    });
    const b = await renderer.render(card("point", "Revisa los gastos"), {
      format: "4:5",
      brand: BRAND,
    });
    expect(a.sha256).not.toBe(b.sha256);
    const { data, info } = await sharp(a.bytes).raw().toBuffer({ resolveWithObject: true });
    let light = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) > 200 && (data[i + 2] ?? 0) > 200) light++;
    }
    expect(light).toBeGreaterThan(500);
  });

  it("con logo: va en un chip blanco arriba a la izquierda; el cierre lo centra", async () => {
    const brand = { ...BRAND, logo };
    const cover = await renderer.render(card("cover", "Tema"), { format: "4:5", brand });
    // El chip blanco empieza en el margen (96 px).
    expect(near(await pixel(cover.bytes, 110, 140), [255, 255, 255])).toBe(true);
    const closing = await renderer.render(card("closing", "AgentPey", "@agentpey"), {
      format: "9:16",
      brand,
    });
    expect(await sharp(closing.bytes).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("un logo que no se lee se omite (sale el nombre) y un texto largo se achica hasta caber", async () => {
    const out = await renderer.render(card("cover", "palabra ".repeat(120)), {
      format: "4:5",
      brand: { ...BRAND, logo: new Uint8Array([1, 2, 3]) },
    });
    expect(await sharp(out.bytes).metadata()).toMatchObject({ width: 1080, height: 1350 });
  });

  it("el texto va en blanco sobre un fondo oscuro y en casi negro sobre uno claro", () => {
    expect(textColorOn("#1F4E79")).toBe("#FFFFFF");
    expect(textColorOn("#F5E6C8")).toBe("#111827");
  });

  it("una marca con fondo claro: el fondo es el de la marca", async () => {
    const out = await renderer.render(card("cover", "Hola"), {
      format: "4:5",
      brand: { ...BRAND, primaryColor: "#F5E6C8" },
    });
    expect(near(await pixel(out.bytes, 10, 10), [0xf5, 0xe6, 0xc8])).toBe(true);
  });
});

describe("el video de las tarjetas", () => {
  it("las tarjetas de un post de video en 9:16 se unen con ffmpeg y la música", async () => {
    const renderer = createCardRenderer();
    const deck = postCardDeck(
      { id: "p1", topic: "Tres claves para vender", kind: "video" },
      [{ platform: "instagram", body: "- Fija bien el precio\n- Ordena la casa" }],
      { brandName: "AgentPey", instagramHandle: "agentpey", website: null },
    );
    const cards = [];
    for (const item of deck)
      cards.push(await renderer.render(item, { format: "9:16", brand: BRAND }));
    const processor = createMediaProcessor({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workDir: await mkdtemp(join(dir, "intento-")),
      threads: TEST_THREADS,
    });
    const video = await processor.processPhotoReel(
      cards.map((item) => ({ mime: item.mime, read: async () => item.bytes })),
      { overlayPng: null, music: { bytes: music } },
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of video.open()) chunks.push(chunk);
    const path = join(dir, "tarjetas.mp4");
    await writeFile(path, Buffer.concat(chunks));
    const probe = JSON.parse(
      execFileSync(FFPROBE, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        path,
      ]).toString(),
    ) as { streams: { codec_type: string; width?: number; height?: number }[] };
    const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
    expect([videoStream?.width, videoStream?.height]).toEqual([1080, 1920]);
    expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    expect(video.withoutMusic ?? false).toBe(false);
    expect(video.durationS).toBeGreaterThan(3);
  }, 120_000);
});
