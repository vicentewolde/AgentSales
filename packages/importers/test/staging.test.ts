import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, isAppError, type UploadImportRunInput } from "@agentsales/core";
import { createInMemoryMediaStorage } from "@agentsales/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaging, STAGING_MAX_AGE_MS, STAGING_ORPHAN_GRACE_MS } from "../src/staging.js";
import { buildWorkbook, syntheticRow } from "./workbook.js";
import { buildZip } from "./zip-builder.js";

// El worker baja de R2 la planilla y los medios de cada intento (spec F8 §4.4, F8-T05): R2 es el
// doble en memoria de core; el disco es una carpeta temporal del test.

const RUN_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let work: string;
let root: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "agentsales-staging-"));
  root = join(work, "tmp", "imports");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function setup(options: { failFirstReads?: number } = {}) {
  const storage = createInMemoryMediaStorage();
  let failing = options.failFirstReads ?? 0;
  const getStream = storage.getStream.bind(storage);
  // Un corte de R2 al pedir los primeros archivos (reintentable).
  storage.getStream = async (path, opts) => {
    if (failing > 0) {
      failing -= 1;
      throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
    }
    return getStream(path, opts);
  };
  const staging = createStaging({ root, storage, maxVideoBytes: 1024 * 1024 });
  return { storage, staging };
}

const prefix = `imports/${RUN_ID}/`;

async function xlsxInput(storage: ReturnType<typeof setup>["storage"]) {
  const bytes = await buildWorkbook({ listings: { rows: [syntheticRow()] } });
  const key = `${prefix}xlsx/propiedades.xlsx`;
  await storage.put(key, bytes, "x");
  return { key, name: "propiedades.xlsx", size: bytes.byteLength, sha256: sha256(bytes) };
}

/** Lo que queda del run en el disco del worker (los directorios de los intentos). */
const attemptDirs = async () => readdir(join(root, RUN_ID)).catch(() => [] as string[]);

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

describe("createStaging · readSheet", () => {
  it("baja la planilla de R2 a un directorio del intento, la lee y lo borra", async () => {
    const { storage, staging } = setup();
    const xlsx = await xlsxInput(storage);

    const sheet = await staging.readSheet({
      runId: RUN_ID,
      input: { broker: null, dryRun: false, xlsx, media: null },
    });

    expect(sheet.rows[0]?.raw).toMatchObject({ id_propiedad: "P001" });
    expect(await attemptDirs()).toEqual([]);
  });

  it("un archivo distinto del anunciado (otro sha256) es IMPORT_FILE_INVALID, sin abrirlo", async () => {
    const { storage, staging } = setup();
    const xlsx = await xlsxInput(storage);

    const error = await caught(
      staging.readSheet({
        runId: RUN_ID,
        input: {
          broker: null,
          dryRun: false,
          xlsx: { ...xlsx, sha256: "0".repeat(64) },
          media: null,
        },
      }),
    );

    expect(error).toMatchObject({ code: "IMPORT_FILE_INVALID" });
    expect(await attemptDirs()).toEqual([]);
  });

  it("si ya no está en R2: IMPORT_FILE_NOT_FOUND, no reintentable", async () => {
    const { staging } = setup();
    const error = await caught(
      staging.readSheet({
        runId: RUN_ID,
        input: {
          broker: null,
          dryRun: false,
          xlsx: { key: `${prefix}xlsx/p.xlsx`, name: "p.xlsx", size: 1, sha256: "0".repeat(64) },
          media: null,
        },
      }),
    );
    expect(error).toMatchObject({ code: "IMPORT_FILE_NOT_FOUND", retriable: false });
  });

  it("un corte de R2 se propaga como reintentable, y el intento siguiente la baja de nuevo", async () => {
    const { storage, staging } = setup({ failFirstReads: 1 });
    const xlsx = await xlsxInput(storage);
    const input: UploadImportRunInput = { broker: null, dryRun: false, xlsx, media: null };

    expect(await caught(staging.readSheet({ runId: RUN_ID, input }))).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
    });
    expect(await attemptDirs()).toEqual([]);
    expect((await staging.readSheet({ runId: RUN_ID, input })).rows).toHaveLength(1);
  });
});

