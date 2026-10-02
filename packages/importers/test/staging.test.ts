import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaging, STAGING_MAX_AGE_MS, STAGING_ORPHAN_GRACE_MS } from "../src/staging.js";
import { buildZip } from "./zip-builder.js";

const RUN_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

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

const open = (mediaDir: string | null, folders: readonly string[] = ["P001"], runId = RUN_ID) =>
  staging().openMedia({ runId, mediaDir, folders });

/** Directorios `extracted-*` del run (uno por intento en curso). */
const extractedDirs = async () =>
  (await readdir(join(root, RUN_ID)).catch(() => [] as string[])).filter((name) =>
    name.startsWith("extracted-"),
  );

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
  await writeFile(
    path,
    buildZip(Object.entries(files).map(([name, data]) => ({ name, data: new Uint8Array(data) }))),
  );
  return path;
}

describe("createStaging · openMedia", () => {
  it("sin mediaDir, no hay fuente de medios", async () => {
    const media = await open(null);
    expect(media.source).toBeNull();
  });

  it("una carpeta se lee tal cual, sin tocar el staging", async () => {
    await mkdir(join(work, "medios", "P001"), { recursive: true });
    await writeFile(join(work, "medios", "P001", "foto.jpg"), JPEG);

    const media = await open(join(work, "medios"));

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
    expect(await exists(root)).toBe(false);
  });

  it("un zip se extrae en un directorio del intento, que se borra al cerrar; input/ se conserva", async () => {
    const input = join(root, RUN_ID, "input");
    await mkdir(input, { recursive: true });
    await writeFile(join(input, "propiedades.xlsx"), "subido por la API");
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    const media = await open(zip);

    expect((await media.source?.list("P001"))?.files).toHaveLength(1);
    expect(await extractedDirs()).toHaveLength(1);
    await media.close();
    expect(await extractedDirs()).toEqual([]);
    expect(await readdir(input)).toEqual(["propiedades.xlsx"]);
  });

  it("dos intentos solapados no se pisan: cada uno tiene su directorio", async () => {
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });
    const first = await open(zip);
    const second = await open(zip);
    expect(await extractedDirs()).toHaveLength(2);

    await first.close();

    expect((await second.source?.list("P001"))?.files).toHaveLength(1);
    await second.close();
  });

  it("un zip que falla a mitad: IMPORT_FILE_INVALID, sin dejar su directorio y conservando input/", async () => {
    const input = join(root, RUN_ID, "input");
    await mkdir(input, { recursive: true });
    // La primera entrada ya se escribió cuando aparece la ruta hostil.
    const zip = await writeZip("roto.zip", { "P001/foto.jpg": JPEG, "../fuera.txt": JPEG });

    const error = await caught(open(zip));

    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
    expect(await extractedDirs()).toEqual([]);
    expect(await exists(input)).toBe(true);
  });

  it("un zip con todo dentro de una carpeta (macOS → Comprimir) usa esa carpeta como raíz", async () => {
    const zip = await writeZip("medios.zip", {
      "medios/P001/foto.jpg": JPEG,
      "medios/_marca/logo.jpg": JPEG,
    });

    const media = await open(zip, ["P001", "_marca"]);

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
  });

  it("carpetas pedidas vacías o con .. no impiden desenvolver el zip", async () => {
    const zip = await writeZip("medios.zip", { "medios/P001/foto.jpg": JPEG });

    const media = await open(zip, ["", ".", "..", "P001"]);

    expect((await media.source?.list("P001"))?.files).toHaveLength(1);
  });

  it("un zip con una sola propiedad en la raíz no se desenvuelve", async () => {
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    const media = await open(zip);

    expect((await media.source?.list("P001"))?.files).toHaveLength(1);
  });

  it.each([
    ["no existe", "nada.zip", "IMPORT_FILE_NOT_FOUND"],
    ["no es carpeta ni zip", "medios.txt", "IMPORT_FILE_INVALID"],
  ])("unos medios que %s → %s, con el nombre y sin la ruta", async (_, name, code) => {
    if (name.endsWith(".txt")) await writeFile(join(work, name), "texto");

    const error = await caught(open(join(work, name)));

    expect(isAppError(error) && error.code).toBe(code);
    expect(isAppError(error) && error.message).toContain(name);
    expect(isAppError(error) && error.message).not.toContain(work);
  });
});

