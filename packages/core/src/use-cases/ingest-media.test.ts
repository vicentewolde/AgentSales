import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import { importReportSchema } from "../import-run.js";
import type { ListingSheetInput, ListingSheetRow } from "../listing-sheet.js";
import type { SkippedMediaFile } from "../ports/media-file-source.js";
import { createInMemoryFieldDefinitionRepository } from "../testing/field-definition-repository.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
} from "../testing/import-repositories.js";
import {
  createInMemoryMediaFileSource,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  type InMemoryMediaRepositoryOptions,
  type InMemoryMediaStorageOptions,
  memoryFile,
} from "../testing/media.js";
import { importListings } from "./import-listings.js";
import { ingestMedia } from "./ingest-media.js";

let nextDef = 0;
const def = (
  key: string,
  type: FieldDefinition["type"],
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id: `def-${++nextDef}`,
  brokerId: null,
  category: "real_estate",
  key,
  label: key,
  type,
  required: false,
  options: null,
  sourceColumn: key,
  isCore: true,
  sortOrder: nextDef * 10,
  active: true,
  ...overrides,
});

const DEFS: FieldDefinition[] = [
  def("id_propiedad", "text", { required: true }),
  def("operacion", "enum", { options: ["Venta", "Arriendo"] }),
  def("precio", "number", { required: true }),
  def("moneda", "enum", { required: true, options: ["UF", "CLP"] }),
  def("estado_carga", "enum", { options: ["Borrador", "Listo"] }),
  def("carpeta_medios", "text"),
  def("foto_portada", "text"),
];
const HEADERS = DEFS.map((d) => d.sourceColumn);

/** Hoja Corredor sintética (datos inventados). */
const BROKER_SHEET = {
  nombre_corredor: "Persona Inventada",
  nombre_marca: "Marca Inventada",
  color_primario: "#112233",
  logo: "logo.png",
};

const row = (rowNumber: number, overrides: Record<string, unknown> = {}): ListingSheetRow => ({
  rowNumber,
  raw: {
    id_propiedad: `P00${rowNumber - 1}`,
    operacion: "Venta",
    precio: 5800,
    moneda: "UF",
    estado_carga: "Listo",
    carpeta_medios: null,
    foto_portada: null,
    ...overrides,
  },
});

const sheet = (
  rows: ListingSheetRow[],
  broker: Record<string, unknown> | null = BROKER_SHEET,
): ListingSheetInput => ({ headers: HEADERS, rows, broker });

const PHOTOS = {
  foto1: memoryFile("P001/foto1.jpg", "foto-uno"),
  foto2: memoryFile("P001/foto2.png", "foto-dos"),
  foto10: memoryFile("P001/foto10.heic", "foto-diez"),
  video: memoryFile("P001/recorrido.mp4", "video-uno"),
};
const INVALID: SkippedMediaFile = { relPath: "P001/notas.txt", reason: "unsupported_type" };
const LOGO = memoryFile("_marca/logo.png", "logo-marca");

type Folders = Parameters<typeof createInMemoryMediaFileSource>[0];
const P001: Folders = {
  P001: { files: [PHOTOS.foto1, PHOTOS.foto2, PHOTOS.foto10, PHOTOS.video], skipped: [INVALID] },
  _marca: { files: [LOGO] },
};

/** Dependencias en memoria compartidas entre cargas, como en la base real. */
function setup(
  storageOptions: InMemoryMediaStorageOptions = {},
  mediaOptions: InMemoryMediaRepositoryOptions = {},
) {
  const deps = {
    brokers: createInMemoryBrokerRepository(),
    listings: createInMemoryListingRepository(),
    importRuns: createInMemoryImportRunRepository(),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(DEFS),
    media: createInMemoryMediaRepository(mediaOptions),
    storage: createInMemoryMediaStorage(storageOptions),
    sha256: async (text: string) => `hash:${text}`,
  };
  /** Una carga completa: `importListings` y después `ingestMedia`, en el mismo run. */
  const load = async (
    input: ListingSheetInput,
    folders: Folders | null,
    { dryRun = false } = {},
  ) => {
    const run = await deps.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun,
      input: { xlsxPath: "/tmp/propiedades.xlsx", mediaDir: "/tmp/medios", broker: null },
    });
    const imported = await importListings(deps, { runId: run.id, input });
    const source = folders === null ? null : createInMemoryMediaFileSource(folders);
    const result = await ingestMedia(deps, { runId: run.id, imported, source });
    return { runId: run.id, imported, result, source };
  };
  const listing = (externalRef = "P001") => {
    const found = deps.listings.all().find((item) => item.externalRef === externalRef);
    if (found === undefined) throw new Error(`no existe ${externalRef}`);
    return found;
  };
  /** Medios del aviso, en orden, como `[relPath abreviado, isCover]`. */
  const arrangement = (externalRef = "P001") =>
    deps.media
      .all()
      .filter((media) => media.listingId === listing(externalRef).id)
      .map((media) => [media.checksum.replace("sha256-", ""), media.isCover]);
  return { deps, load, listing, arrangement };
}

