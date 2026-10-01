import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryTargetPath, extractZip, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from "../src/zip.js";
import { SAMPLES } from "./media-fixtures.js";
import { buildZip, type ZipEntrySpec } from "./zip-builder.js";

let work: string;
let dest: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "agentsales-zip-"));
  dest = join(work, "extracted");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeZip(entries: readonly ZipEntrySpec[], name = "medios.zip") {
  const path = join(work, name);
  await writeFile(path, buildZip(entries));
  return path;
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
  expect(isAppError(error) && error.retriable).toBe(false);
  // El mensaje y los detalles llevan el nombre del zip, nunca la ruta.
  expect(isAppError(error) && error.message).not.toContain(work);
  expect(JSON.stringify(isAppError(error) && error.details)).not.toContain(work);
  return error;
}

/** Archivos bajo `dir`, con `/` y ordenados. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

describe("extractZip · extracción normal", () => {
  it("extrae las carpetas de cada propiedad y el logo, con el contenido exacto", async () => {
    const photo = SAMPLES.jpeg("1", 5000);
    const video = SAMPLES.mp4("v", 3000);
    const zip = await writeZip([
      { name: "depto-101/" },
      { name: "depto-101/foto1.jpg", data: photo },
      { name: "depto-101/recorrido.mp4", data: video, method: "deflate" },
      // Sin entrada de carpeta: la carpeta se crea igual.
      { name: "_marca/logo.png", data: SAMPLES.png() },
    ]);

    const result = await extractZip(zip, dest);

    expect(result).toEqual({
      files: 3,
      bytes: photo.byteLength + video.byteLength + SAMPLES.png().byteLength,
      skipped: 0,
    });
    expect(await tree(dest)).toEqual([
      "_marca/logo.png",
      "depto-101/foto1.jpg",
      "depto-101/recorrido.mp4",
    ]);
    expect(new Uint8Array(await readFile(join(dest, "depto-101/foto1.jpg")))).toEqual(photo);
    expect(new Uint8Array(await readFile(join(dest, "depto-101/recorrido.mp4")))).toEqual(video);
  });

  it("omite enlaces simbólicos, __MACOSX y ocultos", async () => {
    const zip = await writeZip([
      { name: "p/foto.jpg", data: SAMPLES.jpeg() },
      { name: "p/enlace.jpg", data: "/etc/passwd", mode: 0o120777 },
      { name: "__MACOSX/p/._foto.jpg", data: "x" },
      { name: "p/.DS_Store", data: "x" },
    ]);

    expect(await extractZip(zip, dest)).toMatchObject({ files: 1, skipped: 3 });
    expect(await tree(dest)).toEqual(["p/foto.jpg"]);
  });

  it("nombres con prefijo ./ (algunas herramientas) se extraen", async () => {
    const zip = await writeZip([
      { name: "./" },
      { name: "./p/" },
      { name: "./p/foto.jpg", data: SAMPLES.jpeg() },
      { name: "p/./video.mp4", data: SAMPLES.mp4() },
    ]);

    expect(await extractZip(zip, dest)).toMatchObject({ files: 2, skipped: 0 });
    expect(await tree(dest)).toEqual(["p/foto.jpg", "p/video.mp4"]);
  });

  it("una entrada sin tipo Unix (zip de Windows) es un archivo", async () => {
    const zip = await writeZip([{ name: "p/foto.jpg", data: SAMPLES.jpeg(), mode: 0 }]);
    expect(await extractZip(zip, dest)).toMatchObject({ files: 1 });
  });

  it("los topes por defecto son los del spec: 2000 entradas y 4 GB", () => {
    expect(MAX_ZIP_ENTRIES).toBe(2000);
    expect(MAX_ZIP_BYTES).toBe(4 * 1024 * 1024 * 1024);
  });
});

describe("extractZip · zip-slip", () => {
  const absolute = join(tmpdir(), `agentsales-evil-${process.pid}.txt`);

  it.each([
    "../evil.txt",
    "p/../../evil.txt",
    absolute,
    "..\\evil.txt",
    // Oculto y con `..`: la ruta se verifica antes de decidir si se omite.
    "../.evil.txt",
  ])("rechaza la entrada %s sin escribir nada fuera del destino", async (name) => {
    const zip = await writeZip([
      { name: "p/foto.jpg", data: SAMPLES.jpeg() },
      { name, data: "malicioso" },
    ]);

    await expectError(extractZip(zip, dest), "IMPORT_FILE_INVALID");

    expect(await readdir(work)).toEqual(expect.not.arrayContaining(["evil.txt", ".evil.txt"]));
    await expect(lstat(absolute)).rejects.toThrow();
  });

  // yauzl rechaza estos nombres antes; esta es la segunda barrera, probada directo.
  it.each([
    ["../evil.txt", null],
    ["..", null],
    ["p/../..", null],
    ["p/../../evil.txt", null],
    ["/etc/passwd", null],
    ["p/foto.jpg", "p/foto.jpg"],
    ["./p/./foto.jpg", "p/foto.jpg"],
    ["./", ""],
  ])("entryTargetPath(%s)", (name, expected) => {
    const root = join(work, "raiz");
    expect(entryTargetPath(root, name)).toBe(expected === null ? null : join(root, expected));
  });
});

describe("extractZip · topes", () => {
  it("más entradas que el tope: rechaza antes de escribir nada", async () => {
    const zip = await writeZip([
      { name: "a.jpg", data: "1" },
      { name: "b.jpg", data: "2" },
      { name: "c.jpg", data: "3" },
    ]);

    const error = await expectError(
      extractZip(zip, dest, { maxEntries: 2 }),
      "IMPORT_FILE_INVALID",
    );
    expect(isAppError(error) && error.details).toEqual({
      file: "medios.zip",
      entries: 3,
      maxEntries: 2,
    });
    await expect(lstat(dest)).rejects.toThrow();
  });

  it("más bytes descomprimidos que el tope: rechaza antes de escribir la entrada que lo pasa", async () => {
    const zip = await writeZip([
      { name: "a.jpg", data: "x".repeat(60) },
      { name: "b.jpg", data: "y".repeat(60) },
    ]);

    await expectError(extractZip(zip, dest, { maxTotalBytes: 100 }), "IMPORT_FILE_INVALID");
    expect(await tree(dest)).toEqual(["a.jpg"]);
  });

  it("una entrada que trae más bytes de los que declara (zip bomb): rechazada", async () => {
    const zip = await writeZip([
      { name: "bomba.jpg", data: "z".repeat(100_000), method: "deflate", declaredSize: 10 },
    ]);

    await expectError(extractZip(zip, dest, { maxTotalBytes: 1000 }), "IMPORT_FILE_INVALID");
  });
});

describe("extractZip · errores", () => {
  it("un zip que no existe: IMPORT_FILE_NOT_FOUND", async () => {
    await expectError(extractZip(join(work, "no-existe.zip"), dest), "IMPORT_FILE_NOT_FOUND");
  });

  it("un archivo que no es zip: IMPORT_FILE_INVALID", async () => {
    const path = join(work, "falso.zip");
    await writeFile(path, "esto no es un zip");
    await expectError(extractZip(path, dest), "IMPORT_FILE_INVALID");
  });

  it("un zip truncado: IMPORT_FILE_INVALID", async () => {
    const path = join(work, "truncado.zip");
    const bytes = buildZip([{ name: "a.jpg", data: SAMPLES.jpeg() }]);
    await writeFile(path, bytes.subarray(0, bytes.length - 10));
    await expectError(extractZip(path, dest), "IMPORT_FILE_INVALID");
  });

  it("una entrada con contraseña: IMPORT_FILE_INVALID por la contraseña", async () => {
    const zip = await writeZip([{ name: "a.jpg", data: SAMPLES.jpeg(), encrypted: true }]);
    const error = await expectError(extractZip(zip, dest), "IMPORT_FILE_INVALID");
    expect(isAppError(error) && error.message).toContain("contraseña");
  });

  it.each([
    ["exactos", "p/foto.jpg"],
    ["que solo cambian mayúsculas", "p/FOTO.jpg"],
  ])("nombres repetidos %s: IMPORT_FILE_INVALID, sin pisar el primero", async (_, second) => {
    const zip = await writeZip([
      { name: "p/foto.jpg", data: "primera" },
      { name: second, data: "segunda" },
    ]);

    const error = await expectError(extractZip(zip, dest), "IMPORT_FILE_INVALID");
    expect(isAppError(error) && error.message).toContain("repetidos");
    expect(await readFile(join(dest, "p/foto.jpg"), "utf8")).toBe("primera");
  });

  it.each([
    [
      "archivo y después carpeta",
      [
        { name: "p", data: "x" },
        { name: "p/foto.jpg", data: "y" },
      ],
    ],
    [
      "carpeta y después archivo",
      [
        { name: "p/foto.jpg", data: "y" },
        { name: "P", data: "x" },
      ],
    ],
    ["archivo y entrada de carpeta", [{ name: "p", data: "x" }, { name: "p/" }]],
  ])(
    "un archivo y una carpeta con el mismo nombre (%s): IMPORT_FILE_INVALID",
    async (_, entries) => {
      const zip = await writeZip(entries);
      const error = await expectError(extractZip(zip, dest), "IMPORT_FILE_INVALID");
      expect(isAppError(error) && error.message).toContain("conflicto");
    },
  );

  it("un nombre demasiado largo para el disco: IMPORT_FILE_INVALID", async () => {
    const zip = await writeZip([{ name: `p/${"x".repeat(300)}.jpg`, data: SAMPLES.jpeg() }]);
    await expectError(extractZip(zip, dest), "IMPORT_FILE_INVALID");
  });

  it("una carpeta en vez de zip: IMPORT_FILE_INVALID", async () => {
    const folder = join(work, "carpeta.zip");
    await mkdir(folder);
    await expectError(extractZip(folder, dest), "IMPORT_FILE_INVALID");
  });

  it("un destino que ya tenía esos archivos: IMPORT_EXTRACT_FAILED, no culpa al zip", async () => {
    await mkdir(join(dest, "p"), { recursive: true });
    await writeFile(join(dest, "p/foto.jpg"), "de un intento anterior");
    const zip = await writeZip([{ name: "p/foto.jpg", data: SAMPLES.jpeg() }]);

    await expectError(extractZip(zip, dest), "IMPORT_EXTRACT_FAILED");
  });

  it("no puede escribir en el destino: IMPORT_EXTRACT_FAILED", async () => {
    // El destino es un archivo, así que no se puede crear la carpeta.
    await mkdir(work, { recursive: true });
    await writeFile(dest, "ocupado");
    const zip = await writeZip([{ name: "a.jpg", data: SAMPLES.jpeg() }]);

    await expectError(extractZip(zip, dest), "IMPORT_EXTRACT_FAILED");
  });
});