describe("createStaging · openMedia", () => {
  it("sin medios, no hay fuente", async () => {
    const { staging } = setup();
    expect(
      (await staging.openMedia({ runId: RUN_ID, media: null, folders: [] })).source,
    ).toBeNull();
  });

  it("un zip se baja, se extrae en un directorio del intento (sin guardar el zip) y se borra al cerrar", async () => {
    const { storage, staging } = setup();
    const zip = buildZip([{ name: "medios/P001/foto.jpg", data: new Uint8Array(JPEG) }]);
    await storage.put(`${prefix}media.zip`, new Uint8Array(zip), "application/zip");

    const media = await staging.openMedia({
      runId: RUN_ID,
      media: { kind: "zip", key: `${prefix}media.zip`, name: "medios.zip", size: zip.byteLength },
      folders: ["P001"],
    });

    // macOS → Comprimir "medios": la carpeta envolvente se reconoce como raíz.
    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
    const [dir] = await attemptDirs();
    expect(await readdir(join(root, RUN_ID, dir ?? ""))).toEqual(["extraido"]);
    await media.close();
    expect(await attemptDirs()).toEqual([]);
  });

  it("una carpeta se baja archivo por archivo con sus rutas", async () => {
    const { storage, staging } = setup();
    await storage.put(`${prefix}media/P001/foto.jpg`, new Uint8Array(JPEG), "x");
    await storage.put(`${prefix}media/_marca/logo.jpg`, new Uint8Array(JPEG), "x");

    const media = await staging.openMedia({
      runId: RUN_ID,
      media: {
        kind: "folder",
        prefix: `${prefix}media/`,
        name: "medios",
        files: [
          { path: "P001/foto.jpg", size: JPEG.byteLength, sha256: sha256(JPEG) },
          { path: "_marca/logo.jpg", size: JPEG.byteLength },
        ],
      },
      folders: ["P001", "_marca"],
    });

    expect((await media.source?.list("P001"))?.files.map((file) => file.relPath)).toEqual([
      "P001/foto.jpg",
    ]);
    expect((await media.source?.list("_marca"))?.files).toHaveLength(1);
    await media.close();
    expect(await attemptDirs()).toEqual([]);
  });

  it("un archivo que falta o con otro tamaño no deja nada a medias", async () => {
    const { storage, staging } = setup();
    await storage.put(`${prefix}media/P001/a.jpg`, new Uint8Array(JPEG), "x");

    const error = await caught(
      staging.openMedia({
        runId: RUN_ID,
        media: {
          kind: "folder",
          prefix: `${prefix}media/`,
          name: "medios",
          files: [
            { path: "P001/a.jpg", size: JPEG.byteLength + 1 },
            { path: "P001/b.jpg", size: 3 },
          ],
        },
        folders: ["P001"],
      }),
    );

    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
    expect(await attemptDirs()).toEqual([]);
  });

  it("una ruta que sale de la carpeta se rechaza aunque llegue a la base (segunda barrera)", async () => {
    const { staging } = setup();
    const error = await caught(
      staging.openMedia({
        runId: RUN_ID,
        media: {
          kind: "folder",
          prefix: `${prefix}media/`,
          name: "medios",
          files: [{ path: "../../fuera.jpg", size: 1 }],
        },
        folders: [],
      }),
    );
    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
  });

  it("dos intentos solapados no se pisan: cada uno tiene su directorio", async () => {
    const { storage, staging } = setup();
    const zip = buildZip([{ name: "P001/foto.jpg", data: new Uint8Array(JPEG) }]);
    await storage.put(`${prefix}media.zip`, new Uint8Array(zip), "x");
    const media = {
      kind: "zip" as const,
      key: `${prefix}media.zip`,
      name: "m.zip",
      size: zip.byteLength,
    };

    const first = await staging.openMedia({ runId: RUN_ID, media, folders: ["P001"] });
    const second = await staging.openMedia({ runId: RUN_ID, media, folders: ["P001"] });
    expect(await attemptDirs()).toHaveLength(2);
    await first.close();
    expect((await second.source?.list("P001"))?.files).toHaveLength(1);
    await second.close();
  });
});

describe("createStaging · discard y cleanup", () => {
  it("discard borra lo de la carga en R2 y en el disco, sin tocar otras cargas", async () => {
    const { storage, staging } = setup();
    await storage.put(`${prefix}xlsx/p.xlsx`, new Uint8Array([1]), "x");
    await storage.put(`${prefix}media/P001/a.jpg`, new Uint8Array([1]), "x");
    await storage.put("imports/otra/xlsx/p.xlsx", new Uint8Array([1]), "x");
    await mkdir(join(root, RUN_ID, "media-x"), { recursive: true });

    await staging.discard(RUN_ID);

    expect(await storage.list(prefix)).toEqual([]);
    expect(await storage.list("imports/otra/")).toHaveLength(1);
    expect(await exists(join(root, RUN_ID))).toBe(false);
    await staging.discard(RUN_ID);
  });

  it("un id que no es uuid no arma rutas: IMPORT_RUN_INVALID", async () => {
    const { staging } = setup();
    const error = await caught(staging.discard("../../etc"));
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
      await mkdir(join(root, id, "media-x"), { recursive: true });
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
    const { staging } = setup();
    const now = Date.now();
    await seedStaging(now);
    const states: Record<string, "open" | "closed" | "missing"> = {
      [ids.cerrado]: "closed",
      [ids.abierto]: "open",
      [ids.huerfanoReciente]: "missing",
      [ids.huerfanoViejo]: "missing",
    };

    const removed = await staging.cleanup(async (id) => {
      if (id === ids.sinBase) throw new Error("DB_UNAVAILABLE");
      return states[id] ?? "open";
    }, now);

    expect(removed.sort()).toEqual([ids.cerrado, ids.viejo, ids.huerfanoViejo].sort());
    expect((await readdir(root)).sort()).toEqual(
      [ids.abierto, ids.huerfanoReciente, ids.sinBase, "no-es-un-run"].sort(),
    );
  });

  it("sin la base (antes de conectar), solo borra por antigüedad", async () => {
    const { staging } = setup();
    const now = Date.now();
    await seedStaging(now);

    expect(await staging.cleanup(undefined, now)).toEqual([ids.viejo]);
  });

  it("sin directorio de staging, no hay nada que limpiar", async () => {
    const { staging } = setup();
    expect(await staging.cleanup(async () => "closed")).toEqual([]);
  });
});