const warningsOf = (report: { rows: { warnings: string[] }[] }, index = 0) =>
  report.rows[index]?.warnings ?? [];

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
}

describe("ingestMedia · subida", () => {
  it("sube los 4 archivos válidos con su tipo; el inválido va al reporte", async () => {
    const { deps, load, listing, arrangement } = setup();

    const { result, runId } = await load(sheet([row(2)]), P001);

    const { id: listingId, brokerId } = listing();
    const base = `brokers/${brokerId}/listings/${listingId}/original`;
    expect(deps.storage.uploads.filter((path) => path.includes("/listings/"))).toEqual([
      `${base}/sha256-foto-uno.jpg`,
      `${base}/sha256-foto-dos.png`,
      `${base}/sha256-foto-diez.heic`,
      `${base}/sha256-video-uno.mp4`,
    ]);
    expect(deps.storage.objects.get(`${base}/sha256-video-uno.mp4`)?.contentType).toBe("video/mp4");
    expect(
      deps.media
        .all()
        .filter((media) => media.listingId === listingId)
        .map(({ kind, mime, bytes, sortOrder }) => ({ kind, mime, bytes, sortOrder })),
    ).toEqual([
      { kind: "image", mime: "image/jpeg", bytes: 8, sortOrder: 0 },
      { kind: "image", mime: "image/png", bytes: 8, sortOrder: 1 },
      { kind: "image", mime: "image/heic", bytes: 9, sortOrder: 2 },
      { kind: "video", mime: "video/mp4", bytes: 9, sortOrder: 3 },
    ]);
    // Sin `foto_portada`, la portada es la primera foto.
    expect(arrangement()).toEqual([
      ["foto-uno", true],
      ["foto-dos", false],
      ["foto-diez", false],
      ["video-uno", false],
    ]);
    expect(listing().status).toBe("ready");
    expect(result.media).toEqual({
      filesUploaded: 4,
      filesExisting: 0,
      filesSkipped: 1,
      filesFailed: 0,
    });
    expect(warningsOf(result.report)).toEqual([
      "P001/notas.txt: tipo de archivo no admitido (jpg, png, webp, heic, mp4 o mov)",
    ]);
    // El reporte queda en el run, y sigue validando con su esquema.
    const run = await deps.importRuns.get(runId);
    expect(run?.report).toEqual(result.report);
    expect(importReportSchema.parse(run?.report)).toEqual(result.report);
  });

  it("reimportar no vuelve a subir nada (deduplicación por sha256)", async () => {
    const { deps, load } = setup();
    await load(sheet([row(2)]), P001);
    const uploads = deps.storage.uploads.length;

    const { result, imported } = await load(sheet([row(2)]), P001);

    expect(imported.rows[0]?.outcome).toBe("skipped");
    expect(deps.storage.uploads).toHaveLength(uploads);
    expect(deps.media.all()).toHaveLength(5); // 4 del aviso + el logo
    expect(result.media).toMatchObject({ filesUploaded: 0, filesExisting: 4 });
  });

  it("agregar una foto a una propiedad sin cambios (skipped) la sube, en su lugar del orden", async () => {
    const { deps, load, arrangement } = setup();
    await load(sheet([row(2)]), P001);
    const foto3 = memoryFile("P001/foto3.jpg", "foto-tres");

    const { result, imported } = await load(sheet([row(2)]), {
      P001: { files: [PHOTOS.foto1, PHOTOS.foto2, foto3, PHOTOS.foto10, PHOTOS.video] },
    });

    expect(imported.rows[0]?.outcome).toBe("skipped");
    expect(result.media).toMatchObject({ filesUploaded: 1, filesExisting: 4 });
    expect(deps.storage.uploads.at(-1)).toContain("sha256-foto-tres.jpg");
    expect(arrangement()).toEqual([
      ["foto-uno", true],
      ["foto-dos", false],
      ["foto-tres", false],
      ["foto-diez", false],
      ["video-uno", false],
    ]);
  });

  it("usa carpeta_medios en vez de id_propiedad, y no toca las filas con error", async () => {
    const { load } = setup();
    const foto = memoryFile("depto-101/foto.jpg", "foto-depto");

    const { source, imported } = await load(
      sheet([row(2, { carpeta_medios: "depto-101" }), row(3, { precio: "no es número" })]),
      { "depto-101": { files: [foto] }, _marca: { files: [LOGO] } },
    );

    expect(imported.rows.map((item) => item.outcome)).toEqual(["created", "failed"]);
    expect(source?.listed).toEqual(["_marca", "depto-101"]);
  });

  it("dos archivos idénticos en la carpeta: se sube uno y el otro es advertencia", async () => {
    const { load } = setup();
    const copia = memoryFile("P001/copia.jpg", "foto-uno");

    const { result } = await load(sheet([row(2)]), {
      P001: { files: [PHOTOS.foto1, copia] },
    });

    expect(result.media).toMatchObject({ filesUploaded: 1, filesSkipped: 1 });
    expect(warningsOf(result.report)).toEqual([
      "P001/copia.jpg: es el mismo archivo que P001/foto1.jpg",
    ]);
  });

  it("los medios que ya no están en la carpeta se conservan, al final y sin portada", async () => {
    const { load, arrangement } = setup();
    await load(sheet([row(2)]), P001);

    await load(sheet([row(2)]), { P001: { files: [PHOTOS.foto2, PHOTOS.video] } });

    expect(arrangement()).toEqual([
      ["foto-dos", true],
      ["video-uno", false],
      ["foto-uno", false],
      ["foto-diez", false],
    ]);
  });
});

