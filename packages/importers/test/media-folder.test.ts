import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError, type MediaFile, type MediaFolderListing } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaFolderSource, naturalOrder } from "../src/media-folder.js";
import { collect, SAMPLES, sha256 } from "./media-fixtures.js";

/**
 * Cada `open` de `node:fs/promises` queda registrado con si se cerró: así se prueba que el lector
 * cierra el archivo sin contar los descriptores del proceso, que en la CI cambian por otras
 * actividades del runner (pasó en F1-T07b).
 */
const fileHandles = vi.hoisted(() => [] as { closed: boolean }[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const record = { closed: false };
      fileHandles.push(record);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        record.closed = true;
        return close();
      };
      return handle;
    },
  };
});

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
  extension: file.extension,
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
        extension: "webp",
        bytes: photo1.byteLength,
        sha256: sha256(photo1),
      },
      {
        relPath: "depto-101/foto2.png",
        kind: "image",
        mime: "image/png",
        extension: "png",
        bytes: photo2.byteLength,
        sha256: sha256(photo2),
      },
      {
        relPath: "depto-101/foto10.jpg",
        kind: "image",
        mime: "image/jpeg",
        extension: "jpg",
        bytes: photo10.byteLength,
        sha256: sha256(photo10),
      },
      {
        relPath: "depto-101/recorrido.mp4",
        kind: "video",
        mime: "video/mp4",
        extension: "mp4",
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

  it("open() cortado a mitad (como cuando putStream aborta) cierra el archivo", async () => {
    await put("p/grande.jpg", SAMPLES.jpeg("x", 300_000));
    const file = onlyFile(await source().list("p"));
    const before = fileHandles.length;

    const iterator = file.open()[Symbol.asyncIterator]();
    await iterator.next();
    const [handle] = fileHandles.slice(before);
    expect(handle?.closed).toBe(false);
    await iterator.return?.();

    expect(fileHandles.slice(before).map((opened) => opened.closed)).toEqual([true]);
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

  it("con nombres que empatan sin mayúsculas ni tildes, el orden es determinista", async () => {
    await put("p/fóto1.jpg", SAMPLES.jpeg());
    await put("p/foto1.jpg", SAMPLES.jpeg());
    await put("p/foto01.jpg", SAMPLES.jpeg());

    const listing = await source().list("p");

    expect(listing.files.map((file) => file.relPath)).toEqual([
      "p/foto01.jpg",
      "p/foto1.jpg",
      "p/fóto1.jpg",
    ]);
  });

  it("naturalOrder desempata con la comparación binaria, en cualquier orden de entrada", () => {
    const names = ["fóto1.jpg", "Foto1.jpg", "foto10.jpg", "foto1.jpg", "foto2.jpg"];
    const expected = ["Foto1.jpg", "foto1.jpg", "fóto1.jpg", "foto2.jpg", "foto10.jpg"];

    expect([...names].sort(naturalOrder)).toEqual(expected);
    expect([...names].reverse().sort(naturalOrder)).toEqual(expected);
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
        extension: "heic",
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

  it("una carpeta enlazada que apunta fuera de la raíz: MEDIA_FOLDER_INVALID", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentsales-outside-"));
    try {
      await writeFile(join(outside, "secreto.jpg"), SAMPLES.jpeg());
      await mkdir(join(outside, "interna"));
      await writeFile(join(outside, "interna/secreto.jpg"), SAMPLES.jpeg());
      await symlink(outside, join(root, "enlace"));

      await expectError(source().list("enlace"), "MEDIA_FOLDER_INVALID");
      // También si el enlace está en un tramo intermedio de la ruta.
      await expectError(source().list("enlace/interna"), "MEDIA_FOLDER_INVALID");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("una carpeta enlazada que apunta dentro de la raíz sí es válida", async () => {
    await put("p/foto.jpg", SAMPLES.jpeg());
    await symlink(join(root, "p"), join(root, "alias"));

    expect((await source().list("alias")).files.map((file) => file.relPath)).toEqual([
      "alias/foto.jpg",
    ]);
  });

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