describe("createStaging · saveInput", () => {
  it("guarda en input/ con solo el nombre del archivo y devuelve la ruta absoluta", async () => {
    const path = await staging().saveInput(
      RUN_ID,
      "../../propiedades.xlsx",
      new Uint8Array([1, 2]),
    );

    expect(path).toBe(join(root, RUN_ID, "input", "propiedades.xlsx"));
    expect(staging().inputDirOf(RUN_ID)).toBe(join(root, RUN_ID, "input"));
    expect(await readdir(join(root, RUN_ID, "input"))).toEqual(["propiedades.xlsx"]);
  });

  it("un nombre con barras de Windows tampoco sale de input/", async () => {
    const path = await staging().saveInput(RUN_ID, "C:\\temp\\medios.zip", new Uint8Array([1]));
    expect(path).toBe(join(root, RUN_ID, "input", "medios.zip"));
  });

  it.each(["", "..", "  "])("un nombre inválido (%j) es IMPORT_FILE_INVALID", async (name) => {
    const error = await caught(staging().saveInput(RUN_ID, name, new Uint8Array([1])));
    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
  });
});

describe("createStaging · discard y cleanup", () => {
  it("discard borra todo el directorio del run, y no falla si no existe", async () => {
    await mkdir(join(root, RUN_ID, "input"), { recursive: true });
    await staging().discard(RUN_ID);
    expect(await exists(join(root, RUN_ID))).toBe(false);
    await staging().discard(RUN_ID);
  });

  it("discard y close nunca tocan los archivos del operador (--media y el xlsx de la CLI)", async () => {
    await mkdir(join(work, "medios", "P001"), { recursive: true });
    await writeFile(join(work, "medios", "P001", "foto.jpg"), JPEG);
    await writeFile(join(work, "propiedades.xlsx"), "del operador");
    const zip = await writeZip("medios.zip", { "P001/foto.jpg": JPEG });

    await (await open(join(work, "medios"))).close();
    await (await open(zip)).close();
    await staging().discard(RUN_ID);

    expect(await exists(join(work, "medios", "P001", "foto.jpg"))).toBe(true);
    expect(await exists(join(work, "propiedades.xlsx"))).toBe(true);
    expect(await exists(zip)).toBe(true);
  });

  it("un id que no es uuid no arma rutas: IMPORT_RUN_INVALID", async () => {
    const error = await caught(staging().discard("../../etc"));
    expect(isAppError(error) && error.code).toBe("IMPORT_RUN_INVALID");
  });

  const ids = {
    cerrado: "11111111-1111-4111-8111-111111111111",
    abierto: "22222222-2222-4222-8222-222222222222",
    viejo: "33333333-3333-4333-8333-333333333333",
    huerfanoReciente: "44444444-4444-4444-8444-444444444444",
    huerfanoViejo: "55555555-5555-4555-8555-555555555555",
    sinBase: "66666666-6666-4666-8666-666666666666",
  };

  async function seedStaging(now: number) {
    for (const id of [...Object.values(ids), "no-es-un-run"]) {
      await mkdir(join(root, id, "input"), { recursive: true });
    }
    const ago = (ms: number) => new Date(now - ms);
    await utimes(
      join(root, ids.viejo),
      ago(STAGING_MAX_AGE_MS + 60_000),
      ago(STAGING_MAX_AGE_MS + 60_000),
    );
    const orphan = ago(STAGING_ORPHAN_GRACE_MS + 60_000);
    await utimes(join(root, ids.huerfanoViejo), orphan, orphan);
  }

  it("borra los terminados, los de más de 24 h y los huérfanos viejos; si la base falla en uno, sigue", async () => {
    const now = Date.now();
    await seedStaging(now);
    const states: Record<string, "open" | "closed" | "missing"> = {
      [ids.cerrado]: "closed",
      [ids.abierto]: "open",
      [ids.huerfanoReciente]: "missing",
      [ids.huerfanoViejo]: "missing",
    };

    const removed = await staging().cleanup(async (id) => {
      if (id === ids.sinBase) throw new Error("DB_UNAVAILABLE");
      return states[id] ?? "open";
    }, now);

    expect(removed.sort()).toEqual([ids.cerrado, ids.viejo, ids.huerfanoViejo].sort());
    expect((await readdir(root)).sort()).toEqual(
      [ids.abierto, ids.huerfanoReciente, ids.sinBase, "no-es-un-run"].sort(),
    );
  });

  it("sin la base (antes de conectar), solo borra por antigüedad", async () => {
    const now = Date.now();
    await seedStaging(now);

    expect(await staging().cleanup(undefined, now)).toEqual([ids.viejo]);
  });

  it("sin directorio de staging, no hay nada que limpiar", async () => {
    expect(await staging().cleanup(async () => "closed")).toEqual([]);
  });
});