describe("ingestMedia · sin carpeta legible se conservan orden y portada", () => {
  it.each([
    ["sin carpeta de medios (sin --media)", null],
    [
      "con la carpeta ilegible (MEDIA_FOLDER_UNREADABLE)",
      {
        P001: new AppError(
          "MEDIA_FOLDER_UNREADABLE",
          'No se pudo leer la carpeta de medios "P001"',
        ),
        _marca: { files: [LOGO] },
      },
    ],
  ] as const)("reimportar %s no cambia la portada elegida", async (_, folders) => {
    const { deps, load, arrangement } = setup();
    await load(sheet([row(2, { foto_portada: "foto2.png" })]), P001);
    const before = arrangement();
    const calls = deps.media.arrangeCalls();

    const { result } = await load(
      sheet([row(2, { foto_portada: "foto2.png", precio: 6100 })]),
      folders as Folders | null,
    );

    expect(arrangement()).toEqual(before);
    expect(deps.media.arrangeCalls()).toBe(calls);
    expect(warningsOf(result.report).join(" | ")).not.toContain("foto_portada");
  });

  it("una carpeta con solo videos conserva la portada anterior, con advertencia", async () => {
    const { load, arrangement } = setup();
    await load(sheet([row(2, { foto_portada: "foto2.png" })]), P001);

    const { result } = await load(sheet([row(2, { foto_portada: "foto2.png" })]), {
      P001: { files: [PHOTOS.video] },
    });

    expect(arrangement()).toEqual([
      ["video-uno", false],
      ["foto-uno", false],
      ["foto-dos", true],
      ["foto-diez", false],
    ]);
    expect(warningsOf(result.report)).toEqual([
      "foto_portada «foto2.png» no está entre los medios de la carpeta; se conserva la portada anterior",
    ]);
  });

  it("reimportar sin cambios no vuelve a escribir orden ni portada", async () => {
    const { deps, load } = setup();
    await load(sheet([row(2)]), P001);
    const calls = deps.media.arrangeCalls();

    await load(sheet([row(2)]), P001);

    expect(deps.media.arrangeCalls()).toBe(calls);
  });

  it("una fila updated que cambia carpeta_medios: lo nuevo primero; lo anterior, al final sin portada", async () => {
    const { load, arrangement } = setup();
    await load(sheet([row(2)]), { P001: { files: [PHOTOS.foto1, PHOTOS.foto2] } });
    const nueva = memoryFile("nueva/foto3.jpg", "foto-tres");

    const { imported } = await load(sheet([row(2, { carpeta_medios: "nueva" })]), {
      nueva: { files: [nueva] },
    });

    expect(imported.rows[0]?.outcome).toBe("updated");
    expect(arrangement()).toEqual([
      ["foto-tres", true],
      ["foto-uno", false],
      ["foto-dos", false],
    ]);
  });
});

