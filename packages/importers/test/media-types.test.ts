import { describe, expect, it } from "vitest";
import { mediaTypeOf } from "../src/media-types.js";
import { SAMPLES } from "./media-fixtures.js";

describe("mediaTypeOf", () => {
  it.each([
    ["foto.jpg", "image", "image/jpeg"],
    ["FOTO.JPEG", "image", "image/jpeg"],
    ["plano.png", "image", "image/png"],
    ["vista.webp", "image", "image/webp"],
    ["IMG_0001.HEIC", "image", "image/heic"],
    ["recorrido.mp4", "video", "video/mp4"],
    ["recorrido.MOV", "video", "video/quicktime"],
  ])("%s → %s (%s)", (name, kind, mime) => {
    expect(mediaTypeOf(name)).toMatchObject({ kind, mime });
  });

  it.each([
    ["FOTO.JPEG", "jpg"],
    ["foto.JPG", "jpg"],
    ["IMG_0001.HEIC", "heic"],
    ["recorrido.MOV", "mov"],
  ])("%s tiene la extensión canónica %s", (name, extension) => {
    expect(mediaTypeOf(name)?.extension).toBe(extension);
  });

  it.each([
    "notas.txt",
    "plano.pdf",
    "sin-extension",
    ".jpg",
    "foto.jpg.zip",
    "toString",
    "a.constructor",
  ])("%s no es un tipo aceptado", (name) => {
    expect(mediaTypeOf(name)).toBeNull();
  });
});

describe("firmas", () => {
  const matches = (name: string, bytes: Uint8Array) => mediaTypeOf(name)?.matches(bytes) ?? false;

  it.each([
    ["foto.jpg", SAMPLES.jpeg()],
    ["foto.png", SAMPLES.png()],
    ["foto.webp", SAMPLES.webp()],
    ["foto.heic", SAMPLES.heic()],
    ["video.mp4", SAMPLES.mp4()],
    ["video.mov", SAMPLES.mov()],
    ["video.mov", SAMPLES.movLegacy()],
    // Un mp4 renombrado a .mov se reproduce igual.
    ["video.mov", SAMPLES.mp4()],
    // Marcas de video de teléfonos y variantes de HEIF.
    ["video.mp4", SAMPLES.ftyp("3gp4")],
    ["video.mp4", SAMPLES.ftyp("mp42")],
    ["foto.heic", SAMPLES.ftyp("hevm")],
    ["foto.heic", SAMPLES.ftyp("hevs")],
    ["foto.heic", SAMPLES.ftyp("mif1")],
  ])("%s acepta su firma", (name, bytes) => {
    expect(matches(name, bytes)).toBe(true);
  });

  it.each([
    ["foto.jpg", SAMPLES.png()],
    ["foto.png", SAMPLES.jpeg()],
    ["foto.webp", SAMPLES.png()],
    // Un HEIC no es video, y un video no es HEIC, aunque compartan la caja `ftyp`.
    ["foto.heic", SAMPLES.mp4()],
    ["video.mp4", SAMPLES.heic()],
    ["video.mov", SAMPLES.heic()],
    ["video.mp4", SAMPLES.movLegacy()],
    // AVIF y audio de iTunes renombrados a .mp4 no son video.
    ["video.mp4", SAMPLES.ftyp("avif")],
    ["video.mp4", SAMPLES.ftyp("M4A ")],
    ["video.mov", SAMPLES.ftyp("M4B ")],
    ["foto.jpg", new TextEncoder().encode("no soy una foto")],
    ["foto.jpg", new Uint8Array([0xff, 0xd8])],
    ["video.mp4", new Uint8Array(0)],
  ])("%s rechaza otra firma (%#)", (name, bytes) => {
    expect(matches(name, bytes)).toBe(false);
  });
});
