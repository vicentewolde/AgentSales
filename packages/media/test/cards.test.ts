import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CardBrand, type CardSpec, postCardDeck } from "@agentsales/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_RENDER_VERSION, paletteOf } from "../src/cards.js";
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

  it("una tarjeta en 4:5 y en 9:16: JPEG del tamaño exacto, con el fondo y el acento de la marca", async () => {
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
      // El fondo es un degradado del color principal (un poco más claro arriba a la izquierda y más
      // hondo abajo a la derecha): sigue siendo azul y no cambia de tono.
      const top = await pixel(out.bytes, 10, 10);
      const bottom = await pixel(out.bytes, 1070, height - 10);
      expect(near(top, [0x1f, 0x4e, 0x79], 40)).toBe(true);
      expect((top[2] ?? 0) > (top[0] ?? 0) && (bottom[2] ?? 0) > (bottom[0] ?? 0)).toBe(true);
      expect((bottom[0] ?? 0) + (bottom[1] ?? 0)).toBeLessThan((top[0] ?? 0) + (top[1] ?? 0));
      // La raya de acento sobre el título (el color secundario) está donde se espera.
      expect(await hasColor(out.bytes, [0xf2, 0xa9, 0x00], { left: 88, width: 84 })).toBe(true);
    }
  });

  it("la versión del dibujo cambió y las tarjetas son deterministas", async () => {
    expect(CARD_RENDER_VERSION).toBe("2");
    const a = await renderer.render(card("cover", "Mismo texto", "@agentpey"), {
      format: "4:5",
      brand: BRAND,
    });
    const b = await renderer.render(card("cover", "Mismo texto", "@agentpey"), {
      format: "4:5",
      brand: BRAND,
    });
    expect(a.sha256).toBe(b.sha256);
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
    // El chip blanco empieza en el margen (88 px) y a 84 px del borde de arriba.
    expect(near(await pixel(cover.bytes, 95, 126), [255, 255, 255])).toBe(true);
    // En 9:16 baja a 200 px: Instagram y TikTok tapan la franja de arriba del reel.
    const tall = await renderer.render(card("cover", "Tema"), { format: "9:16", brand });
    expect(near(await pixel(tall.bytes, 95, 126), [255, 255, 255], 40)).toBe(false);
    expect(near(await pixel(tall.bytes, 95, 242), [255, 255, 255])).toBe(true);
    const closing = await renderer.render(card("closing", "AgentPey", "@agentpey"), {
      format: "9:16",
      brand,
    });
    expect(await sharp(closing.bytes).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("un logo claro (blanco sobre transparente) va en un chip oscuro, no blanco", async () => {
    const light = new Uint8Array(
      await sharp({
        create: {
          width: 300,
          height: 100,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    const out = await renderer.render(card("cover", "Tema"), {
      format: "4:5",
      brand: { ...BRAND, logo: light },
    });
    expect(near(await pixel(out.bytes, 95, 126), [0x11, 0x18, 0x27], 12)).toBe(true);
  });

  it("el pie lleva el contacto y el avance: sin contacto la tarjeta cambia, y el avance sigue la posición", async () => {
    const options = { format: "4:5" as const, brand: BRAND };
    const withContact = await renderer.render(card("point", "Un punto", "@agentpey"), options);
    const without = await renderer.render(card("point", "Un punto"), options);
    expect(withContact.sha256).not.toBe(without.sha256);
    // El contacto es texto claro a la izquierda del pie (1350 - 84 - 40 = 1226 a 1266 de alto).
    expect(await hasLight(withContact.bytes, { left: 88, width: 220, top: 1226, height: 40 })).toBe(
      true,
    );
    expect(await hasLight(without.bytes, { left: 88, width: 220, top: 1226, height: 40 })).toBe(
      false,
    );
    // Avance 2/4: dos segmentos del acento y dos apagados.
    expect(await filledSegments(withContact.bytes, 1246, 930)).toBe(2);
    const first = await renderer.render({ ...card("cover", "Tema"), position: 1 }, options);
    expect(await filledSegments(first.bytes, 1246, 930)).toBe(1);
    const last = await renderer.render({ ...card("closing", "AgentPey"), position: 4 }, options);
    expect(await filledSegments(last.bytes, 1246, 1000)).toBe(4);
  });

  it("el cierre pone el contacto en una píldora del color de acento", async () => {
    const out = await renderer.render(card("closing", "AgentPey", "@agentpey"), {
      format: "4:5",
      brand: BRAND,
    });
    expect(
      await hasColor(out.bytes, [0xf2, 0xa9, 0x00], {
        left: 300,
        width: 480,
        top: 500,
        height: 600,
      }),
    ).toBe(true);
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
    // Un degradado del color de la marca (arriba, un poco más claro): sigue siendo crema.
    expect(near(await pixel(out.bytes, 10, 10), [0xf5, 0xe6, 0xc8], 30)).toBe(true);
  });
});

/** ¿Hay un píxel de ese color (con tolerancia) en la región? */
async function hasColor(
  bytes: Uint8Array,
  rgb: [number, number, number],
  region: { left: number; width: number; top?: number; height?: number },
): Promise<boolean> {
  const { data, info } = await sharp(bytes)
    .extract({
      left: region.left,
      top: region.top ?? 0,
      width: region.width,
      height: region.height ?? 1350,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (near([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0], rgb, 14)) return true;
  }
  return false;
}

/** ¿Hay un píxel claro (texto) en la región? */
async function hasLight(
  bytes: Uint8Array,
  region: { left: number; width: number; top: number; height: number },
): Promise<boolean> {
  const { data, info } = await sharp(bytes)
    .extract(region)
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if ((data[i] ?? 0) > 170 && (data[i + 1] ?? 0) > 170 && (data[i + 2] ?? 0) > 170) return true;
  }
  return false;
}

/**
 * Cuántos segmentos del avance están rellenos con el acento (#F2A900): rachas de ese color en la
 * fila `y` del pie, a la izquierda de la flecha (la última tarjeta no la lleva).
 */
async function filledSegments(bytes: Uint8Array, y: number, to: number): Promise<number> {
  const { data, info } = await sharp(bytes)
    .extract({ left: 600, top: y, width: to - 600, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let runs = 0;
  let inRun = false;
  for (let x = 0; x < info.width; x++) {
    const on = near(
      [
        data[x * info.channels] ?? 0,
        data[x * info.channels + 1] ?? 0,
        data[x * info.channels + 2] ?? 0,
      ],
      [0xf2, 0xa9, 0x00],
      25,
    );
    if (on && !inRun) runs++;
    inRun = on;
  }
  return runs;
}

describe("la paleta", () => {
  // Contraste WCAG calculado aparte, para no probar el código con sí mismo.
  const lum = (hex: string) => {
    const v = Number.parseInt(hex.slice(1), 16);
    const ch = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((v >> 16) & 255) + 0.7152 * ch((v >> 8) & 255) + 0.0722 * ch(v & 255);
  };
  const ratio = (a: string, b: string) =>
    (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const colors = [
    "#000000",
    "#FFFFFF",
    "#0B1B3A",
    "#F4EBDD",
    "#E11D48",
    "#7C3AED",
    "#808080",
    "#777777",
    "#999999",
    "#00FF00",
    "#FFFF00",
    "#FF8800",
    "#3B82F6",
    "#14B8A6",
    "#F59E0B",
    "#6B7280",
  ];

  it("con cualquier par de colores de marca, el texto contrasta 4,5:1 y el acento 3:1 con todo el fondo", () => {
    for (const primary of colors) {
      for (const secondary of colors) {
        const p = paletteOf(primary, secondary);
        for (const bg of [p.from, p.to]) {
          expect(
            ratio(p.text, bg),
            `${primary}/${secondary} texto sobre ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            ratio(p.accent, bg),
            `${primary}/${secondary} acento sobre ${bg}`,
          ).toBeGreaterThanOrEqual(3);
        }
        // El texto sobre el acento es grande y en negrita (WCAG AA de texto grande: 3:1).
        expect(ratio(p.onAccent, p.accent)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("un color que ya contrasta se respeta: el secundario de la marca es el acento", () => {
    expect(paletteOf("#0B1B3A", "#2DE2B5").accent).toBe("#2DE2B5");
    expect(paletteOf("#F4EBDD", "#C2410C").accent).toBe("#C2410C");
  });
});

describe("el video de las tarjetas", () => {
  it("las tarjetas de un post de video en 9:16 se unen con ffmpeg y la música", async () => {
    const renderer = createCardRenderer();
    const deck = postCardDeck(
      { id: "p1", topic: "Tres claves para vender", kind: "video" },
      [{ platform: "instagram", language: "es", body: "- Fija bien el precio\n- Ordena la casa" }],
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