describe("ingestMedia · portada y estado", () => {
  it("cambiar foto_portada desmarca la portada anterior", async () => {
    const { load, arrangement } = setup();
    await load(sheet([row(2, { foto_portada: "foto2.png" })]), P001);
    expect(arrangement().filter(([, cover]) => cover)).toEqual([["foto-dos", true]]);

    await load(sheet([row(2, { foto_portada: "FOTO10.HEIC" })]), P001);

    expect(arrangement().filter(([, cover]) => cover)).toEqual([["foto-diez", true]]);
  });

  it.each([
    ["no está en la carpeta", "no-existe.jpg", "no está entre los medios de la carpeta"],
    ["es un video", "recorrido.mp4", "no es una foto"],
  ])("foto_portada que %s: advertencia y la primera foto", async (_, coverFile, message) => {
    const { load, arrangement } = setup();

    const { result } = await load(sheet([row(2, { foto_portada: coverFile })]), P001);

    expect(arrangement()[0]).toEqual(["foto-uno", true]);
    expect(warningsOf(result.report)).toContain(
      `foto_portada «${coverFile}» ${message}; se usa foto1.jpg`,
    );
  });

  it("una propiedad sin fotos queda en draft con advertencia (un video no basta)", async () => {
    const { load, listing } = setup();

    const { result } = await load(sheet([row(2)]), { P001: { files: [PHOTOS.video] } });

    expect(listing().status).toBe("draft");
    expect(warningsOf(result.report)).toEqual([
      "Sin fotos: el aviso queda en borrador (hace falta al menos una para «Listo»)",
    ]);
  });

  it("sin carpeta: advertencia de la carpeta y queda en draft", async () => {
    const { load, listing } = setup();

    const { result } = await load(sheet([row(2)]), { _marca: { files: [LOGO] } });

    expect(listing().status).toBe("draft");
    expect(warningsOf(result.report)).toEqual([
      'No existe la carpeta de medios "P001"',
      "Sin fotos: el aviso queda en borrador (hace falta al menos una para «Listo»)",
    ]);
  });

  it("una carpeta no válida (MEDIA_FOLDER_INVALID) es advertencia de su fila", async () => {
    const { load } = setup();

    const { result } = await load(sheet([row(2, { carpeta_medios: "../afuera" })]), {
      "../afuera": new AppError(
        "MEDIA_FOLDER_INVALID",
        'La carpeta de medios "../afuera" no es válida',
      ),
    });

    expect(warningsOf(result.report)[0]).toBe('La carpeta de medios "../afuera" no es válida');
  });

  it("con estado_carga vacío (borrador) sube las fotos pero no pasa a ready", async () => {
    const { load, listing } = setup();

    const { result } = await load(sheet([row(2, { estado_carga: null })]), P001);

    expect(listing().status).toBe("draft");
    expect(result.media.filesUploaded).toBe(4);
    expect(warningsOf(result.report)).not.toContain(
      "Sin fotos: el aviso queda en borrador (hace falta al menos una para «Listo»)",
    );
  });

  it.each([
    ["sin fotos", [PHOTOS.video]],
    ["con fotos", [PHOTOS.foto1, PHOTOS.video]],
  ])(
    "un aviso puesto a mano en paused (%s) no se toca ni recibe la advertencia",
    async (_, files) => {
      const { deps, load, listing } = setup();
      await load(sheet([row(2, { estado_carga: null })]), { P001: { files } });
      deps.listings.setStatus(listing().id, "paused");

      const { result } = await load(sheet([row(2)]), { P001: { files } });

      expect(listing().status).toBe("paused");
      expect(warningsOf(result.report)).toEqual([]);
    },
  );

  it("dry_run de un aviso nuevo sin fotos también advierte que quedaría en borrador", async () => {
    const { load } = setup();

    const { result } = await load(
      sheet([row(2)]),
      { P001: { files: [PHOTOS.video] } },
      {
        dryRun: true,
      },
    );

    expect(warningsOf(result.report)).toEqual([
      "Sin fotos: el aviso queda en borrador (hace falta al menos una para «Listo»)",
    ]);
  });

  it("sin carpeta de medios, las fotos que el aviso ya tenía bastan para pasar a ready", async () => {
    const { deps, load, listing } = setup();
    await load(sheet([row(2, { estado_carga: null })]), P001);
    expect(listing().status).toBe("draft");
    const uploads = deps.storage.uploads.length;

    await load(sheet([row(2)]), null);

    expect(listing().status).toBe("ready");
    expect(deps.storage.uploads).toHaveLength(uploads);
  });
});

