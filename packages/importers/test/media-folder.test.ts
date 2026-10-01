import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError, type MediaFile, type MediaFolderListing } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMediaFolderSource } from "../src/media-folder.js";
import { collect, SAMPLES, sha256 } from "./media-fixtures.js";

const MAX_VIDEO_BYTES = 1024;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentsales-media-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relPath: string, bytes: Uint8Array | string) {
  const path = join(root, relPath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
  return error;
}

const source = () => createMediaFolderSource(root, { maxVideoBytes: MAX_VIDEO_BYTES });
/** El único archivo aceptado del listado. */
function onlyFile({ files }: MediaFolderListing): MediaFile {
  expect(files).toHaveLength(1);
  return files[0] as MediaFile;
}

const summary = (file: MediaFile) => ({
  relPath: file.relPath,
  kind: file.kind,
  mime: file.mime,
  bytes: file.bytes,
  sha256: file.sha256,
});

describe("createMediaFolderSource · carpeta fixture", () => {
  it("3 fotos + 1 video + 1 inválido: orden natural, tipo y sha256 correctos", async () => {
    const photo1 = SAMPLES.webp("1");
    const photo2 = SAMPLES.png("2");
    const photo10 = SAMPLES.jpeg("0", 200);
    const video = SAMPLES.mp4("v", 500);
    await put("depto-101/foto10.jpg", photo10);
    await put("depto-101/foto2.png", photo2);
    await put("depto-101/Foto1.webp", photo1);
    await put("depto-101/recorrido.mp4", video);
    await put("depto-101/notas.txt", "no es un medio");

    const listing = await source().list("depto-101");

    expect(listing.files.map(summary)).toEqual([
      {
        relPath: "depto-101/Foto1.webp",
        kind: "image",
        mime: "image/webp",
        bytes: photo1.byteLength,
        sha256: sha256(photo1),
      },
      {
        relPath: "depto-101/foto2.png",
        kind: "image",
        mime: "image/png",
        bytes: photo2.byteLength,
        sha256: sha256(photo2),
      },
      {
        relPath: "depto-101/foto10.jpg",
        kind: "image",
        mime: "image/jpeg",
        bytes: photo10.byteLength,
        sha256: sha256(photo10),
      },
      {
        relPath: "depto-101/recorrido.mp4",
        kind: "video",
        mime: "video/mp4",
        bytes: video.byteLength,
        sha256: sha256(video),
      },
    ]);
    expect(listing.skipped).toEqual([
      { relPath: "depto-101/notas.txt", reason: "unsupported_type" },
    ]);
  });

  it("open() entrega exactamente los bytes del archivo, y se puede abrir otra vez", async () => {
    const big = SAMPLES.jpeg("x", 300_000); // más de un bloque de lectura (64 KiB)
    await put("p/grande.jpg", big);
    const file = onlyFile(await source().list("p"));

    expect(await collect(file.open())).toEqual(big);
    expect(sha256(await collect(file.open()))).toBe(file.sha256);
  });

  it("open() de un archivo que ya no existe: MEDIA_FILE_UNREADABLE con la ruta relativa", async () => {
    const path = await put("p/foto.jpg", SAMPLES.jpeg());
    const file = onlyFile(await source().list("p"));
    await rm(path);

    const error = await expectError(collect(file.open()), "MEDIA_FILE_UNREADABLE");
    expect(isAppError(error) && error.retriable).toBe(false);
    expect(String(error)).not.toContain(root);
  });
});

describe("createMediaFolderSource · archivos omitidos", () => {
  it("firma distinta, vacío, video sobre el tope, subcarpeta y enlace simbólico", async () => {
    await put("p/falsa.jpg", SAMPLES.png());
    await put("p/vacia.jpg", new Uint8Array(0));
    await put("p/largo.mov", SAMPLES.mov("q", MAX_VIDEO_BYTES + 1));
    await put("p/justo.mov", SAMPLES.mov("q", MAX_VIDEO_BYTES));
    await put("p/sub/foto.jpg", SAMPLES.jpeg());
    const target = await put("afuera/secreto.jpg", SAMPLES.jpeg());
    await symlink(target, join(root, "p/enlace.jpg"));

    const listing = await source().list("p");

    expect(listing.files.map((file) => file.relPath)).toEqual(["p/justo.mov"]);
    expect(listing.skipped).toEqual([
      { relPath: "p/enlace.jpg", reason: "not_a_file" },
      { relPath: "p/falsa.jpg", reason: "signature_mismatch" },
      { relPath: "p/largo.mov", reason: "too_large" },
      { relPath: "p/sub", reason: "not_a_file" },
      { relPath: "p/vacia.jpg", reason: "empty" },
    ]);
  });

  it("ignora sin advertencia los ocultos y la basura del sistema", async () => {
    await put("p/.DS_Store", "x");
    await put("p/._foto.jpg", "x");
    await put("p/Thumbs.db", "x");
    await put("p/desktop.ini", "x");
    await put("p/__MACOSX/foto.jpg", "x");
    await put("p/foto.jpg", SAMPLES.jpeg());

    const listing = await source().list("p");

    expect(listing.files.map((file) => file.relPath)).toEqual(["p/foto.jpg"]);
    expect(listing.skipped).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("un archivo sin permiso de lectura: unreadable", async () => {
    const path = await put("p/foto.jpg", SAMPLES.jpeg());
    await chmod(path, 0o000);

    expect((await source().list("p")).skipped).toEqual([
      { relPath: "p/foto.jpg", reason: "unreadable" },
    ]);
  });

  it("acepta extensiones en mayúsculas (iPhone) y carpetas anidadas dentro de la raíz", async () => {
    const heic = SAMPLES.heic();
    await put("casas/c1/IMG_0001.HEIC", heic);

    const listing = await source().list("casas/c1");

    expect(listing.files.map(summary)).toEqual([
      {
        relPath: "casas/c1/IMG_0001.HEIC",
        kind: "image",
        mime: "image/heic",
        bytes: heic.byteLength,
        sha256: sha256(heic),
      },
    ]);
  });
});

describe("createMediaFolderSource · carpeta", () => {
  it.each(["..", "../afuera", "p/../../afuera", "/etc", "", "  ", "."])(
    '"%s" sale de la raíz o está vacía: MEDIA_FOLDER_INVALID',
    async (folder) => {
      await expectError(source().list(folder), "MEDIA_FOLDER_INVALID");
    },
  );

  it("una carpeta que empieza con dos puntos sí es válida", async () => {
    await put("..fotos/foto.jpg", SAMPLES.jpeg());
    expect((await source().list("..fotos")).files).toHaveLength(1);
  });

  it("una carpeta que no existe: MEDIA_FOLDER_NOT_FOUND, sin la ruta de la raíz", async () => {
    const error = await expectError(source().list("no-existe"), "MEDIA_FOLDER_NOT_FOUND");
    expect(isAppError(error) && error.details).toEqual({ folder: "no-existe" });
    expect(String(error)).not.toContain(root);
  });

  it("un archivo en lugar de carpeta: MEDIA_FOLDER_NOT_FOUND", async () => {
    await put("p", "soy un archivo");
    await expectError(source().list("p"), "MEDIA_FOLDER_NOT_FOUND");
  });

  it("una carpeta vacía no es error", async () => {
    await mkdir(join(root, "vacia"));
    expect(await source().list("vacia")).toEqual({ files: [], skipped: [] });
  });
});
