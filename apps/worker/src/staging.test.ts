import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { type ImportRun, isAppError } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaging, STAGING_MAX_AGE_MS } from "./staging.js";

const RUN_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/**
 * Zip mínimo sin compresión (el generador completo vive en los tests de `importers`, que no es
 * público). Solo archivos, con su ruta.
 */
function buildZip(files: Record<string, Buffer>): Buffer {
  const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const shared = Buffer.concat([
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0x21),
      u32(crc32(data)),
      u32(data.length),
      u32(data.length),
      u16(name.length),
    ]);
    const local = Buffer.concat([u32(0x04034b50), shared, u16(0), name, data]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        shared,
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0o100644 << 16),
        u32(offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

let work: string;
let root: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "agentsales-staging-"));
  root = join(work, "tmp", "imports");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const staging = () => createStaging({ root, maxVideoBytes: 1024 * 1024 });

const runWith = (mediaDir: string | null, id = RUN_ID): ImportRun => ({
  id,
  brokerId: null,
  status: "running",
  dryRun: false,
  source: "xlsx",
  fileName: "p.xlsx",
  input: { xlsxPath: join(work, "p.xlsx"), mediaDir, broker: null },
  rowsTotal: 0,
  rowsCreated: 0,
  rowsUpdated: 0,
  rowsSkipped: 0,
  rowsFailed: 0,
  report: null,
  error: null,
  startedAt: new Date(),
  finishedAt: null,
  createdAt: new Date(),
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function writeZip(name: string, files: Record<string, Buffer>) {
  const path = join(work, name);
  await writeFile(path, buildZip(files));
  return path;
}

describe("createStaging · openMedia", () => {
  it("sin mediaDir, no hay fuente de medios", async () => {
    const media = await staging().openMedia(runWith(null), ["P001"]);
    expect(media.source).toBeNull();
  });

  it("una carpeta se lee tal cual, sin tocar el staging", async () => {
    await mkdir(join(work, "medios", "P001"), { recursive: true });
    await writeFile(join(work, "medios", "P001", "foto.jpg"), JPEG);

    const media = await staging().openMedia(runWith(join(work, "medios")), ["P001"]);

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
    expect(await exists(root)).toBe(false);
  });

  it("un zip se extrae en extracted/, que se borra al cerrar; input/ se conserva", async () => {
    const input = join(root, RUN_ID, "input");
    await mkdir(input, { recursive: true });
    await writeFile(join(input, "propiedades.xlsx"), "subido por la API");
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    const media = await staging().openMedia(runWith(zip), ["P001"]);

    expect((await media.source?.list("P001"))?.files).toHaveLength(1);
    expect(await exists(join(root, RUN_ID, "extracted"))).toBe(true);
    await media.close();
    expect(await exists(join(root, RUN_ID, "extracted"))).toBe(false);
    expect(await readdir(input)).toEqual(["propiedades.xlsx"]);
  });

  it("cada intento recrea extracted/: no quedan archivos del intento anterior", async () => {
    const extracted = join(root, RUN_ID, "extracted");
    await mkdir(join(extracted, "P001"), { recursive: true });
    await writeFile(join(extracted, "P001", "viejo.jpg"), JPEG);
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    const media = await staging().openMedia(runWith(zip), ["P001"]);

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
  });

  it("un zip inválido: IMPORT_FILE_INVALID, sin dejar extracted/ y conservando input/", async () => {
    const input = join(root, RUN_ID, "input");
    await mkdir(input, { recursive: true });
    // Falla a mitad: la primera entrada ya se escribió cuando aparece la ruta hostil.
    const zip = await writeZip("roto.zip", { "P001/foto.jpg": JPEG, "../fuera.txt": JPEG });

    const error = await caught(staging().openMedia(runWith(zip), ["P001"]));

    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
    expect(await exists(join(root, RUN_ID, "extracted"))).toBe(false);
    expect(await exists(input)).toBe(true);
  });

  it("un zip con todo dentro de una carpeta (macOS → Comprimir) usa esa carpeta como raíz", async () => {
    const zip = await writeZip("medios.zip", {
      "medios/P001/foto.jpg": JPEG,
      "medios/_marca/logo.jpg": JPEG,
    });

    const media = await staging().openMedia(runWith(zip), ["P001", "_marca"]);

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
  });

  it("un zip con una sola propiedad en la raíz no se desenvuelve", async () => {
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    const media = await staging().openMedia(runWith(zip), ["P001"]);

    expect((await media.source?.list("P001"))?.files).toHaveLength(1);
  });

  it.each([
    ["no existe", "nada.zip", "IMPORT_FILE_NOT_FOUND"],
    ["no es carpeta ni zip", "medios.txt", "IMPORT_FILE_INVALID"],
  ])("unos medios que %s → %s, con el nombre y sin la ruta", async (_, name, code) => {
    if (name.endsWith(".txt")) await writeFile(join(work, name), "texto");

    const error = await caught(staging().openMedia(runWith(join(work, name)), ["P001"]));

    expect(isAppError(error) && error.code).toBe(code);
    expect(isAppError(error) && error.message).toContain(name);
    expect(isAppError(error) && error.message).not.toContain(work);
  });
});

describe("createStaging · discard y cleanup", () => {
  it("discard borra todo el directorio del run, y no falla si no existe", async () => {
    await mkdir(join(root, RUN_ID, "input"), { recursive: true });
    await staging().discard(RUN_ID);
    expect(await exists(join(root, RUN_ID))).toBe(false);
    await staging().discard(RUN_ID);
  });

  it("un id que no es uuid no arma rutas: IMPORT_RUN_INVALID", async () => {
    const error = await caught(staging().discard("../../etc"));
    expect(isAppError(error) && error.code).toBe("IMPORT_RUN_INVALID");
  });

  it("al arrancar borra los runs terminados y los de más de 24 h; deja los abiertos y lo ajeno", async () => {
    const terminado = "11111111-1111-4111-8111-111111111111";
    const abierto = "22222222-2222-4222-8222-222222222222";
    const viejo = "33333333-3333-4333-8333-333333333333";
    for (const id of [terminado, abierto, viejo, "no-es-un-run"]) {
      await mkdir(join(root, id, "input"), { recursive: true });
    }
    const now = Date.now();
    const old = new Date(now - STAGING_MAX_AGE_MS - 60_000);
    await utimes(join(root, viejo), old, old);

    const removed = await staging().cleanup(async (id) => id === terminado, now);

    expect(removed.sort()).toEqual([terminado, viejo].sort());
    expect((await readdir(root)).sort()).toEqual([abierto, "no-es-un-run"].sort());
  });

  it("sin directorio de staging, no hay nada que limpiar", async () => {
    expect(await staging().cleanup(async () => true)).toEqual([]);
  });
});