describe("ingestMedia · fallos", () => {
  it.each([
    [
      "se borró (MEDIA_FILE_UNREADABLE)",
      { openError: new AppError("MEDIA_FILE_UNREADABLE", "No se pudo leer P001/foto2.png") },
    ],
    ["cambió de largo (STORAGE_CONTENT_MISMATCH)", { openBytes: new Uint8Array(3) }],
  ])("un archivo que %s es advertencia y los demás suben", async (cause, options) => {
    const { deps, load } = setup();
    const broken = memoryFile("P001/foto2.png", "foto-dos", options);

    const { result } = await load(sheet([row(2)]), {
      P001: { files: [PHOTOS.foto1, broken, PHOTOS.video] },
    });

    expect(result.media).toMatchObject({ filesUploaded: 2, filesFailed: 1 });
    const text = cause.startsWith("se borró")
      ? "no se pudo leer el archivo"
      : "el archivo cambió mientras se subía";
    expect(warningsOf(result.report)).toEqual([`P001/foto2.png: no se pudo subir (${text})`]);
    // La clave interna en R2 no llega al reporte (lo leen el operador, la CLI y el panel).
    expect(JSON.stringify(result.report)).not.toContain("brokers/");
    expect(deps.storage.uploads.some((path) => path.includes("foto-dos"))).toBe(false);
  });

  it.each([
    ["MEDIA_CONFLICT (otro intento del job lo insertó)", "MEDIA_CONFLICT"],
    ["DB_UNAVAILABLE después de subir a R2", "DB_UNAVAILABLE"],
  ])("%s se propaga; el reintento sobrescribe la misma clave y registra", async (_, code) => {
    let failing = true;
    const { deps, load } = setup(
      {},
      {
        failCreate: (media) =>
          failing && media.checksum === "sha256-foto-dos"
            ? new AppError(code, "falla simulada", { retriable: true })
            : undefined,
      },
    );

    await expectAppError(load(sheet([row(2)]), P001), code);
    const fotoDos = deps.storage.uploads.filter((path) => path.includes("foto-dos"));
    expect(fotoDos).toHaveLength(1);

    failing = false;
    const { result } = await load(sheet([row(2)]), P001);

    expect(result.media).toMatchObject({ filesUploaded: 3, filesExisting: 1, filesFailed: 0 });
    // La misma clave, otra vez: se sobrescribe, no se crea otra.
    expect(deps.storage.uploads.filter((path) => path.includes("foto-dos"))).toEqual([
      ...fotoDos,
      ...fotoDos,
    ]);
    expect(deps.media.all().filter((media) => media.listingId !== null)).toHaveLength(4);
  });

  it("R2 caído (STORAGE_UNAVAILABLE) se propaga; el reintento retoma sin duplicar", async () => {
    let r2Down = true;
    const { deps, load } = setup({
      failUpload: (path) =>
        r2Down && path.includes("foto-dos")
          ? new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true })
          : undefined,
    });

    await expectAppError(load(sheet([row(2)]), P001), "STORAGE_UNAVAILABLE");
    expect(deps.media.all().filter((media) => media.listingId !== null)).toHaveLength(1);

    r2Down = false;
    const { result } = await load(sheet([row(2)]), P001);

    expect(result.media).toMatchObject({ filesUploaded: 3, filesExisting: 1 });
    expect(deps.media.all().filter((media) => media.listingId !== null)).toHaveLength(4);
    const checksums = deps.media.all().map((media) => media.checksum);
    expect(new Set(checksums).size).toBe(checksums.length);
  });

  it("STORAGE_ERROR (credenciales) en una fila no es un problema del archivo: se propaga", async () => {
    const { load } = setup({
      failUpload: (path) =>
        path.includes("/listings/")
          ? new AppError("STORAGE_ERROR", "R2 rechazó la operación (403)")
          : undefined,
    });
    await expectAppError(load(sheet([row(2)]), P001), "STORAGE_ERROR");
  });
});

describe("ingestMedia · logo del corredor", () => {
  it("sube el logo a la carpeta de la marca y lo asigna; la segunda vez no lo resube", async () => {
    const { deps, load } = setup();

    await load(sheet([row(2)]), P001);

    const [broker] = deps.brokers.all();
    const logoPath = `brokers/${broker?.id}/brand/sha256-logo-marca.png`;
    expect(deps.storage.uploads[0]).toBe(logoPath);
    const logo = await deps.media.findByStoragePath(logoPath);
    expect(logo).toMatchObject({ listingId: null, kind: "image", mime: "image/png" });
    expect(broker?.logoMediaId).toBe(logo?.id);

    const uploads = deps.storage.uploads.length;
    await load(sheet([row(2)]), P001);
    expect(deps.storage.uploads).toHaveLength(uploads);
    expect(deps.brokers.all()[0]?.logoMediaId).toBe(logo?.id);
  });

  it.each<[string, Folders, string]>([
    ["no está en _marca", { P001: { files: [] }, _marca: { files: [] } }, "no está en _marca/"],
    [
      "no es una imagen válida",
      {
        P001: { files: [] },
        _marca: { skipped: [{ relPath: "_marca/logo.png", reason: "signature_mismatch" }] },
      },
      "el contenido no corresponde a la extensión",
    ],
    ["falta la carpeta _marca", { P001: { files: [] } }, 'No existe la carpeta de medios "_marca"'],
  ])("un logo que %s es advertencia del corredor", async (_, folders, message) => {
    const { deps, load } = setup();

    const { result } = await load(sheet([row(2)]), folders);

    expect(result.report.broker?.warnings.join(" | ")).toContain(message);
    expect(deps.brokers.all()[0]?.logoMediaId).toBeNull();
  });

  it("sin carpeta de medios, el logo pedido es advertencia", async () => {
    const { load } = setup();
    const { result } = await load(sheet([row(2)]), null);
    expect(result.report.broker?.warnings).toEqual([
      "logo «logo.png»: no se indicó una carpeta de medios",
    ]);
  });
});

describe("ingestMedia · dry_run", () => {
  it("no sube ni escribe nada, y el reporte dice lo que se subiría", async () => {
    const { deps, load } = setup();

    const { result, runId } = await load(sheet([row(2)]), P001, { dryRun: true });

    expect(deps.storage.uploads).toEqual([]);
    expect(deps.media.all()).toEqual([]);
    expect(deps.listings.all()).toEqual([]);
    expect(result.media).toEqual({
      filesUploaded: 4,
      filesExisting: 0,
      filesSkipped: 1,
      filesFailed: 0,
    });
    expect((await deps.importRuns.get(runId))?.report?.media).toEqual(result.media);
  });

  it("sobre un aviso existente, deduplica contra lo que ya tiene sin escribir", async () => {
    const { deps, load, listing } = setup();
    await load(sheet([row(2, { estado_carga: null })]), { P001: { files: [PHOTOS.foto1] } });
    const before = { uploads: deps.storage.uploads.length, media: deps.media.all() };

    const { result } = await load(sheet([row(2)]), P001, { dryRun: true });

    expect(result.media).toMatchObject({ filesUploaded: 3, filesExisting: 1 });
    expect(deps.storage.uploads).toHaveLength(before.uploads);
    expect(deps.media.all()).toEqual(before.media);
    expect(listing().status).toBe("draft");
  });
});

describe("ingestMedia · errores del run", () => {
  it("un run inexistente → IMPORT_RUN_NOT_FOUND", async () => {
    const { deps } = setup();
    await expectAppError(
      ingestMedia(deps, {
        runId: "run-nadie",
        imported: {
          brokerId: null,
          logoFile: null,
          rows: [],
          counts: { rowsTotal: 0, rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 },
          report: { headers: null, broker: null, rows: [] },
        },
        source: null,
      }),
      "IMPORT_RUN_NOT_FOUND",
    );
  });

  it("no modifica el reporte que devolvió importListings", async () => {
    const { load } = setup();
    const { imported, result } = await load(sheet([row(2)]), P001);
    expect(imported.report.media).toBeUndefined();
    expect(imported.report.rows[0]?.warnings).toEqual([]);
    expect(result.report.rows[0]?.warnings).not.toEqual([]);
  });
});
